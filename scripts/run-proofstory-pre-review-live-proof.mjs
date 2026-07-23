#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

execFileSync('npm', ['--prefix', 'packages/main', 'run', 'build'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['ignore', 'ignore', 'inherit'],
});
execFileSync(process.execPath, ['packages/main/dist/tasks/proofstory-pre-review-check-smoke.js', '--live-proof'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});
