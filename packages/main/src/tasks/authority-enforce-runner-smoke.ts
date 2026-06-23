#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { MAIN_TOOLS, parseFlags } from '../cli-engine.js';
import { buildAuthorityEnforceRunnerPlan, buildAuthorityStatus } from '../handlers/lattice-cli.js';
import { consumeClaimedAuthorityJob, parseClaimedAuthorityJob } from '../core/authority-runner.js';
import type { ClaimedAuthorityJob } from '../core/authority-runner.js';
import type { PlannerStoreLike } from '../core/planner.js';
import type { StoryInfo } from '../core/types.js';

const PASS_LINE =
  '✓ authority enforce runner smoke passed: dry-run planned register/heartbeat/claim without provider execution; claimed-job plannedSteps consumed through the bounded executor with authority DONE gated by a verified receipt';

// --- Claimed authority job consumption helpers -----------------------------

interface RecordingStore extends PlannerStoreLike {
  events: Array<Record<string, unknown>>;
}

function fakeStore(phase: StoryInfo['phase'] = 'DEV'): RecordingStore {
  const story = { storyId: 'B-auto', phase } as StoryInfo;
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    readStory: () => story,
    storyExists: (storyId: string) => storyId === 'B-auto',
    listStoryIds: () => ['B-auto'],
    appendProcessEvent: (_storyId, event) => { events.push(event); },
  };
}

let stepSeq = 0;
function step(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  stepSeq += 1;
  const provider = type === 'provider.fake' ? 'fake' : type === 'provider.codex' ? 'codex' : type === 'provider.claude' ? 'claude' : undefined;
  return {
    stepId: `step-${String(stepSeq).padStart(3, '0')}`,
    type,
    title: `bounded ${type}`,
    purpose: `exercise ${type} in a claimed authority job`,
    cwdPolicy: type === 'lattice.command' ? 'read-only' : 'story-worktree',
    timeoutMs: 60_000,
    maxAttempts: 1,
    requiresCleanWorktree: false,
    producesEvidence: true,
    blocksUntilEvidenceUploaded: false,
    evidenceBinding: `${type}-evidence`,
    args: { operation: type },
    ...(provider ? { provider } : {}),
    ...extra,
  };
}

const configuredEnv = {
  LATTICE_AUTHORITY_MODE: 'enforce',
  LATTICE_AUTHORITY_URL: 'https://authority.test',
  LATTICE_AUTHORITY_CUSTOMER_API_KEY: 'customer-key-canary',
  LATTICE_AUTHORITY_ACTOR_KEY: 'test-actor-key',
  LATTICE_AUTHORITY_RUNNER_ID: 'runner-1',
};

{
  const tool = MAIN_TOOLS.find(candidate => candidate.name === 'authority_enforce_runner');
  assert.ok(tool, 'MAIN_TOOLS exposes authority_enforce_runner');
  const parsed = parseFlags(
    ['--live', '--storyId=B-current', '--once', '--dry-run', '--json'],
    tool.schema,
  );
  const validated = z.object({
    ...tool.schema,
    takeover: z.boolean().optional(),
    forceTakeover: z.boolean().optional(),
  }).parse(parsed) as Record<string, unknown>;

  assert.equal(validated.live, true, 'CLI catalog/validator must preserve --live before handler dispatch');
  assert.equal(validated.storyId, 'B-current', 'CLI catalog/validator must preserve --storyId before handler dispatch');
  assert.equal(validated.once, true);
  assert.equal(validated.dryRun, true);
  assert.equal(validated.json, true);
}

{
  const plan = buildAuthorityEnforceRunnerPlan({ once: true, dryRun: true }, configuredEnv);
  assert.equal(plan.schemaVersion, 'lattice.authority_enforce_runner.v1');
  assert.equal(plan.status, 'pass');
  assert.equal(plan.once, true);
  assert.equal(plan.dryRun, true);
  assert.deepEqual(plan.plannedSteps, ['register_runner', 'runner_heartbeat', 'claim_job']);
  assert.equal(plan.spawned, false);
  assert.deepEqual(plan.providerEvents, []);
  assert.equal(plan.runnerProvider, 'codex');
  assert.equal(plan.runnerProviderValid, true);
  assert.equal(plan.runnerId, 'runner-1');
  assert.equal(plan.sessionIdSource, 'derived');
  assert.equal(plan.readinessWarnings.length, 0);
}

{
  const missing = buildAuthorityEnforceRunnerPlan({ once: true, dryRun: true }, {
    LATTICE_AUTHORITY_MODE: 'enforce',
  });
  assert.equal(missing.status, 'fail');
  assert.equal(missing.localWorkflowUsable, true);
  assert.equal(missing.spawned, false);
  assert.deepEqual(missing.providerEvents, []);
  assert.equal(missing.readinessWarnings.length, 2);
  assert.equal(missing.runnerIdSource, 'derived');
  assert.equal(missing.sessionIdSource, 'derived');
  assert(missing.nextActions.some(action => action.includes('LATTICE_AUTHORITY_CUSTOMER_API_KEY')));
}

{
  const alias = buildAuthorityEnforceRunnerPlan({ once: true, dryRun: true }, {
    ...configuredEnv,
    LATTICE_AUTHORITY_RUNNER_PROVIDER: 'claude',
  });
  assert.equal(alias.status, 'pass');
  assert.equal(alias.runnerProvider, 'claude-code', 'claude alias normalizes to claude-code');
  assert.equal(alias.runnerProviderSource, 'env');
  assert.deepEqual(alias.readinessWarnings, []);
}

{
  const custom = buildAuthorityEnforceRunnerPlan({ once: true, dryRun: true }, {
    ...configuredEnv,
    LATTICE_AUTHORITY_RUNNER_PROVIDER: 'antigravity',
  });
  assert.equal(custom.status, 'pass', 'custom runner provider declarations are accepted locally');
  assert.equal(custom.runnerProvider, 'antigravity');
  assert.equal(custom.runnerProviderValid, true);
  assert.equal(custom.runnerProviderInvalidValue, null);
  assert.deepEqual(custom.readinessWarnings, []);
}

{
  const liveMissingProject = buildAuthorityEnforceRunnerPlan({ once: true, live: true }, configuredEnv);
  assert.equal(liveMissingProject.status, 'fail');
  assert(liveMissingProject.readinessWarnings.some(warning => warning.includes('LATTICE_AUTHORITY_PROJECT_ID')));
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
    [cliPath, '--root', '.', 'lattice', 'authority', 'enforce', 'runner', '--once', '--dry-run', '--live', '--storyId=B-current', '--json'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, ...configuredEnv },
    },
  );
  const parsed = JSON.parse(out) as { plannedSteps?: string[]; spawned?: boolean; providerEvents?: unknown[]; live?: boolean };
  assert.deepEqual(parsed.plannedSteps, ['register_runner', 'runner_heartbeat', 'claim_job']);
  assert.equal(parsed.spawned, false);
  assert.deepEqual(parsed.providerEvents, []);
  assert.equal(parsed.live, true, 'real CLI alias path preserves --live through validation');
}

// --- Claimed authority job consumption -------------------------------------
// A claimed Authority job carrying typed plannedSteps[] is driven through the
// shared bounded executor. These checks pin the "beyond projection" seam without
// requiring a live Authority server.

{
  // Authority + DONE: the gate.evaluate step must block on a verified receipt,
  // so the job is released cleanly and never claims authority DONE.
  const store = fakeStore('DEV');
  const job: ClaimedAuthorityJob = {
    jobId: 'job-done-1',
    storyId: 'B-auto',
    mode: 'authority',
    until: 'DONE',
    plannedSteps: [
      step('lattice.command', { args: { operation: 'story.resolve' } }),
      step('provider.fake'),
      step('gate.evaluate'),
    ],
  };
  const result = consumeClaimedAuthorityJob({ root: '/tmp/lattice-claimed-job', store, job });
  assert.equal(result.schemaVersion, 'lattice.authority_job_consume.v1');
  assert.equal(result.receiptRequired, true, 'authority DONE requires a native gate_decision receipt');
  assert.equal(result.receiptVerified, false);
  assert.equal(result.authorityDone, false, 'no receipt was verified, so authority DONE must stay false');
  assert.equal(result.disposition, 'blocked', 'authority DONE without a receipt blocks at gate.evaluate');
  assert.equal(result.execution?.status, 'blocked');
  assert.equal(result.execution?.authorityDone, false, 'planned-steps executor must never mint authority DONE');
  assert(result.releaseReason.includes('authority_gate_decision_receipt_required'), 'release reason must surface the receipt requirement');
  assert(store.events.some(e => e.type === 'authority_job_consumed' && e.disposition === 'blocked'), 'consumption must emit an audit process event');
}

{
  // Defense in depth: even if a caller wrongly asserts receiptVerified=true, a
  // DONE job whose gate step blocks must not flip to authority DONE.
  const store = fakeStore('DEV');
  const job: ClaimedAuthorityJob = {
    jobId: 'job-done-spoof',
    storyId: 'B-auto',
    mode: 'authority',
    until: 'DONE',
    plannedSteps: [step('provider.fake'), step('gate.evaluate')],
  };
  const result = consumeClaimedAuthorityJob({ root: '/tmp/lattice-claimed-job', store, job, receiptVerified: true });
  assert.equal(result.authorityDone, false, 'a blocked gate must keep authority DONE false even when receiptVerified is spoofed true');
  assert.equal(result.disposition, 'blocked');
}

{
  // Authority + TEST: a non-DONE target needs no receipt, so an all-passing
  // bounded run completes cleanly without claiming production DONE.
  const store = fakeStore('DEV');
  const job: ClaimedAuthorityJob = {
    jobId: 'job-test-1',
    storyId: 'B-auto',
    mode: 'authority',
    until: 'TEST',
    plannedSteps: [
      step('lattice.command', { args: { operation: 'story.resolve' } }),
      step('provider.fake'),
      step('gate.evaluate'),
      step('stop.summary'),
    ],
  };
  const result = consumeClaimedAuthorityJob({ root: '/tmp/lattice-claimed-job', store, job });
  assert.equal(result.receiptRequired, false, 'a non-DONE authority target does not require a DONE receipt');
  assert.equal(result.disposition, 'completed', 'an all-passing non-DONE authority job completes');
  assert.equal(result.execution?.status, 'done');
  assert.equal(result.authorityDone, false, 'authority DONE is only for until=DONE with a verified receipt');
  assert.equal(result.releaseReason, 'authority-job-completed-no-receipt-required');
}

{
  // Invalid plannedSteps payloads block before any execution and release cleanly.
  const store = fakeStore('DEV');
  const job: ClaimedAuthorityJob = {
    jobId: 'job-invalid-1',
    storyId: 'B-auto',
    mode: 'authority',
    until: 'TEST',
    plannedSteps: [{ type: 'lattice.command' }],
  };
  const result = consumeClaimedAuthorityJob({ root: '/tmp/lattice-claimed-job', store, job });
  assert.equal(result.disposition, 'blocked');
  assert.equal(result.execution, null, 'invalid plannedSteps must not reach the executor');
  assert(result.releaseReason.startsWith('authority-job-invalid-planned-steps'), 'invalid payloads surface a clear release reason');
}

// --- Claimed job envelope parsing (CLI/live --jobFile entry point) ----------
// parseClaimedAuthorityJob validates the untrusted job envelope before it is
// handed to the executor. It must fail closed on any shape problem and leave
// deep plannedSteps[] validation to consumeClaimedAuthorityJob.

{
  const valid = parseClaimedAuthorityJob({
    jobId: 'job-file-1',
    storyId: 'B-auto',
    mode: 'authority',
    until: 'DONE',
    plannedSteps: [step('provider.fake')],
    developmentWorkflow: 'standard',
  });
  assert.equal(valid.ok, true, 'a well-formed job envelope must parse');
  if (valid.ok) {
    assert.equal(valid.job.jobId, 'job-file-1');
    assert.equal(valid.job.mode, 'authority');
    assert.equal(valid.job.until, 'DONE');
    assert.equal(valid.job.developmentWorkflow, 'standard');
  }
}

{
  // The envelope parser intentionally does NOT deep-validate plannedSteps; an
  // empty array still parses here and is rejected later by consume.
  const passthrough = parseClaimedAuthorityJob({
    jobId: 'job-file-2',
    storyId: 'B-auto',
    mode: 'local',
    until: 'TEST',
    plannedSteps: [],
  });
  assert.equal(passthrough.ok, true, 'envelope parsing defers deep plannedSteps validation to consume');
}

for (const [label, raw] of [
  ['non-object', 42],
  ['array', [{ jobId: 'x' }]],
  ['null', null],
  ['missing jobId', { storyId: 'B-auto', mode: 'authority', until: 'DONE', plannedSteps: [step('provider.fake')] }],
  ['empty jobId', { jobId: '   ', storyId: 'B-auto', mode: 'authority', until: 'DONE', plannedSteps: [step('provider.fake')] }],
  ['missing storyId', { jobId: 'j', mode: 'authority', until: 'DONE', plannedSteps: [step('provider.fake')] }],
  ['bad mode', { jobId: 'j', storyId: 'B-auto', mode: 'shadow', until: 'DONE', plannedSteps: [step('provider.fake')] }],
  ['bad until', { jobId: 'j', storyId: 'B-auto', mode: 'authority', until: 'NOPE', plannedSteps: [step('provider.fake')] }],
  ['missing plannedSteps', { jobId: 'j', storyId: 'B-auto', mode: 'authority', until: 'DONE' }],
  ['bad workflow', { jobId: 'j', storyId: 'B-auto', mode: 'authority', until: 'DONE', plannedSteps: [step('provider.fake')], developmentWorkflow: 'mystery' }],
] as Array<[string, unknown]>) {
  const parsed = parseClaimedAuthorityJob(raw);
  assert.equal(parsed.ok, false, `invalid job envelope (${label}) must fail closed`);
  if (!parsed.ok) {
    assert(parsed.reason.length > 0, `invalid job envelope (${label}) must surface a reason`);
  }
}

console.log(PASS_LINE);
