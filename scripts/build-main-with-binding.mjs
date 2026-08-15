#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyBuildBinding, writeBuildBinding } from './full-suite-build-binding.mjs';
import { withBuildLock } from './build-lock.mjs';
import { promoteDist, recoverOrphanedPromotion } from './promote-dist.mjs';

// tsc runs as an AWAITED ASYNC child (D2), NOT execFileSync: a synchronous compile BLOCKS the Node event
// loop for the whole ~15s+ emit, so proper-lockfile's heartbeat (setInterval, 10s) cannot fire and a
// build longer than the 30s stale threshold has its LIVE lock reclaimed by another builder — reopening
// the B-fb7b live-holder age-steal. An async child keeps the loop free so the heartbeat keeps firing.
const execFileAsync = promisify(execFile);

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(projectRoot, 'packages/main');
const tsc = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));

// D3 SELF-HEAL (before deciding anything): a promotion killed BETWEEN promote-dist's two renames leaves
// dist absent + an orphaned dist.trash-* sibling that no in-process catch recovers. Restore it up front
// so dist is never absent longer than until this build. Gated on build-lock freshness so it never
// disturbs a concurrent LIVE build (which owns its dist.staging/dist.trash-<pid>). The residual window
// between a mid-promotion crash and this next build/bootstrap is the same versioned-pointer follow-up as
// the C2(b) microsecond gap.
recoverOrphanedPromotion(packageRoot, projectRoot);

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
await withBuildLock(projectRoot, async () => {
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
  // AWAITED ASYNC tsc (D2): the event loop stays free so the proper-lockfile heartbeat keeps refreshing
  // the lock during the seconds-long compile (a live long-running build is never age-stolen). On failure
  // the rejected promise propagates out of withBuildLock — whose finally still releases the lock — so the
  // script exits non-zero; we surface tsc's buffered diagnostics first so the failure stays actionable.
  try {
    await execFileAsync(process.execPath, [tsc, '-p', join(packageRoot, 'tsconfig.json'), '--outDir', staging], { cwd: projectRoot, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  }
  // Promote crash-safely (C2): promoteDist evicts the old dist → trash, moves staging
  // → dist, and RESTORES the old dist from trash if the second rename fails, so a
  // mid-promotion crash never leaves dist absent. The atomic rename shrinks the
  // absent-dist window from the seconds-long tsc emit to a SINGLE rename syscall
  // (microseconds). bin/lattice.js readers close even that microsecond gap via the
  // build-lock wait in bin/bootstrap-runner.js (it waits out the whole build). Direct
  // (non-bootstrap) dist consumers retain an astronomically-small residual — fully
  // closing it needs a cross-platform versioned pointer / directory junction, which is
  // cross-platform-risky (Windows junction rename semantics) and is tracked as a
  // follow-up (C2b), NOT implemented here.
  promoteDist(dist, staging, trash);
  // Manifest lands AFTER the code is fully in place. Readers import code, not the
  // manifest, so this ordering never exposes MODULE_NOT_FOUND; a concurrent fast-
  // path verify that briefly sees no manifest simply fails closed to a lock wait.
  writeBuildBinding(projectRoot);
});
