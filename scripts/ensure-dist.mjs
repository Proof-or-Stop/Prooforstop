#!/usr/bin/env node
// Pretest bootstrap for `npm test` (B-fb7b + B-1734): ensure packages/main then packages/utils
// `dist` exist AND are content-current before the full suite runs, so a worktree without a built
// dist does not die in bootstrap-runner.js ("Missing build artifacts: .../packages/utils/dist/index.js").
//
// CONTENT-BOUND + CROSS-PLATFORM MUTEX (no longer existence-based): this delegates to
// scripts/build-main-with-binding.mjs then scripts/build-utils-with-binding.mjs. Each script:
//   - SKIPS instantly when its verifyBuildBinding passes (sha256 over all src+config and all dist),
//     so a repeated `npm test` does no rm+rebuild and cannot destroy a dist a concurrent suite reads;
//   - rebuilds only on a genuine content change, and does so under a proper-lockfile mutex that wraps
//     the whole rm+tsc+write section — a live long-running build is never age-stolen, a dead holder is
//     reclaimed race-safely, and the two builds share one lock (utils reads the main/dist that a main
//     build rewrites, so they must be mutually exclusive).
// Main is built before utils because packages/utils tsc links against packages/main/dist.
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = script => execFileSync(process.execPath, [join(root, 'scripts', script)], { cwd: root, stdio: 'inherit' });

run('build-main-with-binding.mjs');   // packages/utils tsc links against packages/main/dist, so main first
run('build-utils-with-binding.mjs');
