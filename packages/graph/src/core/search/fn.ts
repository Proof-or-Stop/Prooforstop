/**
 * SQLite FTS5 index over story text, keyed on a content signature.
 *
 * The signature deliberately excludes heartbeat files (owner-lease.json and friends):
 * they are rewritten every few seconds, and including them rebuilt the whole 23k-row
 * index continuously, adding ~2.5s to requests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SearchHit, Resolved } from '../data.js';
import { HEAVY_FILES, DEFAULTS } from '../machine.js';
import { resolveStories, readArtifact, readJson, readText, readJsonl, contentHash } from '../store/fn.js';

const SKIP = new Set<string>([...HEAVY_FILES, 'findings.json', 'checklist.json', 'index.json']);

/** Collect human-readable strings, skipping hash/signature noise. */
function strings(node: unknown, out: string[], depth = 0): void {
  if (depth > 7 || node == null) return;
  if (typeof node === 'string') { if (node.length > 2) out.push(node); return }
  if (typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const v of node) strings(v, out, depth + 1); return }
  for (const [k, v] of Object.entries(node)) {
    if (/hash|digest|signature|publicKey/i.test(k)) continue;
    strings(v, out, depth + 1);
  }
}

export interface BuildResult { readonly rows: number; readonly ms: number }

/**
 * Build the index to a private temp file, then atomically rename it into place.
 *
 * The cache path is derived from the repo root alone, so every process
 * inspecting one repo shares a single `index.db`. The build used to unlink that
 * shared file and recreate it in place, which meant a second process starting a
 * build would pull the file out from under a running server: the server kept
 * serving from a deleted handle while the newcomer queried a half-populated
 * FTS table. That surfaced as `audit` reporting "path query returned nothing"
 * against an index the live server was answering correctly.
 *
 * Renaming is atomic within a directory, so readers see either the whole old
 * index or the whole new one, never a partial build. The temp name carries the
 * pid so concurrent builders cannot collide.
 */
export function buildIndex(root: string, dbPath: string, sig?: string): BuildResult {
  const t0 = Date.now();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.build-${process.pid}`;
  // Named tmpPath rather than `f` for readability at the write site. (An earlier lexical
  // write guard REQUIRED this spelling; that rule is gone -- the guard now measures where
  // writes actually land -- so the name is a convention, not a contract.)
  for (const tmpPath of [tmp, `${tmp}-wal`, `${tmp}-shm`])
    if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });
  const db = new DatabaseSync(tmp);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE VIRTUAL TABLE ft USING fts5(storyId UNINDEXED, kind UNINDEXED, ref UNINDEXED,
      label, body, tokenize='unicode61 remove_diacritics 2');
  `);
  const S: Resolved = resolveStories(root);
  const ins = db.prepare('INSERT INTO ft(storyId,kind,ref,label,body) VALUES (?,?,?,?,?)');
  db.exec('BEGIN');
  let rows = 0;

  for (const sid of Object.keys(S.primary)) {
    const i = readArtifact<Record<string, unknown>>(S, sid, 'index.json') ?? {};
    ins.run(sid, 'story', sid, `${sid} ${String(i.title ?? '')}`,
      [i.title, i.description, Array.isArray(i.keywords) ? i.keywords.join(' ') : '']
        .filter(Boolean).join('\n'));
    rows++;

    const rawF = readArtifact<unknown>(S, sid, 'findings.json');
    const findings = (Array.isArray(rawF) ? rawF : (rawF as { findings?: unknown[] } | null)?.findings ?? []) as Record<string, unknown>[];
    for (const f of findings) {
      ins.run(sid, 'finding', String(f.id ?? ''),
        `${String(f.id ?? '')} ${String(f.severity ?? '')} ${String(f.status ?? '')} ${String(f.agent ?? '')}`,
        [f.desc, f.resolvedReason, Array.isArray(f.files) ? f.files.join(' ') : '']
          .filter(Boolean).join('\n'));
      rows++;
    }

    const chk = readArtifact<{ items?: Record<string, any>[] }>(S, sid, 'checklist.json') ?? {};
    for (const it of chk.items ?? []) {
      const fileList = Object.values(it.files ?? {}).flat().filter(Boolean) as string[];
      ins.run(sid, 'item', String(it.id ?? ''), `${String(it.id ?? '')} ${String(it.title ?? '')}`,
        [it.title, it.context, it.userSees, (it.relatedDocs ?? []).join(' '), fileList.join(' ')]
          .filter(Boolean).join('\n'));
      rows++;
      for (const [lane, arr] of Object.entries(it.verificationIntent ?? {})) {
        if (!Array.isArray(arr)) continue;
        arr.forEach((e: any, k: number) => {
          if (!e || typeof e !== 'object') return;
          ins.run(sid, 'intent', String(e.id ?? `${it.id}:${lane}:${k}`),
            `${lane} ${String(e.type ?? '')} ${String(e.priority ?? '')}`, String(e.desc ?? ''));
          rows++;
        });
      }
      for (const e of (it.verificationEvidence ?? []) as any[]) {
        ins.run(sid, 'evidence', String(e.intentRef ?? it.id ?? ''),
          `${String(e.kind ?? '')} ${String(e.result ?? '')}`,
          [e.command, e.file, e.note, e.receipt?.outputTail].filter(Boolean).join('\n'));
        rows++;
      }
    }

    // remaining artifacts: index readable strings + paths
    for (const d of [S.primary[sid], ...(S.extra[sid] ?? [])]) {
      let names: string[];
      try { names = fs.readdirSync(d) } catch { continue }
      for (const f of names) {
        if (SKIP.has(f)) continue;
        const p = path.join(d, f);
        let st: fs.Stats;
        try { st = fs.statSync(p) } catch { continue }
        if (!st.isFile() || st.size > DEFAULTS.maxIndexBytes) continue;
        if (f.endsWith('.md')) { ins.run(sid, 'doc', f, f, readText(p)); rows++; continue }
        const out: string[] = [];
        if (f.endsWith('.jsonl')) for (const r of readJsonl(p)) strings(r, out);
        else strings(readJson(p), out);
        if (out.length) { ins.run(sid, 'artifact', f, f, out.join('\n')); rows++ }
      }
    }
  }

  const set = db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)');
  set.run('contentHash', sig ?? contentHash(root));
  set.run('builtAt', new Date().toISOString());
  set.run('rows', String(rows));
  db.exec('COMMIT');
  db.exec("INSERT INTO ft(ft) VALUES('optimize')");
  db.close();
  // Fold the WAL into the main file before publishing, so the renamed db is
  // self-contained and readers never depend on a -wal we are about to discard.
  try {
    const seal = new DatabaseSync(tmp);
    seal.exec('PRAGMA journal_mode=DELETE');
    seal.close();
  } catch { /* WAL fold is best-effort; the rename below is what matters */ }
  fs.renameSync(tmp, dbPath);
  for (const tmpPath of [`${tmp}-wal`, `${tmp}-shm`])
    if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });
  return { rows, ms: Date.now() - t0 };
}

export interface OpenedIndex {
  readonly db: DatabaseSync;
  readonly rebuilt: boolean;
  readonly why: string;
  readonly built: BuildResult | null;
  readonly contentHash: string;
}

export function openIndex(root: string, dbPath: string, sig?: string): OpenedIndex {
  const cur = sig ?? contentHash(root);
  let need = !fs.existsSync(dbPath);
  let why = need ? 'missing' : '';
  if (!need) {
    try {
      const probe = new DatabaseSync(dbPath, { readOnly: true });
      const r = probe.prepare('SELECT v FROM meta WHERE k=?').get('contentHash') as { v?: string } | undefined;
      probe.close();
      if (!r || r.v !== cur) { need = true; why = 'content changed' }
    } catch { need = true; why = 'unreadable' }
  }
  const built = need ? buildIndex(root, dbPath, cur) : null;
  return { db: new DatabaseSync(dbPath, { readOnly: true }), rebuilt: need, why, built, contentHash: cur };
}

/**
 * Search. A term containing path separators is matched segment-wise, so a near-miss
 * like `package/main` still resolves `packages/main`. Story rows rank above their
 * own artifacts so searching an id surfaces the story itself first.
 */
export function search(db: DatabaseSync, q: string, limit: number = DEFAULTS.searchLimit): SearchHit[] {
  // A negative or absurd limit must not stream the whole index back.
  const cap = Number.isFinite(limit) && limit > 0
    ? Math.min(Math.floor(limit), DEFAULTS.maxSearchLimit)
    : DEFAULTS.searchLimit;
  // Bound the query: an unbounded AND-chain of terms is pointless work and lets a
  // pathological input dominate the server.
  const terms = (q ?? '').trim().slice(0, DEFAULTS.maxQueryChars)
    .split(/\s+/).map(t => t.replace(/["*]/g, '')).filter(Boolean)
    .slice(0, DEFAULTS.maxQueryTerms);
  if (!terms.length) return [];
  const expr = terms.map(t => {
    const parts = t.split(/[/.\-_]+/).filter(x => x.length > 1);
    return parts.length > 1 ? `(${parts.map(p => `"${p}"*`).join(' AND ')})` : `"${t}"*`;
  }).join(' AND ');
  try {
    // Ranking strategy. Ordering the whole match set by a CASE expression costs
    // ~28ms on top of bm25 (39ms vs 11ms for a 10k-row match). Instead run two
    // bounded bm25 queries — stories, then everything else — and concatenate.
    // snippet() is applied only to the surviving rows: it costs 56ms over a full
    // match set but 0.2ms over 20 rows.
    const rankSql = (kindClause: string) => `
      SELECT rowid, bm25(ft) AS score
      FROM ft WHERE ft MATCH ?${kindClause} ORDER BY score LIMIT ?`;

    let storyRows = db.prepare(rankSql(" AND kind='story'")).all(expr, cap) as unknown as
      { rowid: number; score: number }[];

    /* An id the reader typed outranks bm25.

       Searching "45a0" put B-45a5 above B-45a0, because bm25 scores the whole
       label+body and B-45a5's prose simply matched better. But a query that IS
       an id (or its hex suffix) is a navigation request, not a text search --
       the reader wants that story, first. So pull any story whose id contains
       the raw query to the front, preserving bm25 order among the rest. */
    if (storyRows.length > 1) {
      const needle = q.trim().toLowerCase().replace(/^b-/, '');
      if (needle.length >= 3) {
        const ids = db.prepare(
          `SELECT rowid, storyId FROM ft WHERE rowid IN (${storyRows.map(() => '?').join(',')})`)
          .all(...storyRows.map(r => r.rowid)) as unknown as { rowid: number; storyId: string }[];
        const exact = new Set(ids
          .filter(r => String(r.storyId).toLowerCase().replace(/^b-/, '') === needle)
          .map(r => r.rowid));
        if (exact.size) {
          storyRows = [...storyRows.filter(r => exact.has(r.rowid)),
                       ...storyRows.filter(r => !exact.has(r.rowid))];
        }
      }
    }
    const rest = storyRows.length >= cap ? [] :
      (db.prepare(rankSql(" AND kind!='story'")).all(expr, cap - storyRows.length) as unknown as
        { rowid: number; score: number }[]);

    const ranked = [...storyRows, ...rest];
    if (!ranked.length) return [];

    const order = new Map(ranked.map((r, i) => [r.rowid, i]));
    const ph = ranked.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT rowid, storyId, kind, ref, label,
             snippet(ft,4,'<mark>','</mark>','…',12) AS snip
      FROM ft WHERE rowid IN (${ph})`).all(...ranked.map(r => r.rowid)) as unknown as
      (SearchHit & { rowid: number })[];

    rows.sort((a, b) => (order.get(a.rowid) ?? 0) - (order.get(b.rowid) ?? 0));
    return rows.map(({ rowid, ...rest }) => rest as SearchHit);
  } catch { return [] }
}
