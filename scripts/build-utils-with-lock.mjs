#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDistFresh, withBuildLock } from './build-lock.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(projectRoot, 'packages/utils');
const tsc = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));
// `--ensure` = idempotent bootstrap: build only when dist is missing/stale, so a repeated
// pretest on a current dist does not rebuild (B-fb7b Codex MAJOR-2). packages/utils tsc
// also imports from packages/main/dist/*, so utils source freshness AND the main dist it
// links against both gate the skip.
const ensureOnly = process.argv.includes('--ensure');
const distDir = join(packageRoot, 'dist');
const sourceInputs = [
  join(packageRoot, 'src'),
  join(packageRoot, 'tsconfig.json'),
  join(packageRoot, 'package.json'),
  join(projectRoot, 'packages/main/dist'),
];
// packages/utils tsc imports from packages/main/dist/*. Take the same shared per-repo build
// lock as the main build so utils never compiles against a packages/main/dist that a concurrent
// main rebuild is mid-rewrite — that race surfaces as TS2307 "Cannot find module
// '../../main/dist/...'" under shared-worktree concurrency (B-fb7b F-015). The freshness check
// runs inside the lock so a just-completed sibling build is observed before we rebuild.
withBuildLock(projectRoot, () => {
  if (ensureOnly && isDistFresh(distDir, sourceInputs)) return; // dist already current — skip
  execFileSync(process.execPath, [tsc, '-p', join(packageRoot, 'tsconfig.json')], { cwd: packageRoot, stdio: 'inherit' });
});
