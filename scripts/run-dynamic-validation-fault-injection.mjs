#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const result = spawnSync(process.env.BUN_BINARY || 'bun', [
  join(root, 'packages/main/src/tasks/story-aware-validation-mutation-smoke.ts'),
], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const output = `${result.stdout || ''}${result.stderr || ''}`;
process.stdout.write(output);
if (result.status !== 0) process.exit(result.status || 1);
for (const selector of ['FI-1', 'FI-2', 'FI-3', 'FI-4', 'FI-5']) {
  if (!output.includes(selector)) throw new Error(`fault injection selector missing: ${selector}`);
}
if (!output.includes('dynamic-validation mutation audit PASS')) throw new Error('fault audit did not pass');
process.stdout.write('fault injection matrix PASS\n');
