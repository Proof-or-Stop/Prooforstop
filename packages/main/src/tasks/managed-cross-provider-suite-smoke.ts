#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProviderLaunchOwnerAdmissionSuite } from './provider-launch-owner-admission-suite.js';
import {
  REVIEWER_DISPATCH_AUTHORITY_KEYS,
  childSmokeEnv,
} from './reviewer-dispatch-authority.js';

export { childSmokeEnv, withoutReviewerDispatchAuthority } from './reviewer-dispatch-authority.js';

const tasksDir = dirname(fileURLToPath(import.meta.url));
const suitePath = fileURLToPath(import.meta.url);
const childSmokes = [
  'managed-host-run-command-smoke.js',
  'managed-host-run-process-smoke.js',
  'managed-host-run-e2e-smoke.js',
  'managed-review-evidence-smoke.js',
  'proof-admissibility-registry-smoke.js',
  'candidate-spec-routing-smoke.js',
  'cross-host-review-smoke.js',
  'provider-codex-smoke.js',
] as const;

function assertNoReviewerDispatchAuthority(env: NodeJS.ProcessEnv, label: string): void {
  for (const key of REVIEWER_DISPATCH_AUTHORITY_KEYS) {
    assert.equal(
      env[key],
      undefined,
      `${label} must not inherit ${key}; host-owned fixture children stay host-owned`,
    );
  }
}

function assertChildSmokeEnvDropsReviewerDispatchAuthority(): void {
  const env = childSmokeEnv({
    ...process.env,
    PROOF_OR_STOP_AGENT: 'lattice-review-quality',
    PROOF_OR_STOP_ACTIVITY_ROLE: 'lattice-review-quality',
  });
  assertNoReviewerDispatchAuthority(env, 'childSmokeEnv');
  const observed = execFileSync(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify({agent: process.env.PROOF_OR_STOP_AGENT ?? null, role: process.env.PROOF_OR_STOP_ACTIVITY_ROLE ?? null}))'],
    { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.deepEqual(
    JSON.parse(observed),
    { agent: null, role: null },
    `suite child process inherited reviewer dispatch authority: ${observed}`,
  );
}

export function runManagedCrossProviderSuite(): void {
  runProviderLaunchOwnerAdmissionSuite();
  assertChildSmokeEnvDropsReviewerDispatchAuthority();
  const env = childSmokeEnv(process.env);
  assertNoReviewerDispatchAuthority(env, 'managed-cross-provider-suite child env');
  for (const childName of childSmokes) {
    try {
      execFileSync(process.execPath, [join(tasksDir, childName)], {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      console.log(`${childName} PASS`);
    } catch (error) {
      const status = typeof error === 'object' && error !== null && 'status' in error
        ? String(error.status)
        : 'unknown';
      const stdout = typeof error === 'object' && error !== null && 'stdout' in error ? String(error.stdout ?? '') : '';
      const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr ?? '') : '';
      const tail = `${stdout}\n${stderr}`.slice(-4_000);
      throw new Error(`managed-cross-provider-suite-smoke child failed: ${childName} (exit ${status})\n${tail}`, { cause: error });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === suitePath) {
  runManagedCrossProviderSuite();
  console.log('managed-cross-provider-suite-smoke PASS');
}
