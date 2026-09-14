#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

// The ordinary Lab default is 900 seconds. Children share that allowance;
// their own existing workload budgets remain authoritative.
const started = performance.now();
const deadline = started + 900000;
for (const [args, selector] of [
  [['scripts/verify-proof-or-stop-identity-cutover.mjs'], 'PASS identity-cutover'],
  [['scripts/verify-reviewed-source-bindings.mjs'], 'PASS reviewed identity final-head closure:'],
]) {
  const remaining = Math.floor(deadline - performance.now());
  assert(remaining > 0, 'IDENTITY_CURRENT_WITNESS_DEADLINE');
  const childStart = performance.now();
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(), encoding: 'utf8', timeout: remaining,
    maxBuffer: 32 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  console.log('IDENTITY_CURRENT_WITNESS_CHILD', JSON.stringify({ args,
    durationMs: performance.now() - childStart, status: result.status,
    signal: result.signal, error: result.error?.message }));
  assert(!result.error && result.signal === null && result.status === 0
    && result.stdout.includes(selector), 'IDENTITY_CURRENT_WITNESS_REQUIRED_COMMAND_FAILED');
}
console.log('PASS identity current witness coverage: unchanged default scanner and actual final-head consumers');
