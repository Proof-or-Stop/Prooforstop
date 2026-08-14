#!/usr/bin/env node
// Minimal pretest bootstrap for `npm test` (B-fb7b): ensure packages/main then packages/utils
// `dist` EXIST before the full suite runs, so a worktree without packages/utils/dist does not die
// in bootstrap-runner.js ("Missing build artifacts: .../packages/utils/dist/index.js").
//
// Deliberately EXISTENCE-BASED: it builds a package only when its dist is absent, and NEVER
// rm+rebuilds a present dist. That means a repeated `npm test` cannot destroy a dist that a
// concurrent invocation's full suite is still reading. Freshness (rebuild on a source change) is
// owned by the `packages-main-build` validate proof, which rm+rebuilds from source; within a
// worktree the build output is at a fixed HEAD, so an already-present dist is the correct one to
// reuse for the bootstrap.
//
// Crash-safe concurrent-build mutual exclusion and content-bound freshness for the shared-worktree
// review pipeline are intentionally OUT of scope here (an independent Codex review showed a
// hand-rolled mkdir mutex + mtime heuristic is a real infrastructure problem, not a reactive
// patch); they are tracked in a dedicated follow-up story.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function ensure(pkg) {
  if (existsSync(join(root, 'packages', pkg, 'dist', 'index.js'))) return; // already bootstrapped
  execFileSync('npm', ['--prefix', join('packages', pkg), 'run', 'build'], { cwd: root, stdio: 'inherit' });
}

ensure('main');  // packages/utils tsc links against packages/main/dist, so main must exist first
ensure('utils');
