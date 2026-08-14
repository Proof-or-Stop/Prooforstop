#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBuildLock } from './build-lock.mjs';
import { writeBuildBinding } from './full-suite-build-binding.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(projectRoot, 'packages/main');
const tsc = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));
// Hold the shared per-repo build lock across the whole rm+tsc+binding critical section so no
// other build's rmdir/tsc — and no packages/utils tsc reading packages/main/dist — can interleave
// (B-fb7b F-011..F-015). maxRetries/retryDelay is a secondary guard against non-build contenders
// (macOS Spotlight/mdworker touching dist).
withBuildLock(projectRoot, () => {
  // dist is ignored build output. Removing it makes a successful standard build
  // prove every emitted file came from this invocation, not a prior checkout.
  rmSync(join(packageRoot, 'dist'), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  execFileSync(process.execPath, [tsc, '-p', join(packageRoot, 'tsconfig.json')], { cwd: projectRoot, stdio: 'inherit' });
  writeBuildBinding(projectRoot);
});
