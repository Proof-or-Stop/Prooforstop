#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tasksDir = dirname(fileURLToPath(import.meta.url));
const suitePath = fileURLToPath(import.meta.url);
const childSmokes = [
  'agent-dispatch-registry-smoke.js',
  'review-pass-discard-smoke.js',
  'flow-stability-smoke.js',
  'init-check-required-agents-smoke.js',
  'provider-codex-smoke.js',
  'cross-host-review-smoke.js',
  'repair-retry-loop-smoke.js',
] as const;

function assertAcyclicSuiteComposition(): void {
  for (const childName of childSmokes) {
    const childSource = readFileSync(join(tasksDir, childName), 'utf8');
    if (childSource.includes('agent-liveness-suite-smoke.js')) {
      throw new Error(`agent-liveness-suite-smoke child must not import its aggregate: ${childName}`);
    }
  }
}

function runChildSmoke(childName: typeof childSmokes[number]): Promise<void> {
  const childPath = join(tasksDir, childName);
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [childPath], {
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', rejectChild);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolveChild();
        return;
      }
      rejectChild(new Error(
        `agent-liveness-suite-smoke child failed: ${childName} (${signal ? `signal ${signal}` : `exit ${String(code)}`})`,
      ));
    });
  });
}

export async function runAgentLivenessSuite(): Promise<void> {
  assertAcyclicSuiteComposition();
  const results = await Promise.allSettled(childSmokes.map(runChildSmoke));
  const failures = results.flatMap((result, index) => result.status === 'rejected'
    ? [new Error(`${childSmokes[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)]
    : []);
  if (failures.length > 0) {
    throw new AggregateError(failures, `agent-liveness-suite-smoke failed ${failures.length} child smoke(s)`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === suitePath) {
  await runAgentLivenessSuite();
  console.log('agent-liveness-suite-smoke PASS');
}
