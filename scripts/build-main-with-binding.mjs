#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBuildBinding, writeBuildBinding } from './full-suite-build-binding.mjs';
import { withBuildLock } from './build-lock.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(projectRoot, 'packages/main');
const tsc = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));

// FAST-PATH (no lock): the binding is the content-hash purity check — sha256 over
// all src+config and all dist. If it verifies, dist content-matches source, so
// there is nothing to rebuild and no reason to take the lock (or rm anything).
// Content-bound skip makes rebuilds rare, which closes the rm-during-read window.
try { verifyBuildBinding(projectRoot); process.exit(0); } catch { /* not verified → build under the lock */ }

// The mutex wraps the ENTIRE critical section (staging build + atomic swap +
// writeBuildBinding), serializing concurrent BUILDERS. It does NOT gate the ~90
// non-lock-holding dist READERS, so the atomic staging-swap below (not an in-place
// rm) is what keeps a reader from ever seeing a half-removed dist; writeBuildBinding
// is INSIDE the lock so a concurrent verify never reads a torn binding.
await withBuildLock(projectRoot, () => {
  // DOUBLE-CHECK under the lock: a concurrent builder may have produced a fresh
  // dist while we waited, in which case skip the rebuild.
  try { verifyBuildBinding(projectRoot); return; } catch { /* still stale → rebuild */ }
  const dist = join(packageRoot, 'dist');
  const staging = join(packageRoot, 'dist.staging');
  const trash = join(packageRoot, `dist.trash-${process.pid}`);
  // ATOMIC-SWAP build: tsc emits over seconds. Doing it in place (rm dist; tsc)
  // leaves dist absent/partial for that whole window; the build lock excludes only
  // other lock-takers, NOT the ~90 non-lock-holding dist readers (bin/bootstrap-
  // runner.js on every bin/lattice.js call, in-repo dist imports), which then hit
  // MODULE_NOT_FOUND. Build into a dist SIBLING (same filesystem → rename is atomic)
  // and promote by rename: a reader sees the old-complete or new-complete dist. A
  // fresh staging each build preserves the clean-build proof (every emitted file
  // came from this tsc invocation).
  rmSync(staging, { recursive: true, force: true });
  rmSync(trash, { recursive: true, force: true });
  execFileSync(process.execPath, [tsc, '-p', join(packageRoot, 'tsconfig.json'), '--outDir', staging], { cwd: projectRoot, stdio: 'inherit' });
  // Promote: evict old dist, then move staging into place. The only window where
  // dist is absent is the single rename syscall between these two lines
  // (microseconds vs the seconds-long tsc emit); bin/bootstrap-runner.js retries
  // across it while the build lock is held. The ENOENT catch is the SOLE benign
  // case — a first build has no prior dist to evict; every other error (EACCES,
  // EXDEV, …) surfaces. A bare existence probe is deliberately avoided so the SKIP
  // GATE stays content-bound (verifyBuildBinding), never existence-based.
  try { renameSync(dist, trash); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  renameSync(staging, dist);
  rmSync(trash, { recursive: true, force: true });
  // Manifest lands AFTER the code is fully in place. Readers import code, not the
  // manifest, so this ordering never exposes MODULE_NOT_FOUND; a concurrent fast-
  // path verify that briefly sees no manifest simply fails closed to a lock wait.
  writeBuildBinding(projectRoot);
});
