#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyUtilsBuildBinding, writeUtilsBuildBinding } from './full-suite-build-binding.mjs';
import { withBuildLock } from './build-lock.mjs';
import { promoteDist } from './promote-dist.mjs';

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
