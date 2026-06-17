/**
 * B-000c CHK-001: Experience Layer Phase 1a — the minimal learning-store.
 *
 * The ONLY code that touches `.lattice/learning/`. It ensures the directory,
 * resolves paths, and reads/writes the finding-signals cache with an atomic
 * write (temp file + rename) and a stable/canonical key order so re-writing
 * identical data is byte-identical (idempotent on disk; never a spurious diff).
 *
 * Isolation bar: imports ONLY `node:` builtins and the leaf
 * `./experience-layer-types.js`. NO outward imports (no `../`, no `../../`).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { FindingSignalsCache } from './experience-layer-types.js';

/** Relative learning directory from the project root. */
export const LEARNING_DIR = join('.lattice', 'learning');
/** Derived finding-signals cache filename. */
export const FINDING_SIGNALS_FILENAME = 'finding-signals.json';
/** Append-only learning log filename (reserved; written by future phases). */
export const LEARNING_LOG_FILENAME = 'learning-log.jsonl';

/** Absolute learning directory under a project root. */
export function resolveLearningDir(projectRoot: string): string {
  return join(projectRoot, LEARNING_DIR);
}

/** Absolute path of the finding-signals cache under a project root. */
export function resolveFindingSignalsPath(projectRoot: string): string {
  return join(resolveLearningDir(projectRoot), FINDING_SIGNALS_FILENAME);
}

/** Absolute path of the learning log under a project root. */
export function resolveLearningLogPath(projectRoot: string): string {
  return join(resolveLearningDir(projectRoot), LEARNING_LOG_FILENAME);
}

/** Idempotently create `.lattice/learning/`. Returns the absolute directory. */
export function ensureLearningDir(projectRoot: string): string {
  const dir = resolveLearningDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Canonical JSON serialization for the cache: keys sorted recursively,
 * `undefined` omitted, JSON `null` preserved. Self-contained (no outward import)
 * so re-writing identical data yields byte-identical output regardless of key
 * insertion order.
 */
function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) continue;
      out[key] = canonicalize(child);
    }
    return out;
  }
  return value;
}

/**
 * Read the finding-signals cache. Returns `null` when the file is absent (fresh
 * project) or when its contents are malformed JSON — graceful degradation: a
 * hand-edited or truncated cache never crashes the process or corrupts state.
 */
export function readFindingSignals(projectRoot: string): FindingSignalsCache | null {
  const filePath = resolveFindingSignalsPath(projectRoot);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as FindingSignalsCache;
  } catch {
    return null;
  }
}

/**
 * Atomically write the finding-signals cache. Auto-creates the learning
 * directory, writes a temp file, validates it parses, then renames into place
 * (atomic replace). Canonical key order makes identical data byte-identical on
 * re-write. A failed write leaves the prior cache untouched and removes the temp.
 */
export function writeFindingSignals(projectRoot: string, cache: FindingSignalsCache): string {
  const filePath = resolveFindingSignalsPath(projectRoot);
  const serialized = `${JSON.stringify(canonicalize(cache), null, 2)}\n`;
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(tmpPath, serialized, 'utf8');
    JSON.parse(readFileSync(tmpPath, 'utf8')); // post-write validation
    renameSync(tmpPath, filePath); // atomic replace
  } catch (err) {
    try { rmSync(tmpPath, { force: true }); } catch { /* best-effort cleanup */ }
    throw err;
  }
  return filePath;
}
