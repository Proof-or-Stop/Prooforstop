#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDistFresh, withBuildLock } from './build-lock.mjs';
import { writeBuildBinding } from './full-suite-build-binding.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(projectRoot, 'packages/main');
const tsc = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));
// `--ensure` = idempotent bootstrap: build only when dist is missing/stale. The root
// `pretest` uses it so a repeated `npm test` on an already-current dist does NOT rm+rebuild
// (which would race a concurrent invocation's full suite reading dist — B-fb7b Codex
// MAJOR-2). The default (no flag) always does the full rm+rebuild+binding purity proof.
const ensureOnly = process.argv.includes('--ensure');
const distDir = join(packageRoot, 'dist');
const sourceInputs = [join(packageRoot, 'src'), join(packageRoot, 'tsconfig.json'), join(packageRoot, 'package.json')];

// Hold the shared per-repo build lock across the whole freshness-check + rm+tsc+binding
// critical section so no other build's rmdir/tsc — and no packages/utils tsc reading
// packages/main/dist — can interleave (B-fb7b F-011..F-015). The freshness check runs
// INSIDE the lock so a concurrent builder that just produced a current dist is observed.
withBuildLock(projectRoot, () => {
  if (ensureOnly && isDistFresh(distDir, sourceInputs)) return; // dist already current — do not touch it
  // dist is ignored build output. Removing it makes a successful standard build
  // prove every emitted file came from this invocation, not a prior checkout.
  rmSync(distDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  execFileSync(process.execPath, [tsc, '-p', join(packageRoot, 'tsconfig.json')], { cwd: projectRoot, stdio: 'inherit' });
  writeBuildBinding(projectRoot);
});
