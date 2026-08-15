#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyUtilsBuildBinding, writeUtilsBuildBinding } from './full-suite-build-binding.mjs';
import { withBuildLock } from './build-lock.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(projectRoot, 'packages/utils');
const tsc = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));

// FAST-PATH (no lock): the utils binding folds in packages/main/dist, so it
// verifies only when utils/src, its config, AND the main/dist it links against
// all match — content-bound skip, no rm, no rebuild, no lock.
try { verifyUtilsBuildBinding(projectRoot); process.exit(0); } catch { /* not verified → build under the lock */ }

// Same lock as packages/main (a single per-repo mutex): a utils build reads
// packages/main/dist while a main build swaps it, so the two must be mutually
// exclusive. The lock wraps the ENTIRE critical section (staging build + atomic
// swap + write), serializing BUILDERS; the atomic staging-swap (not an in-place rm)
// is what keeps the ~90 non-lock-holding dist readers from ever seeing a torn dist.
await withBuildLock(projectRoot, () => {
  try { verifyUtilsBuildBinding(projectRoot); return; } catch { /* still stale → rebuild */ }
  const dist = join(packageRoot, 'dist');
  const staging = join(packageRoot, 'dist.staging');
  const trash = join(packageRoot, `dist.trash-${process.pid}`);
  // ATOMIC-SWAP build (identical to build-main-with-binding.mjs): tsc emits over
  // seconds, so building in place (rm dist; tsc) exposes an absent/partial dist to
  // the non-lock-holding readers (bin/bootstrap-runner.js, in-repo dist imports)
  // → MODULE_NOT_FOUND. Build into a dist SIBLING (same filesystem → rename is
  // atomic) and promote by rename: a reader sees the old-complete or new-complete
  // dist. A fresh staging each build preserves the clean-build proof.
  rmSync(staging, { recursive: true, force: true });
  rmSync(trash, { recursive: true, force: true });
  execFileSync(process.execPath, [tsc, '-p', join(packageRoot, 'tsconfig.json'), '--outDir', staging], { cwd: projectRoot, stdio: 'inherit' });
  // Promote: evict old dist, then move staging into place. The only absent-dist
  // window is the single rename syscall between these two lines (microseconds vs
  // the seconds-long tsc emit); bin/bootstrap-runner.js retries across it while the
  // build lock is held. The ENOENT catch is the SOLE benign case (first build has
  // no prior dist); every other error surfaces. A bare existence probe is
  // deliberately avoided so the SKIP GATE stays content-bound (verifyUtilsBuildBinding).
  try { renameSync(dist, trash); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  renameSync(staging, dist);
  rmSync(trash, { recursive: true, force: true });
  // Manifest lands AFTER the code is fully in place (readers import code, not the
  // manifest), so this ordering never exposes MODULE_NOT_FOUND.
  writeUtilsBuildBinding(projectRoot);
});
