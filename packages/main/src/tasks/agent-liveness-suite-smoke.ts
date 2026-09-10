#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sanitizedFixtureChildEnvironment } from './fixture-environment.js';

const tasksDir = dirname(fileURLToPath(import.meta.url));
const suitePath = fileURLToPath(import.meta.url);
const childMarker = 'PROOF_OR_STOP_AGENT_LIVENESS_SUITE_CHILD';
const childSmokes = [
  'agent-dispatch-registry-smoke.js',
  'review-pass-discard-smoke.js',
  'flow-stability-smoke.js',
  'init-check-required-agents-smoke.js',
  'provider-codex-smoke.js',
  'cross-host-review-smoke.js',
  'repair-retry-loop-smoke.js',
] as const;

export function agentLivenessSuiteChildEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...sanitizedFixtureChildEnvironment(environment), [childMarker]: '1' };
}

export function runAgentLivenessSuite(environment: NodeJS.ProcessEnv = process.env): void {
  for (const childName of childSmokes) {
    const childPath = join(tasksDir, childName);
    try {
      execFileSync(process.execPath, [childPath], {
        env: agentLivenessSuiteChildEnvironment(environment),
        stdio: 'inherit',
      });
    } catch (error) {
      const status = typeof error === 'object' && error !== null && 'status' in error
        ? String(error.status)
        : 'unknown';
      throw new Error(`agent-liveness-suite-smoke child failed: ${childName} (exit ${status})`, { cause: error });
    }
  }
}

export function runAgentLivenessSuiteForPinnedEvidence(environment: NodeJS.ProcessEnv = process.env): void {
  if (process.env[childMarker] === '1') return;
  runAgentLivenessSuite(environment);
  console.log('agent-liveness-suite-smoke PASS');
}

if (process.argv[1] && resolve(process.argv[1]) === suitePath) {
  runAgentLivenessSuite();
  console.log('agent-liveness-suite-smoke PASS');
}
