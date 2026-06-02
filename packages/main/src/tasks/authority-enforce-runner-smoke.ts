#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAuthorityEnforceRunnerPlan, buildAuthorityStatus } from '../handlers/lattice-cli.js';

const PASS_LINE =
  '✓ authority enforce runner smoke passed: dry-run planned register/heartbeat/claim without provider execution';

const configuredEnv = {
  KOALA_AUTHORITY_MODE: 'enforce',
  KOALA_AUTHORITY_URL: 'https://authority.test',
  KOALA_AUTHORITY_ACTOR_KEY: 'test-actor-key',
  KOALA_AUTHORITY_RUNNER_ID: 'runner-1',
};

{
  const plan = buildAuthorityEnforceRunnerPlan({ once: true, dryRun: true }, configuredEnv);
  assert.equal(plan.schemaVersion, 'lattice.authority_enforce_runner.v1');
  assert.equal(plan.status, 'pass');
  assert.equal(plan.once, true);
  assert.equal(plan.dryRun, true);
  assert.deepEqual(plan.plannedSteps, ['register_runner', 'runner_heartbeat', 'claim_job']);
  assert.equal(plan.spawned, false);
  assert.deepEqual(plan.providerEvents, []);
  assert.equal(plan.readinessWarnings.length, 0);
}

{
  const missing = buildAuthorityEnforceRunnerPlan({ once: true, dryRun: true }, {
    KOALA_AUTHORITY_MODE: 'enforce',
  });
  assert.equal(missing.status, 'fail');
  assert.equal(missing.localWorkflowUsable, true);
  assert.equal(missing.spawned, false);
  assert.deepEqual(missing.providerEvents, []);
  assert.equal(missing.readinessWarnings.length, 3);
  assert(missing.nextActions.some(action => action.includes('KOALA_AUTHORITY_URL')));
}

{
  const status = buildAuthorityStatus({}, {});
  assert.equal(status.localWorkflowUsable, true);
  assert.equal(status.productionDone, false);
  assert.equal(status.receiptVerified, false);
  assert(!('plannedSteps' in status), 'ordinary authority_status must not project runner steps');
}

{
  const taskDir = dirname(fileURLToPath(import.meta.url));
  const cliPath = join(taskDir, '..', 'cli.js');
  const repoRoot = join(taskDir, '..', '..', '..', '..');
  const out = execFileSync(
    process.execPath,
    [cliPath, '--root', '.', 'lattice', 'authority', 'enforce', 'runner', '--once', '--dry-run', '--json'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, ...configuredEnv },
    },
  );
  const parsed = JSON.parse(out) as { plannedSteps?: string[]; spawned?: boolean; providerEvents?: unknown[] };
  assert.deepEqual(parsed.plannedSteps, ['register_runner', 'runner_heartbeat', 'claim_job']);
  assert.equal(parsed.spawned, false);
  assert.deepEqual(parsed.providerEvents, []);
}

console.log(PASS_LINE);
