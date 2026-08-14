#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBuildBinding } from './full-suite-build-binding.mjs';

// Serialize concurrent builds of the SAME packages/main tree. The `rm -rf dist` + tsc
// rebuild is not atomic: when two builds overlap, one's rmdir races the other's tsc
// writes and crashes with ENOTEMPTY/EBUSY, and two tsc runs can clobber each other's
// output. A per-tree filesystem mutex (atomic mkdir) makes overlapping invocations WAIT
// instead of race — the root `pretest` now fires this build on every `npm test`, and the
// review pipeline runs many builds in one shared worktree (B-fb7b F-011..F-014, the
// documented shared-worktree concurrency hazard). Retry budgets alone cannot outlast a
// full ~20-30s compile under contention; a lock can.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function withBuildLock(treeKey, fn) {
  const lockDir = join(tmpdir(), `lattice-build-main-${createHash('sha256').update(treeKey).digest('hex').slice(0, 16)}.lock`);
  const STALE_MS = 180_000;
  const WAIT_TIMEOUT_MS = 600_000;
  const waitStart = Date.now();
  for (;;) {
    try { mkdirSync(lockDir); break; }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Steal a lock abandoned by a crashed build.
      try { if (Date.now() - statSync(lockDir).mtimeMs > STALE_MS) { rmdirSync(lockDir); continue; } } catch { /* holder released it; retry */ }
      if (Date.now() - waitStart > WAIT_TIMEOUT_MS) throw new Error(`build-main: timed out after ${WAIT_TIMEOUT_MS}ms waiting for the dist build lock (${lockDir})`);
      sleepSync(250);
    }
  }
  try { return fn(); }
  finally { try { rmdirSync(lockDir); } catch { /* already gone */ } }
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(projectRoot, 'packages/main');
const tsc = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));
// Whole rm+tsc+binding section is the critical section: hold the per-tree lock across all
// three so no other build's rmdir/tsc can interleave. maxRetries/retryDelay is kept as a
// secondary guard against non-build contenders (macOS Spotlight/mdworker touching dist).
withBuildLock(packageRoot, () => {
  // dist is ignored build output. Removing it makes a successful standard build
  // prove every emitted file came from this invocation, not a prior checkout.
  rmSync(join(packageRoot, 'dist'), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  execFileSync(process.execPath, [tsc, '-p', join(packageRoot, 'tsconfig.json')], { cwd: projectRoot, stdio: 'inherit' });
  writeBuildBinding(projectRoot);
});
