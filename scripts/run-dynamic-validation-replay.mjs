#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const mode = process.argv[2] || '--verify-threshold';
const historical = spawnSync(process.env.BUN_BINARY || 'bun', [
  join(root, 'packages/main/src/tasks/story-aware-validation-historical-replay.ts'),
  '--plan-only',
], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const mutation = spawnSync(process.env.BUN_BINARY || 'bun', [
  join(root, 'packages/main/src/tasks/story-aware-validation-mutation-smoke.ts'),
], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const result = {
  status: historical.status ?? mutation.status,
  stdout: `${historical.stdout || ''}${mutation.stdout || ''}`,
  stderr: `${historical.stderr || ''}${mutation.stderr || ''}`,
};
const output = `${result.stdout || ''}${result.stderr || ''}`;
process.stdout.write(output);
if (result.status !== 0) process.exit(result.status || 1);
if (!output.includes('historical stories: ') || !output.includes('dynamic-validation mutation audit PASS')) {
  throw new Error('replay audit did not prove historical Story discovery plus mutation coverage');
}
if (mode === '--mutation=missing-evidence') {
  if (!output.includes('mutation guards:')) throw new Error('missing-evidence mutation guard did not run');
  process.stdout.write('enforcement threshold blocked\n');
} else {
  process.stdout.write('historical replay discovery threshold PASS\n');
}
