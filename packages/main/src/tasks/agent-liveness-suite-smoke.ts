#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tasksDir = dirname(fileURLToPath(import.meta.url));
const childSmokes = [
  'agent-dispatch-registry-smoke.js',
  'review-pass-discard-smoke.js',
  'flow-stability-smoke.js',
  'init-check-required-agents-smoke.js',
  'provider-codex-smoke.js',
  'cross-host-review-smoke.js',
  'repair-retry-loop-smoke.js',
] as const;

for (const childName of childSmokes) {
  const childPath = join(tasksDir, childName);
  try {
    execFileSync(process.execPath, [childPath], { stdio: 'inherit' });
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'status' in error
      ? String(error.status)
      : 'unknown';
    throw new Error(`agent-liveness-suite-smoke child failed: ${childName} (exit ${status})`, { cause: error });
  }
}

console.log('agent-liveness-suite-smoke PASS');
