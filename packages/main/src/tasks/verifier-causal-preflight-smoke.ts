#!/usr/bin/env node
/**
 * B-5a15 CHK-004: execute the verifier-owned causal-preflight test through
 * Node's test runner from the documented post-build entrypoint.
 *
 * Run: node packages/main/dist/tasks/verifier-causal-preflight-smoke.js
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const testFile = 'packages/main/tests/verifier-causal-preflight.test.mjs';

const result = spawnSync(process.execPath, ['--test', testFile], {
  cwd: repositoryRoot,
  stdio: 'inherit',
});

if (result.status === 0) {
  console.log('verifier-causal-preflight-smoke: PASS');
} else {
  if (result.error) {
    console.error(`verifier-causal-preflight-smoke: unable to start Node test runner: ${result.error.message}`);
  } else if (result.signal) {
    console.error(`verifier-causal-preflight-smoke: test runner terminated by ${result.signal}`);
  }
  process.exitCode = result.status ?? 1;
}
