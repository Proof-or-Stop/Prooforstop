#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const build = spawnSync('npm', ['--prefix', 'packages/main', 'run', 'build'], { cwd: root, encoding: 'utf8' });
if (build.status !== 0) {
  process.stdout.write(build.stdout || '');
  process.stderr.write(build.stderr || '');
  process.exit(build.status ?? 1);
}
const smoke = spawnSync(process.execPath, ['packages/main/dist/tasks/external-worktree-go-pre-review-smoke.js'], { cwd: root, encoding: 'utf8' });
process.stdout.write(smoke.stdout || '');
process.stderr.write(smoke.stderr || '');
process.exit(smoke.status ?? 1);
