#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyUtilsBuildBinding, writeUtilsBuildBinding } from './full-suite-build-binding.mjs';
import { withBuildLock } from './build-lock.mjs';
import { promoteDist } from './promote-dist.mjs';

// tsc runs as an AWAITED ASYNC child (D2), NOT execFileSync: a synchronous compile BLOCKS the Node event
// loop for the whole ~15s+ emit, so proper-lockfile's heartbeat (setInterval, 10s) cannot fire and a
// build longer than the 30s stale threshold has its LIVE lock reclaimed by another builder — reopening
// the B-fb7b live-holder age-steal. An async child keeps the loop free so the heartbeat keeps firing.
const execFileAsync = promisify(execFile);

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(projectRoot, 'packages/utils');
const tsc = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));

// NO PRE-LOCK FAST-PATH (C1): unlike build-main-with-binding.mjs, the utils binding
// folds in an EXTERNAL mutable input — packages/main/dist — which a concurrent MAIN
// build is free to swap while holding the shared lock. A pre-lock verify could read
// the still-visible OLD main/dist, pass "fresh", and exit; the main build then swaps
// in NEW main/dist, leaving the utils binding stale — so the two builds would NOT be
// mutually exclusive. Instead we ALWAYS take the shared lock first and rely on the
// double-check verify INSIDE it, where the lock guarantees main/dist is stable (no
// main build is mid-swap). (build-main keeps its pre-lock fast-path safely because
// its binding is self-contained: main src + main dist only, no external mutable input.)

// Same lock as packages/main: a utils build reads packages/main/dist while a main build
// swaps it, so the two must be mutually exclusive. Since B-bcae withBuildLock is a pair of
// per-repo targets — buildLockTarget, which serializes builders against each other and is
// what every build-in-progress observer reads, and, nested inside it, the reader-admission
// target bin/bootstrap-runner.js takes before its initial dist import. The pair wraps the
// ENTIRE critical section (staging build + atomic swap + write), so a bin/proof-or-stop.js
// startup waits here rather than importing mid-promotion. Dist readers that take no lock
// at all (in-repo direct dist imports) are still not excluded; for those the atomic
// staging-swap (not an in-place rm) is what keeps them from ever seeing a torn dist.
await withBuildLock(projectRoot, async () => {
  try { verifyUtilsBuildBinding(projectRoot); return; } catch { /* still stale → rebuild */ }
  const dist = join(packageRoot, 'dist');
  const staging = join(packageRoot, 'dist.staging');
  const trash = join(packageRoot, `dist.trash-${process.pid}`);
  // ATOMIC-SWAP build (identical to build-main-with-binding.mjs): tsc emits over
  // seconds, so building in place (rm dist; tsc) exposes an absent/partial dist to
  // readers this section does NOT hold a target against — in-repo direct dist imports;
  // bin/bootstrap-runner.js is no longer among them, since B-bcae it takes the
  // reader-admission target nested in this lock → MODULE_NOT_FOUND for the rest.
  // Build into a dist SIBLING (same filesystem → rename is
  // atomic) and promote by rename: a reader sees the old-complete or new-complete
  // dist. A fresh staging each build preserves the clean-build proof.
  //
  // In-lock orphan tidy (identical to build-main-with-binding.mjs): the held lock excludes every OTHER
  // builder, so any dist.staging / dist.trash-* siblings present now are prior-crash debris. Sweep them
  // all — safe precisely BECAUSE it is inside the held-lock section (the cross-process orphan recovery
  // that swept these WITHOUT the lock was reverted; B-1734).
  for (const name of readdirSync(packageRoot)) {
    if (/^dist\.(staging|trash-)/.test(name)) rmSync(join(packageRoot, name), { recursive: true, force: true });
  }
  // AWAITED ASYNC tsc (D2, identical to build-main-with-binding.mjs): the event loop stays free so the
  // proper-lockfile heartbeat keeps refreshing the lock during the seconds-long compile (a live build is
  // never age-stolen). On failure the rejected promise propagates out of withBuildLock — whose finally
  // still releases the lock — so the script exits non-zero; surface tsc's diagnostics first.
  try {
    await execFileAsync(process.execPath, [tsc, '-p', join(packageRoot, 'tsconfig.json'), '--outDir', staging], { cwd: projectRoot, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  }
  // Promote crash-safely (C2, shared with build-main-with-binding.mjs): promoteDist
  // evicts the old dist → trash, moves staging → dist, and RESTORES the old dist from
  // trash if the second rename fails, so a mid-promotion crash never leaves dist absent.
  // The atomic rename shrinks the absent-dist window to a single rename syscall
  // (microseconds vs the seconds-long tsc emit); bin/bootstrap-runner.js waits across it
  // while the build lock is held.
  promoteDist(dist, staging, trash);
  // Manifest lands AFTER the code is fully in place (readers import code, not the
  // manifest), so this ordering never exposes MODULE_NOT_FOUND.
  writeUtilsBuildBinding(projectRoot);
});
