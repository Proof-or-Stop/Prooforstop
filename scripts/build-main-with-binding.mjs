#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
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

// The mutex wraps the ENTIRE critical section (rm + tsc + writeBuildBinding). rm
// is INSIDE the lock so a concurrent reader never sees a half-removed dist, and
// writeBuildBinding is INSIDE it so a concurrent verify never reads a torn binding.
await withBuildLock(projectRoot, () => {
  // DOUBLE-CHECK under the lock: a concurrent builder may have produced a fresh
  // dist while we waited, in which case skip the rm+rebuild.
  try { verifyBuildBinding(projectRoot); return; } catch { /* still stale → rebuild */ }
  // dist is ignored build output. Removing it makes a successful standard build
  // prove every emitted file came from this invocation, not a prior checkout.
  rmSync(join(packageRoot, 'dist'), { recursive: true, force: true });
  execFileSync(process.execPath, [tsc, '-p', join(packageRoot, 'tsconfig.json')], { cwd: projectRoot, stdio: 'inherit' });
  writeBuildBinding(projectRoot);
});
