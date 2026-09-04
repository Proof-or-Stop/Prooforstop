/**
 * Story-directory resolution and change signatures.
 *
 * Worktree precedence is load-bearing: per the Proof-or-Stop workflow, from PLAN
 * onward a story's live artifacts live in its linked worktree, while the main
 * checkout keeps only the INIT_CHECK snapshot. Reading the main checkout alone
 * reports every in-flight story as INIT_CHECK with ~2 events.
 *
 * Performance: a naive implementation re-ran `git worktree list` (25ms) and walked
 * ~8k files (25ms) on every call, and every request path called it three times
 * (contentHash + liveHash + the operation itself). Everything here is therefore
 * built from ONE cached directory scan.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { Resolved } from '../data.js';
import { STORY_ROOTS, LIVE_FILES, DEFAULTS } from '../machine.js';

const LIVE = new Set<string>(LIVE_FILES);

export function readJson<T = unknown>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T } catch { return null }
}
export function readText(p: string): string {
  try { return fs.readFileSync(p, 'utf8') } catch { return '' }
}
export function readJsonl<T = unknown>(p: string): T[] {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) as T } catch { return null } })
      .filter((x): x is T => x !== null);
  } catch { return [] }
}

/** One file's identity for change detection. */
interface FileStat { readonly name: string; readonly size: number; readonly mtime: number }
/** A complete scan: directory layout + per-file stats, gathered once. */
export interface Scan {
  readonly resolved: Resolved;
  /** storyId -> dir -> files in that dir */
  readonly files: ReadonlyMap<string, ReadonlyMap<string, readonly FileStat[]>>;
  readonly contentHash: string;
  readonly liveHash: string;
  /** storyId -> signature of that story's own files; enables incremental rebuilds. */
  readonly perStory: ReadonlyMap<string, string>;
  readonly at: number;
}

let cachedWorktrees: { at: number; list: string[] } | null = null;

/** `git worktree list` costs ~25ms; worktrees change rarely, so cache briefly. */
function listWorktrees(root: string): string[] {
  const now = Date.now();
  if (cachedWorktrees && now - cachedWorktrees.at < DEFAULTS.worktreeTtlMs) return cachedWorktrees.list;
  let list: string[] = [];
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'],
      { cwd: root, encoding: 'utf8', timeout: 20_000 });
    list = out.split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9)).slice(1);
  } catch { list = [] }
  cachedWorktrees = { at: now, list };
  return list;
}

/** Scan every story directory ONCE, producing layout + both signatures together. */
function scan(root: string): Scan {
  const primary: Record<string, string> = {};
  const extra: Record<string, string[]> = {};
  const wt: Record<string, string> = {};

  // 1. worktrees first — they hold the live state
  for (const w of listWorktrees(root)) {
    const sid = path.basename(w.replace(/\/+$/, ''));
    for (const r of STORY_ROOTS) {
      const cand = path.join(w, r, sid);
      if (fs.existsSync(path.join(cand, 'index.json'))) { primary[sid] = cand; wt[sid] = w; break }
    }
  }
  // 2. main checkout — adds stories with no worktree; fallback for the rest
  for (const r of STORY_ROOTS) {
    const base = path.join(root, r);
    let names: string[];
    try { names = fs.readdirSync(base).sort() } catch { continue }
    for (const sid of names) {
      const d = path.join(base, sid);
      const hasIndex = fs.existsSync(path.join(d, 'index.json'));
      if (!primary[sid]) {
        if (hasIndex) primary[sid] = d;
        else (extra[sid] ??= []).push(d);   // lease-only dirs still carry live state
      } else if (path.resolve(d) !== path.resolve(primary[sid])) {
        (extra[sid] ??= []).push(d);
      }
    }
  }

  // 3. one stat pass; build BOTH signatures from the same data
  const files = new Map<string, Map<string, FileStat[]>>();
  const perStory = new Map<string, string>();
  const ch = crypto.createHash('sha256');
  const lh = crypto.createHash('sha256');
  for (const sid of Object.keys(primary).sort()) {
    const perDir = new Map<string, FileStat[]>();
    const sh = crypto.createHash('sha256');
    for (const d of [primary[sid], ...(extra[sid] ?? [])]) {
      let names: fs.Dirent[];
      try { names = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
      const list: FileStat[] = [];
      for (const de of names.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (!de.isFile()) continue;
        let st: fs.Stats;
        try { st = fs.statSync(path.join(d, de.name)) } catch { continue }
        const f: FileStat = { name: de.name, size: st.size, mtime: Math.floor(st.mtimeMs) };
        list.push(f);
        const line = `${sid}/${de.name}:${f.size}:${f.mtime}\n`;
        sh.update(line);
        if (LIVE.has(de.name)) lh.update(line); else ch.update(line);
      }
      perDir.set(d, list);
    }
    files.set(sid, perDir);
    perStory.set(sid, sh.digest('hex'));
  }
  return {
    resolved: { primary, extra, wt },
    files,
    contentHash: ch.digest('hex'),
    liveHash: lh.digest('hex'),
    perStory,
    at: Date.now(),
  };
}

let cachedScan: { root: string; scan: Scan } | null = null;

/** Cached scan. Re-scans only after the throttle window. */
export function getScan(root: string, maxAgeMs = DEFAULTS.statThrottleMs): Scan {
  if (cachedScan && cachedScan.root === root && Date.now() - cachedScan.scan.at < maxAgeMs)
    return cachedScan.scan;
  const s = scan(root);
  cachedScan = { root, scan: s };
  return s;
}

/** Force a fresh scan (used by explicit refresh paths). */
export function invalidateScan(): void { cachedScan = null; cachedWorktrees = null }

export function resolveStories(root: string): Resolved { return getScan(root).resolved }
export const contentHash = (root: string): string => getScan(root).contentHash;
export const liveHash = (root: string): string => getScan(root).liveHash;

/** Read an artifact from the live dir, falling back to any duplicate dir. */
export function readArtifact<T = unknown>(
  S: Resolved, sid: string, name: string, kind: 'json' | 'jsonl' | 'text' = 'json',
): T | null {
  const dirs = [S.primary[sid], ...(S.extra[sid] ?? [])].filter(Boolean) as string[];
  for (const d of dirs) {
    const p = path.join(d, name);
    if (!fs.existsSync(p)) continue;
    if (kind === 'jsonl') { const r = readJsonl(p); if (r.length) return r as unknown as T }
    else if (kind === 'text') { const t = readText(p); if (t) return t as unknown as T }
    else { const v = readJson<T>(p); if (v !== null) return v }
  }
  return kind === 'jsonl' ? ([] as unknown as T) : null;
}
