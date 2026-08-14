#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBuildLock } from './build-lock.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(projectRoot, 'packages/utils');
const tsc = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));
// packages/utils tsc imports from packages/main/dist/*. Take the same shared per-repo build
// lock as the main build so utils never compiles against a packages/main/dist that a concurrent
// main rebuild is mid-rewrite — that race surfaces as TS2307 "Cannot find module
// '../../main/dist/...'" under shared-worktree concurrency (B-fb7b F-015).
withBuildLock(projectRoot, () => {
  execFileSync(process.execPath, [tsc, '-p', join(packageRoot, 'tsconfig.json')], { cwd: packageRoot, stdio: 'inherit' });
});
