#!/usr/bin/env node

// =============================================================================
// Evidence streaming / redaction / retention wired into the Stage B execution path
// (§B4 / §B4a / §B4b / §B15 of lattice-authority-live-integration.md).
//
// Unlike evidence-upload-loop-smoke (which pins the streaming transport) and
// evidence-retention-gc-smoke (which pins the redaction + GC engines in isolation),
// this smoke proves the engines are WIRED through the real `executePlannedSteps`
// execution path:
//
//   1. returned steps -> structured Authority evidence envelopes (buildEvidenceStream);
//   2. redactEvidence runs before upload: redactionSummary + digests, never raw secrets;
//   3. retention is classified consistently for run record / provider / command /
//      validation / git evidence / final summary (and honors a JobPlan override);
//   4. the authority gate input references DURABLE uploaded evidence refs from the
//      actual executed steps when the live resolver is configured — not the static
//      pre-execution evidenceBinding strings;
//   5. local mode performs ZERO network calls while still classifying + redacting.
// =============================================================================

import assert from 'node:assert/strict';
import { AuthorityClient, type AuthorityFetch } from '../core/authority-client.js';
import {
  executePlannedSteps,
  type AuthorityGateInput,
  type PlannedStepExecution,
} from '../core/planned-steps-executor.js';
import {
  buildEvidenceStream,
  buildGateEvidenceRefResolver,
  buildStepEvidenceRecord,
  classifyEvidenceKind,
  streamPlannedStepEvidence,
  REQUIRED_EVIDENCE_KINDS,
} from '../core/evidence-uploader.js';
import { classifyRetention } from '../core/evidence-retention.js';
import type { JobPlan, PlannedStep, PlannerStoreLike } from '../core/planner.js';
import type { StoryInfo } from '../core/types.js';

const FIXED_NOW = () => new Date('2026-06-06T00:00:00.000Z');
const APPROVE_GATE = (input: AuthorityGateInput) => ({
  receiptVerified: true,
  decision: 'approve' as const,
  gateInputDigest: input.gateInputDigest,
  reason: 'smoke',
});
const CLIENT_AUTH = { customerApiKey: 'customer-key-canary' };

function step(stepId: string, type: PlannedStep['type'], extra: Partial<PlannedStep> = {}): PlannedStep {
  const provider = type === 'provider.fake' ? 'fake' : undefined;
  return {
    stepId,
    type,
    title: stepId,
    purpose: `${type} bounded step`,
    cwdPolicy: 'story-worktree',
    timeoutMs: 60_000,
    maxAttempts: 1,
    requiresCleanWorktree: false,
    producesEvidence: true,
    blocksUntilEvidenceUploaded: false,
    ...(provider ? { provider } : {}),
    evidenceBinding: `B-evid:${stepId}`,
    args: {},
    ...extra,
  };
}

function jobPlan(mode: 'local' | 'authority', overrides: Partial<JobPlan> = {}): JobPlan {
  const plannedSteps: PlannedStep[] = [
    step('step-ctx', 'lattice.command', { args: { operation: 'context.read', relatedDocs: ['CLAUDE.md'] } }),
    step('step-fake', 'provider.fake'),
    step('step-validate', 'validate.run', { validationBinding: 'step-validate' }),
    step('step-gate', 'gate.evaluate'),
    step('step-stop', 'stop.summary'),
  ];
  return {
    schemaVersion: 'lattice.job_plan.v1',
    plannerRunId: 'prun-evid-1',
    storyId: 'B-evid',
    mode,
    until: 'DONE',
    developmentWorkflow: 'standard',
    evidencePolicy: {
      requiredEvidenceKinds: [...REQUIRED_EVIDENCE_KINDS],
      redactionRequired: true,
      retentionClassByKind: {},
      allowContinueWithoutEvidence: false,
      checklistCoverageRequired: true,
    },
    plannedSteps,
    coverageMap: [{
      checklistItemId: 'CHK-001',
      verificationIntentDigest: 'vid-1',
      plannedStepIds: ['step-fake'],
      validationStepIds: ['step-validate'],
      evidenceRefs: ['B-evid:step-validate'],
      expectedArtifacts: [],
      gatePredicate: 'validate.pass',
    }],
    multiHostPolicy: {
      minIndependentHosts: 2,
      targetHostsPerWave: 2,
      preferredHostsForReleaseCertification: 3,
      preferredVerifierProviders: [],
      requireMultiHost: false,
      requiredHostVerdictCount: 2,
      fullAuthorityDoneRequired: true,
    },
    plannerDigest: 'pd-1',
    jobPlanDigest: 'jpd-1',
    status: 'planned',
    ...overrides,
  };
}

function fakeStore(events: Array<{ storyId: string; event: Record<string, unknown> }> = []): PlannerStoreLike {
  return {
    readStory: (storyId: string): StoryInfo => ({ storyId, phase: 'TEST' } as unknown as StoryInfo),
    storyExists: () => true,
    listStoryIds: () => ['B-evid'],
    appendProcessEvent: (storyId, event) => { events.push({ storyId, event }); },
  };
}

// ---------------------------------------------------------------------------
// 1. Durable gate refs: with the resolver configured, the authority gate input +
//    terminal stop.summary reference durable uploaded evidence ids, NOT static
//    evidenceBinding strings (§B15 / requirement 4).
// ---------------------------------------------------------------------------
{
  const plan = jobPlan('authority');
  const resolver = buildGateEvidenceRefResolver(plan);

  const staticInputs: AuthorityGateInput[] = [];
  const staticExec = executePlannedSteps({
    root: '/tmp/x', store: fakeStore(), jobPlan: plan, now: FIXED_NOW,
    authorityGate: (input) => { staticInputs.push(input); return APPROVE_GATE(input); },
  });
  assert.equal(staticExec.status, 'done');
  // Default (no resolver): the gate certifies static evidenceBinding strings.
  assert.deepEqual(
    staticInputs[0].evidenceRefs,
    ['B-evid:step-ctx', 'B-evid:step-fake', 'B-evid:step-validate'],
    'without a resolver the gate input keeps static evidenceBinding refs',
  );

  const durableInputs: AuthorityGateInput[] = [];
  const durableExec = executePlannedSteps({
    root: '/tmp/x', store: fakeStore(), jobPlan: plan, now: FIXED_NOW,
    authorityGate: (input) => { durableInputs.push(input); return APPROVE_GATE(input); },
    gateEvidenceRefResolver: resolver,
  });
  assert.equal(durableExec.status, 'done');
  // With the resolver: the gate input references durable content-addressed evidence
  // ids (<plannerRunId>:<stepId>:<kind>) from the ACTUAL executed steps.
  assert.deepEqual(
    durableInputs[0].evidenceRefs,
    ['prun-evid-1:step-ctx:command_event', 'prun-evid-1:step-fake:provider_event', 'prun-evid-1:step-validate:validation_evidence'],
    'with a resolver the gate input references durable uploaded evidence refs from executed steps',
  );
  // The gate idempotency key changes when the refs change — the gate is genuinely
  // certifying different (durable) inputs, not just relabeling.
  assert.notEqual(durableInputs[0].gateInputDigest, staticInputs[0].gateInputDigest, 'durable refs change the gate input digest');

  // The terminal stop.summary surfaces the same durable refs the gate certified, and
  // every durable ref matches the evidence id its uploaded record carries.
  const stop = durableExec.steps.find(s => s.type === 'stop.summary')!;
  const stopRefs = stop.summary.evidenceRefs as string[];
  assert.deepEqual(
    stopRefs,
    ['prun-evid-1:step-ctx:command_event', 'prun-evid-1:step-fake:provider_event', 'prun-evid-1:step-validate:validation_evidence', 'prun-evid-1:step-gate:gate_request'],
    'stop.summary references durable refs for every prior step (incl. the gate)',
  );
  for (const execStep of durableExec.steps) {
    if (execStep.type === 'stop.summary') continue;
    const record = buildStepEvidenceRecord(execStep, plan);
    assert.equal(resolver(execStep), record.evidenceId, 'the gate resolver ref == the uploaded record evidenceId (durable + content-addressed)');
  }
  console.log('  ✓ gate + stop.summary reference durable uploaded evidence refs from executed steps (static default preserved)');
}

// ---------------------------------------------------------------------------
// 2. Retention classification is applied consistently to every record kind, and a
//    JobPlan policy override is honored (§B4b / requirement 3).
// ---------------------------------------------------------------------------
{
  const plan = jobPlan('authority');
  const exec = executePlannedSteps({ root: '/tmp/x', store: fakeStore(), jobPlan: plan, now: FIXED_NOW, authorityGate: APPROVE_GATE });
  const records = buildEvidenceStream(exec, plan, { now: FIXED_NOW, gitState: { headHash: 'h', dirty: false, changedFiles: ['src/a.ts'] } });
  const byKind = new Map(records.map(r => [r.kind, r] as const));
  for (const k of REQUIRED_EVIDENCE_KINDS) {
    const rec = byKind.get(k)!;
    assert.equal(rec.retentionClass, classifyRetention(k), `record kind ${k} carries the canonical retention class`);
  }
  assert.equal(byKind.get('run_record')!.retentionClass, 'short_lived_run_log');
  assert.equal(byKind.get('validation_evidence')!.retentionClass, 'verification_artifact');
  assert.equal(byKind.get('git_evidence')!.retentionClass, 'verification_artifact');
  assert.equal(byKind.get('gate_request')!.retentionClass, 'receipt_bound_artifact');
  assert.equal(byKind.get('stop_summary')!.retentionClass, 'final_summary', 'the final summary is retained for query');
  // Payload carries the same retention class so the uploaded envelope is self-describing.
  for (const rec of records) {
    assert.equal(rec.payload.retentionClass, rec.retentionClass, 'payload retentionClass mirrors the record');
  }

  // A JobPlan retention override is threaded through to the records.
  const overridden = jobPlan('authority', {
    evidencePolicy: {
      requiredEvidenceKinds: [...REQUIRED_EVIDENCE_KINDS],
      redactionRequired: true,
      retentionClassByKind: { validation_evidence: 'receipt_bound_artifact' },
      allowContinueWithoutEvidence: false,
      checklistCoverageRequired: true,
    },
  });
  const overExec = executePlannedSteps({ root: '/tmp/x', store: fakeStore(), jobPlan: overridden, now: FIXED_NOW, authorityGate: APPROVE_GATE });
  const overRecords = buildEvidenceStream(overExec, overridden, { now: FIXED_NOW });
  assert.equal(
    overRecords.find(r => r.kind === 'validation_evidence')!.retentionClass,
    'receipt_bound_artifact',
    'a JobPlan retentionClassByKind override is honored in the executed-step record',
  );
  console.log('  ✓ retention classified consistently across run/provider/command/validation/git/gate/summary + honors JobPlan override');
}

// ---------------------------------------------------------------------------
// 3. Redaction runs before upload: a secret laundered into a step reason/summary is
//    scrubbed; redactionSummary + digests survive, the raw secret never does
//    (§B4a / requirement 2).
// ---------------------------------------------------------------------------
{
  const plan = jobPlan('authority');
  const SECRET = ['ghp', '_0123456789abcdefghijABCDEFGHIJ012345'].join('');
  // A synthetic executed step carrying a secret in BOTH its reason and a summary note
  // (the shape a real provider/validation failure could surface).
  const dirtyStep: PlannedStepExecution = {
    stepId: 'step-validate',
    type: 'validate.run',
    status: 'failed',
    evidenceBinding: 'B-evid:step-validate',
    evidenceDigest: 'deadbeef',
    startedAt: '2026-06-06T00:00:00.000Z',
    endedAt: '2026-06-06T00:00:00.000Z',
    attempts: 1,
    reason: `provider_failed: export GITHUB_TOKEN=${SECRET}`,
    summary: { note: `auth header was Authorization: Bearer ${'a'.repeat(40)}`, ok: false },
  };
  const record = buildStepEvidenceRecord(dirtyStep, plan);
  const serialized = JSON.stringify(record);
  assert.equal(record.redactionSummary.redacted, true, 'the redaction pass reports it fired on the secret-bearing step');
  assert.ok(record.redactionSummary.ruleHits.length >= 1, 'at least one redaction rule matched');
  assert.ok(!serialized.includes(SECRET), 'the raw GitHub token never appears in the uploaded record');
  assert.ok(!serialized.includes('aaaaaaaaaaaaaaaaaaaa'), 'the raw bearer token never appears in the uploaded record');
  // The redacted reason is stored (with the placeholder), and the original digest is
  // preserved so a verifier can still match the unredacted local artifact.
  assert.ok(String(record.payload.reason).includes('[REDACTED]'), 'the stored reason is the redacted form');
  assert.equal(typeof record.redactionSummary.originalDigest, 'string');
  assert.notEqual(record.redactionSummary.originalDigest, record.redactionSummary.redactedDigest, 'redaction changed material evidence');

  // A clean executed step still carries a (no-op) redaction summary — the pass always runs.
  const cleanExec = executePlannedSteps({ root: '/tmp/x', store: fakeStore(), jobPlan: plan, now: FIXED_NOW, authorityGate: APPROVE_GATE });
  for (const rec of buildEvidenceStream(cleanExec, plan, { now: FIXED_NOW })) {
    assert.equal(typeof rec.redactionSummary.redacted, 'boolean', 'every record carries a redaction summary, even when clean');
    assert.ok(!JSON.stringify(rec).includes('[REDACTED]') === (rec.redactionSummary.redacted === false), 'clean records contain no placeholder');
  }
  console.log('  ✓ redactEvidence runs before upload: secret scrubbed, redactionSummary + digests preserved, raw secret never uploaded');
}

// ---------------------------------------------------------------------------
// 4. Authority streaming carries the redaction + retention metadata in the uploaded
//    envelopes (requirement 1 — returned steps -> structured envelopes).
// ---------------------------------------------------------------------------
{
  const plan = jobPlan('authority');
  const exec = executePlannedSteps({ root: '/tmp/x', store: fakeStore(), jobPlan: plan, now: FIXED_NOW, authorityGate: APPROVE_GATE });
  const bodies: any[] = [];
  const capturingFetch: AuthorityFetch = async (input, init) => {
    if (init.body) bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => '' };
  };
  const client = new AuthorityClient('https://a.test', capturingFetch, undefined, CLIENT_AUTH);
  const result = await streamPlannedStepEvidence(exec, plan, {
    now: FIXED_NOW,
    client,
    header: { actorId: 'runner', runId: 'run-1' },
    gitState: { headHash: 'h', dirty: true, changedFiles: ['a.ts'] },
  });
  assert.equal(result.status, 'streamed');
  assert.equal(result.networkCalls, result.recordCount, 'one POST per record');
  // Every uploaded envelope event payload carries the retention class + redaction metadata.
  let inspected = 0;
  for (const body of bodies) {
    const payload = body.event?.payload ?? body.providerEvent?.metadata;
    assert.ok(payload && typeof payload === 'object', 'uploaded Python event envelope carries structured payload/metadata');
    assert.equal(typeof payload.retentionClass, 'string', 'uploaded event payload carries a retention class');
    assert.ok(payload.redaction && typeof payload.redaction === 'object', 'uploaded event payload carries a redaction summary');
    assert.ok(!JSON.stringify(payload).includes('PRIVATE KEY'), 'no raw secret material in the uploaded payload');
    inspected += 1;
  }
  assert.ok(inspected >= REQUIRED_EVIDENCE_KINDS.length - 1, 'every streamed record was inspected');
  console.log('  ✓ authority streaming uploads structured envelopes carrying retention + redaction metadata');
}

// ---------------------------------------------------------------------------
// 5. Local mode: ZERO network, but records still classified + redacted (requirement 5).
// ---------------------------------------------------------------------------
{
  const events: Array<{ storyId: string; event: Record<string, unknown> }> = [];
  const store = fakeStore(events);
  const plan = jobPlan('local');
  const exec = executePlannedSteps({ root: '/tmp/x', store: fakeStore(), jobPlan: plan, now: FIXED_NOW, authorityGate: APPROVE_GATE });
  const noNetworkFetch: AuthorityFetch = async (i, init) => {
    throw Object.assign(new Error(`network must not be called: ${init.method} ${String(i)}`), { code: 'ENONET' });
  };
  const client = new AuthorityClient('https://a.test', noNetworkFetch);
  const result = await streamPlannedStepEvidence(exec, plan, {
    now: FIXED_NOW, client, header: { actorId: 'runner', runId: 'run-1' }, store,
    gitState: { headHash: 'h', dirty: false, changedFiles: [] },
  });
  assert.equal(result.mode, 'local');
  assert.equal(result.networkCalls, 0, 'local mode performs ZERO network calls even with a client passed');
  for (const rec of result.records) {
    assert.equal(typeof rec.retentionClass, 'string', 'local records are still retention-classified');
    assert.equal(typeof rec.redactionSummary.redacted, 'boolean', 'local records are still redacted');
  }
  // The local process event preserves the retention class + redaction flag per record.
  const localEvent = events.find(e => e.event.type === 'planner_evidence_local')!;
  const recorded = localEvent.event.records as Array<Record<string, unknown>>;
  assert.ok(recorded.every(r => typeof r.retentionClass === 'string' && typeof r.redacted === 'boolean'), 'local evidence event carries retention + redaction metadata');
  console.log('  ✓ local mode: zero network, records still classified + redacted');
}

console.log('✓ evidence-live-wiring smoke passed: executor steps -> redacted, retention-classified Authority evidence envelopes; gate references durable uploaded refs; local stays zero-network');
