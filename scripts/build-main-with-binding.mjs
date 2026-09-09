#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { chmodSync, cpSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyBuildBinding, writeBuildBinding } from './full-suite-build-binding.mjs';
import { withBuildLock } from './build-lock.mjs';
import { promoteDist } from './promote-dist.mjs';

// tsc runs as an AWAITED ASYNC child (D2), NOT execFileSync: a synchronous compile BLOCKS the Node event
// loop for the whole ~15s+ emit, so proper-lockfile's heartbeat (setInterval, 10s) cannot fire and a
// build longer than the 30s stale threshold has its LIVE lock reclaimed by another builder — reopening
// the B-fb7b live-holder age-steal. An async child keeps the loop free so the heartbeat keeps firing.
const execFileAsync = promisify(execFile);

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(projectRoot, 'packages/main');
const tsc = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));

// FAST-PATH (no lock): the binding is the content-hash purity check — sha256 over
// all src+config and all dist. If it verifies, dist content-matches source, so
// there is nothing to rebuild and no reason to take the lock (or rm anything).
// Content-bound skip makes rebuilds rare, which closes the rm-during-read window.
try { verifyBuildBinding(projectRoot); process.exit(0); } catch { /* not verified → build under the lock */ }

// The mutex wraps the ENTIRE critical section (staging build + atomic swap +
// writeBuildBinding), serializing concurrent BUILDERS. Since B-bcae withBuildLock takes
// TWO targets — buildLockTarget, which is what serializes builders and what every
// build-in-progress observer reads, and, nested inside it, distImportLockTarget, the
// READER-ADMISSION target bin/bootstrap-runner.js acquires before its initial dist
// import. So this section DOES gate that reader: a bin/proof-or-stop.js startup waits
// here instead of importing mid-promotion. It still does not gate dist readers that take
// no lock at all (in-repo direct dist imports), and for those the atomic staging-swap
// below (not an in-place rm) remains what keeps them from seeing a half-removed dist.
// writeBuildBinding is INSIDE the lock so a concurrent verify never reads a torn binding.
await withBuildLock(projectRoot, async () => {
  // DOUBLE-CHECK under the lock: a concurrent builder may have produced a fresh
  // dist while we waited, in which case skip the rebuild.
  try { verifyBuildBinding(projectRoot); return; } catch { /* still stale → rebuild */ }
  const dist = join(packageRoot, 'dist');
  const staging = join(packageRoot, 'dist.staging');
  const trash = join(packageRoot, `dist.trash-${process.pid}`);
  // ATOMIC-SWAP build: tsc emits over seconds. Doing it in place (rm dist; tsc)
  // leaves dist absent/partial for that whole window; the build lock excludes only
  // lock-takers. Since B-bcae bin/bootstrap-runner.js IS one of those on every
  // bin/proof-or-stop.js call — it takes the reader-admission target this section also
  // holds — but dist readers that take no lock at all (in-repo direct dist imports)
  // still are not excluded, and would hit MODULE_NOT_FOUND in that window.
  // Build into a dist SIBLING (same filesystem → rename is atomic)
  // and promote by rename: a reader sees the old-complete or new-complete dist. A
  // fresh staging each build preserves the clean-build proof (every emitted file
  // came from this tsc invocation).
  //
  // In-lock orphan tidy: the held lock excludes every OTHER builder, so any dist.staging /
  // dist.trash-* siblings present now are prior-crash debris (no live builder owns them). Sweep them all
  // so a mid-promotion crash's stranded siblings don't accumulate. This is safe precisely BECAUSE it is
  // inside the held-lock section — the cross-process orphan recovery that swept these WITHOUT the lock
  // was reverted (it could delete a concurrent live builder's staging; B-1734). Any real crash-restore of
  // dist itself is left to promoteDist's in-process catch plus the next full rebuild (see promote-dist.mjs).
  for (const name of readdirSync(packageRoot)) {
    if (/^dist\.(staging|trash-)/.test(name)) rmSync(join(packageRoot, name), { recursive: true, force: true });
  }
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
  // tsc emits TypeScript but does not copy the executable DYN-5 adapter/case
  // registry assets.  Promote those source-owned assets alongside the JS
  // output so a clean rebuild cannot leave the production shard path pointing
  // at missing dist/tasks/*.mjs or *.json files.
  for (const directory of ['core', 'tasks']) {
    const sourceAssets = join(packageRoot, 'src', directory);
    const stagingAssets = join(staging, directory);
    for (const name of readdirSync(sourceAssets)) {
      if (!/\.(?:m?js|cjs|json)$/.test(name)) continue;
      cpSync(join(sourceAssets, name), join(stagingAssets, name));
    }
  }
  // npm `bin` shims execute dist/cli.js directly. tsc emits regular 0644 files,
  // so make the staged CLI executable before the atomic promotion; otherwise a
  // freshly built linked/global install regresses to EACCES until manual chmod.
  chmodSync(join(staging, 'cli.js'), 0o755);
  // Promote crash-safely (C2): promoteDist evicts the old dist → trash, moves staging
  // → dist, and RESTORES the old dist from trash if the second rename fails, so a
  // mid-promotion crash never leaves dist absent. The atomic rename shrinks the
  // absent-dist window from the seconds-long tsc emit to a SINGLE rename syscall
  // (microseconds). bin/proofOrStop.js readers close even that microsecond gap via the
  // build-lock wait in bin/bootstrap-runner.js (it waits out the whole build). Direct
  // (non-bootstrap) dist consumers retain an astronomically-small residual — fully
  // closing it needs a cross-platform versioned pointer / directory junction, which is
  // cross-platform-risky (Windows junction rename semantics) and is tracked as a
  // follow-up (C2b), NOT implemented here.
  promoteDist(dist, staging, trash);
  // Manifest lands AFTER the code is fully in place. Readers import code, not the
  // manifest, so this ordering never exposes MODULE_NOT_FOUND; a concurrent fast-
  // path verify that briefly sees no manifest simply fails closed to a lock wait.
  //
  // KNOWN LIMITATION / FOLLOW-UP (B-1734, deferred to a build-concurrency infra story). writeBuildBinding
  // re-reads every src file to hash it, but tsc already read those files earlier in this same build. If a
  // source file is edited AFTER tsc reads it but BEFORE this hashing, the manifest pairs the NEW source
  // digest with output compiled from the OLD source — a stale-but-"verifying" dist. This binding-vs-source
  // TOCTOU is inherent to editing source mid-build; the mutex serializes builders but cannot freeze an
  // external editor, so it is out of scope here and tracked for the same follow-up.
  writeBuildBinding(projectRoot);
});
