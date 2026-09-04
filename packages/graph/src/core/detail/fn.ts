/** Full-fidelity detail for one story: every file, verbatim, no truncation. */
import fs from 'node:fs';
import path from 'node:path';
import type { StoryDetail, StoryFile } from '../data.js';
import { HEAVY_FILES } from '../machine.js';
import { resolveStories, readJson, readText, readJsonl } from '../store/fn.js';

const HEAVY = new Set<string>(HEAVY_FILES);

/**
 * Per-row audit trails that exist for provenance, not for display. They dominate
 * some story payloads (617KB of readManifest in one review-passes.json) while the
 * UI only ever shows a count, so they are dropped unless the file is fetched raw.
 */
const BULKY_ROW_FIELDS = ['readManifest', 'readLog', 'readDiagnostics', 'assembledPrompt'] as const;

/** Files whose rows carry those trails. */
const TRIMMABLE = new Set(['review-passes.json', 'review-inventory-epochs.json',
  'acceptance-rollout-report.json']);

/**
 * Whole-file provenance blobs: a single top-level field holding raw captured
 * stdout, kept for audit, never rendered. `test-evidence.json` embeds the full
 * validate transcript in `output` -- 6.9MB of the 7.0MB file on B-45a0, which
 * alone pushed that story's detail to 10.8MB and tripped the 8MB audit cap in
 * src/tasks/audit.ts, failing `npm run check` for EVERY story in the repo. The
 * web shell reads only `command`, `result`, and `verificationCoverage` from
 * this file (shells/web/app.js:86,119), so the transcript costs bytes on every
 * detail fetch and buys nothing. Dropped unless the file is fetched raw.
 */
const BULKY_FILE_FIELDS: Record<string, readonly string[]> = {
  'test-evidence.json': ['output'],
  'done-required-evidence.json': ['output'],
};

function dropBulkyFields(value: unknown, fields: readonly string[]): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const obj = { ...(value as Record<string, unknown>) };
  for (const f of fields) if (f in obj) delete obj[f];
  return obj;
}

function trimRows(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (!Array.isArray(v)) continue;
    obj[key] = v.map(row => {
      if (!row || typeof row !== 'object') return row;
      const r = { ...(row as Record<string, unknown>) };
      for (const f of BULKY_ROW_FIELDS) if (f in r) delete r[f];
      return r;
    });
  }
  return obj;
}

/**
 * Fields dropped from process events on the wire.
 *
 * This is a DENY list, deliberately, not an allow list. An allow list silently
 * hides any field it has not heard of, and that is exactly how the REVIEW->DEV
 * bounce on B-137a became unexplainable in the UI: `importedIds` (the batch of
 * findings a reviewer filed, used by 101 of 134 reviewer_finding events in this
 * repo) was simply not on the list, so the timeline rendered a review that had
 * raised 2 critical + 3 high findings as having raised none. 122 distinct real
 * fields were being dropped the same way.
 *
 * So: everything ships, except the per-row provenance blobs below, which are
 * megabyte-scale, are never displayed, and are still reachable via `?raw=`.
 */
const EVENT_DROP = new Set<string>([...BULKY_ROW_FIELDS,
  'dispatchPrompt', 'promptEnvelope', 'assembledPrompt', 'checkSnapshot']);

function slimEvents(rows: readonly unknown[]): unknown[] {
  return rows.map(r => {
    if (!r || typeof r !== 'object') return r;
    const src = r as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src)) if (!EVENT_DROP.has(k)) out[k] = src[k];
    return out;
  });
}

export interface DetailOptions { readonly raw?: string }

/**
 * Summarise a huge digest file WITHOUT reading it whole.
 *
 * `prompt-envelopes.json` reaches 72MB and `review-runs.json` 31MB in this repo;
 * reading + parsing + re-serialising them cost ~420ms per story detail while the UI
 * only ever shows a count, the key set, and three sample rows. We read a bounded
 * head, recover the first complete row by brace matching, and estimate the count
 * from a byte scan instead.
 */
function summariseHeavy(p: string, bytes: number): StoryFile {
  const HEAD = 256 * 1024;
  let head = '';
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.allocUnsafe(Math.min(HEAD, bytes));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.subarray(0, n).toString('utf8');
  } catch { return { kind: 'summary', bytes, count: 0, sample: [], keys: [] } }

  // first complete object inside the top-level array
  const sample: unknown[] = [];
  let keys: string[] = [];
  const start = head.indexOf('{', head.indexOf('['));
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false, from = start;
    for (let i = start; i < head.length && sample.length < 3; i++) {
      const c = head[i]!;
      if (esc) { esc = false; continue }
      if (c === '\\') { esc = true; continue }
      if (c === '"') { inStr = !inStr; continue }
      if (inStr) continue;
      if (c === '{') { if (depth === 0) from = i; depth++ }
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try {
            const row = JSON.parse(head.slice(from, i + 1)) as Record<string, unknown>;
            sample.push(row);
            if (!keys.length) keys = Object.keys(row);
          } catch { /* truncated tail — stop sampling */ }
        }
      }
    }
  }
  // estimate rows from average sampled size rather than parsing the whole file
  let count = 0;
  if (sample.length) {
    const avg = JSON.stringify(sample[0]).length;
    count = avg > 0 ? Math.max(1, Math.round(bytes / avg)) : 0;
  }
  return { kind: 'summary', bytes, count, sample, keys, estimated: true };
}

export function storyDetail(root: string, sid: string, opts: DetailOptions = {}): StoryDetail | null {
  const S = resolveStories(root);
  const dirs = [S.primary[sid], ...(S.extra[sid] ?? [])].filter(Boolean) as string[];
  if (!dirs.length) return null;

  const files: Record<string, StoryFile> = {};
  const seen = new Set<string>();
  for (const d of dirs) {
    let names: string[];
    try { names = fs.readdirSync(d) } catch { continue }
    for (const f of names) {
      if (seen.has(f)) continue;
      const p = path.join(d, f);
      let st: fs.Stats;
      try { st = fs.statSync(p) } catch { continue }
      seen.add(f);
      if (st.isDirectory()) {
        try { files[f] = { kind: 'dir', entries: fs.readdirSync(p).slice(0, 200) } } catch { /* ignore */ }
        continue;
      }
      if (HEAVY.has(f)) {
        files[f] = summariseHeavy(p, st.size);
      } else if (f.endsWith('.jsonl')) {
        const rows = readJsonl(p);
        // Large append-only logs are slimmed unless this file was explicitly requested.
        const slim = f === 'process-events.jsonl' && opts.raw !== f && st.size > 200_000;
        files[f] = slim
          ? { kind: 'jsonl', bytes: st.size, count: rows.length, rows: slimEvents(rows) }
          : { kind: 'jsonl', bytes: st.size, rows };
      }
      else if (f.endsWith('.json')) {
        const trim = TRIMMABLE.has(f) && opts.raw !== f && st.size > 100_000;
        const bulky = BULKY_FILE_FIELDS[f];
        const data = readJson(p);
        const shaped = trim ? trimRows(data)
          : (bulky && opts.raw !== f) ? dropBulkyFields(data, bulky)
          : data;
        files[f] = { kind: 'json', bytes: st.size, data: shaped };
      }
      else files[f] = { kind: 'text', bytes: st.size, text: readText(p) };
    }
  }
  return {
    storyId: sid,
    dir: path.relative(root, S.primary[sid]),
    worktree: S.wt[sid] ? path.relative(root, S.wt[sid]) : null,
    alsoIn: (S.extra[sid] ?? []).map(d => path.relative(root, d)),
    files,
    readAt: new Date().toISOString(),
  };
}
