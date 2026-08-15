#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
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
// packages/main/dist while a main build rm's it, so the two must be mutually
// exclusive. The lock wraps the ENTIRE critical section (rm + tsc + write).
await withBuildLock(projectRoot, () => {
  try { verifyUtilsBuildBinding(projectRoot); return; } catch { /* still stale → rebuild */ }
  rmSync(join(packageRoot, 'dist'), { recursive: true, force: true });
  execFileSync(process.execPath, [tsc, '-p', join(packageRoot, 'tsconfig.json')], { cwd: projectRoot, stdio: 'inherit' });
  writeUtilsBuildBinding(projectRoot);
});
