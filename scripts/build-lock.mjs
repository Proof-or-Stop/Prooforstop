// Shared build mutex. The packages/main build does `rm -rf dist` + tsc, and the
// packages/utils build's tsc reads packages/main/dist directly (via ../../main/dist/*
// imports). When those overlap across concurrent invocations in one worktree — the root
// `pretest` fires them on every `npm test`, and the review pipeline runs many builds in
// one shared worktree — a main rebuild mid-rmdir/tsc corrupts what a sibling process's
// rm or utils-tsc is touching, surfacing as ENOTEMPTY/EBUSY or TS2307 "Cannot find
// module '../../main/dist/...'". Both builds take this same per-repo lock so they SERIALIZE
// instead of racing (B-fb7b F-011..F-015; the documented shared-worktree concurrency
// hazard). Isolated single-process usage is unaffected. Deterministic per-invocation
// dist purity is preserved: each holder still does a full rm+tsc while it owns the lock.
import { createHash } from 'node:crypto';
import { mkdirSync, rmdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding an exclusive filesystem lock keyed by `repoKey`. Concurrent
 * callers wait (with a stale-lock steal for a crashed holder) rather than racing.
 */
export function withBuildLock(repoKey, fn) {
  const lockDir = join(tmpdir(), `lattice-build-${createHash('sha256').update(repoKey).digest('hex').slice(0, 16)}.lock`);
  const STALE_MS = 300_000;
  const WAIT_TIMEOUT_MS = 900_000;
  const waitStart = Date.now();
  for (;;) {
    try { mkdirSync(lockDir); break; }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try { if (Date.now() - statSync(lockDir).mtimeMs > STALE_MS) { rmdirSync(lockDir); continue; } } catch { /* released; retry */ }
      if (Date.now() - waitStart > WAIT_TIMEOUT_MS) throw new Error(`build-lock: timed out after ${WAIT_TIMEOUT_MS}ms waiting for ${lockDir}`);
      sleepSync(200);
    }
  }
  try { return fn(); }
  finally { try { rmdirSync(lockDir); } catch { /* already gone */ } }
}
