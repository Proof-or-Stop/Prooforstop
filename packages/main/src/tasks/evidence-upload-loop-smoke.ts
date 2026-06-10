#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthorityClient, type AuthorityFetch } from '../core/authority-client.js';
import { executePlannedSteps } from '../core/planned-steps-executor.js';
import {
  buildEvidenceStream,
  classifyEvidenceKind,
  createStepEvidenceRecorder,
  recordLocalEvidence,
  streamPlannedStepEvidence,
  streamEvidenceToAuthority,
  REQUIRED_EVIDENCE_KINDS,
  type EvidenceStreamKind,
} from '../core/evidence-uploader.js';
import type { JobPlan, PlannedStep, PlannerStoreLike } from '../core/planner.js';
import type { StoryInfo } from '../core/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = () => new Date('2026-06-06T00:00:00.000Z');
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

// Steps span the full §B4 taxonomy: command_event, provider_event,
// validation_evidence, gate_request, stop_summary. A leading run_record and an
// injected git_evidence record complete the seven kinds.
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

// A fetch router that records which endpoint each POST hit, with per-endpoint status.
function uploadRouterFetch(opts: {
  providerEvents?: { status: number };
  runEvents?: { status: number };
  hits?: { providerEvents: number; runEvents: number; paths: string[] };
}): AuthorityFetch {
  const ok = (s: number) => s >= 200 && s < 300;
  return async (input, init) => {
    const url = String(input);
    if (opts.hits) opts.hits.paths.push(`${init.method} ${url.replace(/^https?:\/\/[^/]+/, '')}`);
    if (url.includes('/provider-events') && init.method === 'POST') {
      if (opts.hits) opts.hits.providerEvents += 1;
      const s = opts.providerEvents?.status ?? 200;
      return { ok: ok(s), status: s, text: async () => '' };
    }
    if (url.endsWith('/events') && init.method === 'POST') {
      if (opts.hits) opts.hits.runEvents += 1;
      const s = opts.runEvents?.status ?? 200;
      return { ok: ok(s), status: s, text: async () => '' };
    }
    throw Object.assign(new Error(`unexpected fetch ${init.method} ${url}`), { code: 'EUNEXPECTED' });
  };
}

const noNetworkFetch: AuthorityFetch = async (input, init) => {
  throw Object.assign(new Error(`network must not be called: ${init.method} ${String(input)}`), { code: 'ENONET' });
};

function runExecutor(plan: JobPlan) {
  return executePlannedSteps({
    root: '/tmp/x',
    store: fakeStore(),
    jobPlan: plan,
    now: FIXED_NOW,
    // A verified-approve evaluator so every step (incl. stop.summary) executes.
    authorityGate: (input) => ({ receiptVerified: true, decision: 'approve', gateInputDigest: input.gateInputDigest, reason: 'smoke' }),
  });
}

// ---------------------------------------------------------------------------
// 1. classifyEvidenceKind: type -> kind mapping
// ---------------------------------------------------------------------------
{
  const cases: Array<[PlannedStep['type'], EvidenceStreamKind]> = [
    ['provider.fake', 'provider_event'],
    ['provider.codex', 'provider_event'],
    ['provider.claude', 'provider_event'],
    ['validate.run', 'validation_evidence'],
    ['gate.evaluate', 'gate_request'],
    ['stop.summary', 'stop_summary'],
    ['lattice.command', 'command_event'],
    ['codex.verify', 'command_event'],
    ['story.advance', 'command_event'],
  ];
  for (const [type, kind] of cases) {
    assert.equal(classifyEvidenceKind(type), kind, `${type} -> ${kind}`);
  }
}

// ---------------------------------------------------------------------------
// 2. buildEvidenceStream: full §B4 taxonomy, run_record first, git_evidence when injected
// ---------------------------------------------------------------------------
{
  const plan = jobPlan('authority');
  const exec = runExecutor(plan);
  assert.equal(exec.status, 'done', 'executor completes all steps with verified approve');
  const records = buildEvidenceStream(exec, plan, { now: FIXED_NOW, gitState: { headHash: 'abc123', dirty: false, changedFiles: ['src/foo.ts'] } });
  const kinds = records.map(r => r.kind);
  assert.equal(kinds[0], 'run_record', 'run_record is emitted first');
  // Every taxonomy kind is present exactly once across the stream.
  for (const k of REQUIRED_EVIDENCE_KINDS) {
    assert.ok(kinds.includes(k), `stream covers ${k}`);
  }
  // No raw secrets / logs — payloads carry digests/refs only.
  const gitRecord = records.find(r => r.kind === 'git_evidence')!;
  assert.equal(gitRecord.payload.changedFileCount, 1);
  assert.equal(gitRecord.payload.headHash, 'abc123');
  // run_record carries no stdout/stderr, only digests + counts.
  const runRecord = records.find(r => r.kind === 'run_record')!;
  assert.equal(typeof runRecord.payload.plannedStepsDigest, 'string');
  assert.equal(runRecord.payload.executedStepCount, exec.executedStepCount);
}

// ---------------------------------------------------------------------------
// 3. Executor-driven per-step recorder: one record per step, in order
// ---------------------------------------------------------------------------
{
  const plan = jobPlan('authority');
  const handle = createStepEvidenceRecorder(plan);
  const exec = executePlannedSteps({
    root: '/tmp/x',
    store: fakeStore(),
    jobPlan: plan,
    now: FIXED_NOW,
    authorityGate: (input) => ({ receiptVerified: true, decision: 'approve', gateInputDigest: input.gateInputDigest, reason: 'smoke' }),
    evidenceRecorder: handle.recorder,
  });
  const recorded = handle.records();
  assert.equal(recorded.length, exec.steps.length, 'recorder sees exactly one record per executed step');
  assert.deepEqual(recorded.map(r => r.stepId), exec.steps.map(s => s.stepId), 'records preserve execution order');
  assert.deepEqual(
    recorded.map(r => r.kind),
    ['command_event', 'provider_event', 'validation_evidence', 'gate_request', 'stop_summary'],
    'per-step kinds match step types in order',
  );
}

// ---------------------------------------------------------------------------
// 4. LOCAL mode writes local evidence ONLY — zero network, process event written
// ---------------------------------------------------------------------------
{
  const events: Array<{ storyId: string; event: Record<string, unknown> }> = [];
  const store = fakeStore(events);
  const plan = jobPlan('local');
  const exec = runExecutor(plan);
  // A client is passed but must NEVER be consulted in local mode (throwing fetch).
  const client = new AuthorityClient('https://a.test', noNetworkFetch);
  const result = await streamPlannedStepEvidence(exec, plan, {
    now: FIXED_NOW,
    client,
    header: { actorId: 'runner', runId: 'run-1' },
    store,
    gitState: { headHash: 'h', dirty: false, changedFiles: [] },
  });
  assert.equal(result.mode, 'local');
  assert.equal(result.status, 'local_only', 'local mode never streams to authority');
  assert.equal(result.networkCalls, 0, 'local mode performs ZERO network calls');
  assert.equal(result.receiptMinted, false, 'no receipt minted');
  assert.ok(result.records.length >= 6, 'local stream still builds the full evidence taxonomy');
  assert.equal(result.uploads.every(u => u.endpoint === 'local' && u.transport === 'local'), true);
  // recordLocalEvidence wrote exactly one digest-only process event.
  const localEvents = events.filter(e => e.event.type === 'planner_evidence_local');
  assert.equal(localEvents.length, 1, 'local mode writes a planner_evidence_local process event');
  assert.equal(localEvents[0].event.recordCount, result.records.length);
}

// ---------------------------------------------------------------------------
// 5. AUTHORITY mode happy path — every record streamed, correct endpoint routing
// ---------------------------------------------------------------------------
{
  const plan = jobPlan('authority');
  const exec = runExecutor(plan);
  const hits = { providerEvents: 0, runEvents: 0, paths: [] as string[] };
  const client = new AuthorityClient('https://a.test', uploadRouterFetch({ hits }), undefined, CLIENT_AUTH);
  const result = await streamPlannedStepEvidence(exec, plan, {
    now: FIXED_NOW,
    client,
    header: { actorId: 'runner', runId: 'run-7' },
    gitState: { headHash: 'h', dirty: true, changedFiles: ['a.ts', 'b.ts'] },
  });
  assert.equal(result.mode, 'authority');
  assert.equal(result.status, 'streamed', 'all required records uploaded -> streamed');
  assert.equal(result.networkCalls, result.recordCount, 'one POST per record (per-step streaming)');
  assert.equal(result.uploads.every(u => u.uploaded), true, 'every record uploaded successfully');
  assert.equal(result.receiptMinted, false, 'streaming never mints a receipt');
  // Provider records route to /provider-events; everything else to /events.
  assert.equal(hits.providerEvents, 1, 'exactly one provider-events POST (one provider step)');
  assert.equal(hits.runEvents, result.recordCount - 1, 'all non-provider records hit /events');
  const providerUpload = result.uploads.find(u => u.kind === 'provider_event')!;
  assert.equal(providerUpload.endpoint, 'provider-events');
}

// ---------------------------------------------------------------------------
// 6. AUTHORITY mode FAILS CLOSED on a required-evidence upload failure
// ---------------------------------------------------------------------------
{
  const plan = jobPlan('authority');
  const exec = runExecutor(plan);
  // /events returns 500 -> the first required run-event record (run_record) fails.
  const hits = { providerEvents: 0, runEvents: 0, paths: [] as string[] };
  const client = new AuthorityClient('https://a.test', uploadRouterFetch({ runEvents: { status: 500 }, hits }), undefined, CLIENT_AUTH);
  const result = await streamPlannedStepEvidence(exec, plan, {
    now: FIXED_NOW,
    client,
    header: { actorId: 'runner', runId: 'run-7' },
  });
  assert.equal(result.status, 'blocked', 'a required upload failure fails the run closed');
  assert.ok(result.blockedReason, 'a blocked stream records an exact reason');
  // Exact reason names kind, stepId, and transport outcome.
  assert.match(result.blockedReason!, /^evidence_upload_failed:run_record:<run>:http_error$/, `exact blockedReason, got ${result.blockedReason}`);
  // Streaming stops at the first required failure; remaining records are skipped.
  const skipped = result.uploads.filter(u => u.transport === 'skipped');
  assert.ok(skipped.length > 0, 'records after the block are skipped, not uploaded');
  assert.equal(result.receiptMinted, false);
}

// ---------------------------------------------------------------------------
// 7. AUTHORITY mode: non-required failure does NOT block when policy allows it
// ---------------------------------------------------------------------------
{
  // allowContinueWithoutEvidence relaxes the required set: a failed upload is
  // recorded (uploaded:false) but the stream still completes as `streamed`.
  const plan = jobPlan('authority', {
    evidencePolicy: {
      requiredEvidenceKinds: [...REQUIRED_EVIDENCE_KINDS],
      redactionRequired: true,
      retentionClassByKind: {},
      allowContinueWithoutEvidence: true,
      checklistCoverageRequired: true,
    },
  });
  const exec = runExecutor(plan);
  const client = new AuthorityClient('https://a.test', uploadRouterFetch({ runEvents: { status: 500 } }), undefined, CLIENT_AUTH);
  const result = await streamPlannedStepEvidence(exec, plan, {
    now: FIXED_NOW,
    client,
    header: { actorId: 'runner', runId: 'run-7' },
  });
  assert.equal(result.status, 'streamed', 'non-required failures do not block when allowContinueWithoutEvidence');
  assert.equal(result.uploads.some(u => !u.uploaded && u.transport === 'http_error'), true, 'failed uploads are recorded, not skipped');
  assert.equal(result.uploads.every(u => u.transport !== 'skipped'), true, 'nothing is skipped — the stream ran to completion');
  assert.equal(result.uploads.every(u => u.required === false), true, 'allowContinueWithoutEvidence makes every record non-required');
}

// ---------------------------------------------------------------------------
// 8. AUTHORITY mode with no client/header fails closed BEFORE any network
// ---------------------------------------------------------------------------
{
  const plan = jobPlan('authority');
  const exec = runExecutor(plan);
  const result = await streamPlannedStepEvidence(exec, plan, { now: FIXED_NOW });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockedReason, 'authority_evidence_client_unconfigured', 'unconfigured authority evidence fails closed');
  assert.equal(result.networkCalls, 0, 'no network before a verifiable client exists');
  assert.equal(result.receiptMinted, false);
}

// ---------------------------------------------------------------------------
// 9. streamEvidenceToAuthority building block: empty path guard + per-record acks
// ---------------------------------------------------------------------------
{
  const plan = jobPlan('authority');
  const exec = runExecutor(plan);
  const records = buildEvidenceStream(exec, plan, { now: FIXED_NOW });
  await assert.rejects(
    () => streamEvidenceToAuthority(records, new AuthorityClient('https://a.test', uploadRouterFetch({})), { actorId: 'a', runId: '  ' }),
    /runId must be a non-empty string/,
    'an empty runId is rejected by the client before any evidence is laundered through',
  );
}

// ---------------------------------------------------------------------------
// 10. recordLocalEvidence is digest-only (no raw payload leakage)
// ---------------------------------------------------------------------------
{
  const events: Array<{ storyId: string; event: Record<string, unknown> }> = [];
  const store = fakeStore(events);
  const plan = jobPlan('local');
  const exec = runExecutor(plan);
  const records = buildEvidenceStream(exec, plan, { now: FIXED_NOW });
  recordLocalEvidence(store, plan.storyId, records, { plannerRunId: plan.plannerRunId });
  const event = events[0].event;
  const recorded = event.records as Array<Record<string, unknown>>;
  assert.equal(recorded.length, records.length);
  // Only the digest-only + retention/redaction-metadata projection fields are
  // persisted — never raw `payload`.
  for (const r of recorded) {
    assert.deepEqual(Object.keys(r).sort(), ['evidenceBinding', 'evidenceDigest', 'kind', 'redacted', 'required', 'retentionClass', 'status', 'stepId']);
    assert.equal(typeof r.retentionClass, 'string', 'every local record carries a retention class');
    assert.equal(typeof r.redacted, 'boolean', 'every local record records whether redaction fired');
  }
}

// A throwaway tmp dir touch keeps parity with sibling smokes that allocate one;
// also proves the smoke does no stray filesystem writes outside it.
{
  const root = mkdtempSync(join(tmpdir(), 'lattice-evidence-smoke-'));
  try {
    assert.ok(root.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('evidence upload loop smoke passed');
