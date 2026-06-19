#!/usr/bin/env node
/**
 * Smoke coverage for the Stage B authority completion gate (M10 / M11):
 *
 *   - evaluateAuthorityCompletion is the single FAIL-CLOSED gate: per-run
 *     authorityDone requires a verified native gate_decision receipt PLUS completed
 *     validation; fullAuthorityDone additionally requires the multi-host final gate
 *     when policy demands it; the job `completed` flag is the per-mode DONE
 *     projection.
 *   - every failure path — reject, tamper, wrong key, wrong story, stale,
 *     future-dated, missing receipt, evaluation error, validation incomplete, unmet
 *     multi-host floor — leaves the DONE flags false with an explicit blocking reason.
 *   - runAuthorityCompletionLoop drives resolve-gate -> execute-steps ->
 *     evaluate-completion against a fake Lattice Authority server, automatically
 *     calling /v1/gates/evaluate after appending run + evidence events, fetching /
 *     verifying the native receipt, recording receipt refs, and completing ONLY on a
 *     verified approve + completed run + satisfied multi-host policy.
 *   - completionToFinalizeInput bridges the verdict into the lease state machine.
 *   - local / non-authority and authority/non-DONE jobs never project authority DONE
 *     and (local) make zero network calls.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalDigest,
  generateEd25519KeyPair,
  signCanonical,
  stripSignature,
} from '../core/authority-signing.js';
import {
  FINAL_HOST_REVIEW_PROMPT_PROFILE,
  buildFinalHostReviewPromptDigestInput,
} from '../core/authority-contracts.js';
import {
  evaluateAuthorityCompletion,
  runAuthorityCompletionLoop,
  completionToFinalizeInput,
  type MultiHostReconciliation,
} from '../core/authority-completion.js';
import type { AuthorityFetch, AuthorityGateDecision } from '../core/authority-client.js';
import type { JobPlan, PlannedStep, PlannerStoreLike } from '../core/planner.js';
import type { StoryInfo } from '../core/types.js';
import type { PlannedStepsExecutionResult } from '../core/planned-steps-executor.js';
import { createBudgetMeter, resolveBudgetLimits, type BudgetReport } from '../core/budget-meter.js';

const PASS_LINE =
  '✓ authority completion smoke passed: completion gate fail-closed (reject/tamper/wrong-key/wrong-story/stale/future), authorityDone+fullAuthorityDone gating, loop end-to-end, lease bridge';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-06-06T00:00:00.000Z');
const EXECUTOR_GATE_INPUT_DIGEST = 'gid-1';
const RECEIPT_INPUT_DIGEST = 'rid-1';
const runnerActorKeypair = generateEd25519KeyPair();
const gateActorKeypair = generateEd25519KeyPair();
const FAKE_HOST_VERDICT_SIGNATURE = 'a'.repeat(128);

type MultiHostPolicy = JobPlan['multiHostPolicy'];

function multiHostPolicy(over: Partial<MultiHostPolicy> = {}): MultiHostPolicy {
  return {
    minIndependentHosts: 2,
    targetHostsPerWave: 2,
    preferredHostsForReleaseCertification: 3,
    preferredVerifierProviders: [],
    requireMultiHost: false,
    requiredHostVerdictCount: 0,
    fullAuthorityDoneRequired: false,
    ...over,
  };
}

function freshBudget(): BudgetReport {
  return createBudgetMeter(resolveBudgetLimits(jobPlan())).evaluate();
}

function execResult(over: Partial<PlannedStepsExecutionResult> = {}): PlannedStepsExecutionResult {
  const receiptVerified = over.receiptVerified === true;
  const steps = over.steps ?? (receiptVerified
    ? [{
        stepId: 'step-gate',
        type: 'gate.evaluate',
        status: 'passed',
        evidenceBinding: 'B-auth:step-gate',
        evidenceDigest: 'digest-gate',
        startedAt: FIXED_NOW.toISOString(),
        endedAt: FIXED_NOW.toISOString(),
        attempts: 1,
        summary: {
          receiptVerified: true,
          receiptId: 'rcpt-1',
          decisionDigest: 'dd-1',
          gateInputDigest: EXECUTOR_GATE_INPUT_DIGEST,
        },
      } as PlannedStepsExecutionResult['steps'][number]]
    : []);
  return {
    schemaVersion: 'lattice.planned_steps_execution.v1',
    plannerRunId: 'prun-1',
    storyId: 'B-auth',
    mode: 'authority',
    until: 'DONE',
    developmentWorkflow: 'standard',
    status: 'done',
    localDone: false,
    authorityDone: false,
    fullAuthorityDone: false,
    multiHostVerified: false,
    plannedStepsDigest: 'psd',
    providerPolicyDigest: 'ppd',
    executedStepCount: 4,
    evidenceRefs: ['B-auth:step-fake', 'B-auth:step-validate'],
    stopReason: 'completed',
    nextActions: [],
    budgetUsage: freshBudget(),
    ...over,
    receiptVerified,
    steps,
  };
}

function gateDecision(over: Partial<AuthorityGateDecision> = {}): AuthorityGateDecision {
  return {
    status: 'verified',
    decision: 'approve',
    receiptVerified: true,
    receiptId: 'rcpt-1',
    decisionDigest: 'dd-1',
    gateInputDigest: EXECUTOR_GATE_INPUT_DIGEST,
    receiptInputDigest: RECEIPT_INPUT_DIGEST,
    reason: 'verified',
    ...over,
  };
}

/** Minimal JobPlan whose fields evaluateAuthorityCompletion / finalOutput read. */
function jobPlan(over: Partial<JobPlan> = {}): JobPlan {
  return {
    schemaVersion: 'lattice.job_plan.v1',
    plannerRunId: 'prun-1',
    storyId: 'B-auth',
    mode: 'authority',
    until: 'DONE',
    developmentWorkflow: 'standard',
    plannedSteps: [],
    coverageMap: [],
    multiHostPolicy: multiHostPolicy(),
    plannerDigest: 'pd',
    jobPlanDigest: 'jpd',
    status: 'planned',
    jobCreateRequestEnvelope: {
      kind: 'authority_job_create',
      projectId: 'project-1',
      storyId: 'B-auth',
      plannerRunId: 'prun-1',
      authorityMode: 'enforce',
      createdAt: '2026-06-06T00:00:00Z',
      actorId: 'actor-1',
      actorRole: 'runner',
      actorKeyId: 'key-1',
      canonicalPayloadDigest: 'cpd',
      storyDigest: 'sd',
      plannerDigest: 'pd',
      plannedStepsDigest: 'psd',
      policyDigest: 'pold',
      idempotencyKey: 'idem',
      signatureAlgorithm: 'ed25519',
    },
    ...over,
  } as JobPlan;
}

const SATISFIED_MULTI_HOST: MultiHostReconciliation = {
  independentHostVerdictCount: 6,
  satisfied: true,
  hostVerdictRefs: [
    'verdict-wave-1-host-a',
    'verdict-wave-1-host-b',
    'verdict-wave-2-host-a',
    'verdict-wave-2-host-c',
    'verdict-wave-3-host-b',
    'verdict-wave-3-host-c',
  ],
  checkedReceiptId: 'rcpt-1',
  checkedGateInputDigest: RECEIPT_INPUT_DIGEST,
  reviewWaveProofs: [
    { reviewWaveRef: 'wave-1', independentHostVerdictCount: 2, hostVerdictRefs: ['verdict-wave-1-host-a', 'verdict-wave-1-host-b'] },
    { reviewWaveRef: 'wave-2', independentHostVerdictCount: 2, hostVerdictRefs: ['verdict-wave-2-host-a', 'verdict-wave-2-host-c'] },
    { reviewWaveRef: 'wave-3', independentHostVerdictCount: 2, hostVerdictRefs: ['verdict-wave-3-host-b', 'verdict-wave-3-host-c'] },
  ],
  satisfiedReviewWaveCount: 3,
  requiredReviewWaveCount: 3,
  reviewWaveRefs: ['wave-1', 'wave-2', 'wave-3'],
};

// ─────────────────────────────────────────────────────────────────────────────
// Part A — evaluateAuthorityCompletion (pure decision)
// ─────────────────────────────────────────────────────────────────────────────

// U1: verified approve + multi-host required + reconciliation satisfied -> fullAuthorityDone.
{
  const completion = evaluateAuthorityCompletion({
    jobPlan: jobPlan({ multiHostPolicy: multiHostPolicy({ fullAuthorityDoneRequired: true, requiredHostVerdictCount: 2 }) }),
    execution: execResult({ status: 'done', receiptVerified: true }),
    gateDecision: gateDecision(),
    finalPhase: 'TEST',
    multiHost: SATISFIED_MULTI_HOST,
  });
  assert.equal(completion.authorityDone, true, 'U1 per-run authorityDone on verified approve + validation');
  assert.equal(completion.fullAuthorityDone, true, 'U1 fullAuthorityDone when multi-host reconciliation satisfied');
  assert.equal(completion.multiHostVerified, true);
  assert.equal(completion.completed, true, 'U1 job completes');
  assert.equal(completion.stopReason, 'full_authority_done');
  assert.deepEqual(completion.blockingReasons, []);
  assert.equal(completion.receiptRefs.length, 1, 'U1 records the verified receipt ref');
  assert.equal(completion.receiptRefs[0]?.verified, true, 'U1 receipt ref marked verified');
  assert.equal(completion.receiptRefs[0]?.kind, 'gate_decision');
  assert.equal(completion.hostVerdictRefs.length, 6, 'U1 surfaces host verdict refs for all three review waves');
  assert.equal(completion.satisfiedReviewWaveCount, 3, 'U1 surfaces satisfied review wave count');
}

// U1b: old executor-X5 binding cannot certify final host checks when the
// native gate_decision receipt inputDigest is missing from the verified gate.
{
  const completion = evaluateAuthorityCompletion({
    jobPlan: jobPlan({ multiHostPolicy: multiHostPolicy({ fullAuthorityDoneRequired: true, requiredHostVerdictCount: 2 }) }),
    execution: execResult({ status: 'done', receiptVerified: true }),
    gateDecision: gateDecision({ receiptInputDigest: '' }),
    finalPhase: 'TEST',
    multiHost: {
      ...SATISFIED_MULTI_HOST,
      checkedGateInputDigest: EXECUTOR_GATE_INPUT_DIGEST,
    },
  });
  assert.equal(completion.authorityDone, true, 'U1b per-run authorityDone still reflects the executor/receipt binding');
  assert.equal(completion.fullAuthorityDone, false, 'U1b fullAuthorityDone fails closed without native receipt inputDigest');
  assert.equal(completion.completed, false);
  assert.equal(completion.multiHostVerified, false);
  assert.match(completion.multiHostBlockedReason ?? '', /multi_host_binding_mismatch/);
}

// U2: verified approve + multi-host required but NO reconciliation -> blocked (the new gate).
{
  const completion = evaluateAuthorityCompletion({
    jobPlan: jobPlan({ multiHostPolicy: multiHostPolicy({ fullAuthorityDoneRequired: true, requiredHostVerdictCount: 2 }) }),
    execution: execResult({ status: 'done', receiptVerified: true }),
    gateDecision: gateDecision(),
    finalPhase: 'TEST',
  });
  assert.equal(completion.authorityDone, true, 'U2 per-run authorityDone still holds');
  assert.equal(completion.fullAuthorityDone, false, 'U2 fullAuthorityDone fails closed without multi-host');
  assert.equal(completion.completed, false, 'U2 job does NOT complete without multi-host verification');
  assert.equal(completion.multiHostVerified, false);
  assert.equal(completion.requiredHostVerdictCount, 2);
  assert.equal(completion.independentHostVerdictCount, 0);
  assert(completion.blockingReasons.includes('multi_host_verification_incomplete'), 'U2 names the multi-host block');
  assert.equal(completion.stopReason, 'multi_host_verification_incomplete');
}

// U2b: required count not met (1 of 2) -> still blocked.
{
  const completion = evaluateAuthorityCompletion({
    jobPlan: jobPlan({ multiHostPolicy: multiHostPolicy({ requireMultiHost: true, requiredHostVerdictCount: 2 }) }),
    execution: execResult({ status: 'done', receiptVerified: true }),
    gateDecision: gateDecision(),
    multiHost: { independentHostVerdictCount: 1, satisfied: false, hostVerdictRefs: ['v1'], checkedReceiptId: 'rcpt-1', checkedGateInputDigest: RECEIPT_INPUT_DIGEST },
  });
  assert.equal(completion.fullAuthorityDone, false, 'U2b under-floor reconciliation never satisfies');
  assert.equal(completion.completed, false);
  assert(completion.blockingReasons.includes('multi_host_verification_incomplete'));
}

// U2c: a satisfied injected reconciliation is accepted only when it is bound to
// the current gate receipt and exact gate input digest.
for (const multiHost of [
  { ...SATISFIED_MULTI_HOST, checkedGateInputDigest: 'gid-other' },
  { ...SATISFIED_MULTI_HOST, checkedGateInputDigest: EXECUTOR_GATE_INPUT_DIGEST },
  { ...SATISFIED_MULTI_HOST, checkedReceiptId: 'rcpt-other' },
  {
    independentHostVerdictCount: 2,
    satisfied: true,
    hostVerdictRefs: ['v1', 'v2'],
    satisfiedReviewWaveCount: 3,
    requiredReviewWaveCount: 3,
    reviewWaveRefs: ['wave-1', 'wave-2', 'wave-3'],
  } satisfies MultiHostReconciliation,
]) {
  const completion = evaluateAuthorityCompletion({
    jobPlan: jobPlan({ multiHostPolicy: multiHostPolicy({ requireMultiHost: true, requiredHostVerdictCount: 2 }) }),
    execution: execResult({ status: 'done', receiptVerified: true }),
    gateDecision: gateDecision(),
    multiHost,
  });
  assert.equal(completion.authorityDone, true, 'U2c per-run authorityDone still holds');
  assert.equal(completion.fullAuthorityDone, false, 'U2c stale/unbound host checks cannot certify fullAuthorityDone');
  assert.equal(completion.completed, false);
  assert.equal(completion.multiHostVerified, false);
  assert.match(completion.multiHostBlockedReason ?? '', /multi_host_binding_mismatch/);
}

// U2d: aggregate counts alone cannot certify final DONE; the injected
// reconciliation must prove each of the three waves met the independent-host floor.
{
  const completion = evaluateAuthorityCompletion({
    jobPlan: jobPlan({ multiHostPolicy: multiHostPolicy({ requireMultiHost: true, requiredHostVerdictCount: 2 }) }),
    execution: execResult({ status: 'done', receiptVerified: true }),
    gateDecision: gateDecision(),
    multiHost: {
      independentHostVerdictCount: 6,
      satisfied: true,
      hostVerdictRefs: ['v1', 'v2', 'v3', 'v4', 'v5', 'v6'],
      checkedReceiptId: 'rcpt-1',
      checkedGateInputDigest: RECEIPT_INPUT_DIGEST,
      satisfiedReviewWaveCount: 3,
      requiredReviewWaveCount: 3,
      reviewWaveRefs: ['wave-1', 'wave-2', 'wave-3'],
    },
  });
  assert.equal(completion.authorityDone, true, 'U2d per-run authorityDone still holds');
  assert.equal(completion.fullAuthorityDone, false, 'U2d aggregate-only reconciliation cannot certify fullAuthorityDone');
  assert.equal(completion.completed, false);
  assert.equal(completion.multiHostVerified, false);
  assert.match(completion.multiHostBlockedReason ?? '', /insufficient_review_wave_proof/);
}

// U2e: review-wave proofs must match the final reconciled reviewWaveRefs and use
// distinct host verdict refs inside each wave.
for (const reviewWaveProofs of [
  [
    { reviewWaveRef: 'other-wave-1', independentHostVerdictCount: 2, hostVerdictRefs: ['v1', 'v2'] },
    { reviewWaveRef: 'other-wave-2', independentHostVerdictCount: 2, hostVerdictRefs: ['v3', 'v4'] },
    { reviewWaveRef: 'other-wave-3', independentHostVerdictCount: 2, hostVerdictRefs: ['v5', 'v6'] },
  ],
  [
    { reviewWaveRef: 'wave-1', independentHostVerdictCount: 2, hostVerdictRefs: ['v1', 'v1'] },
    { reviewWaveRef: 'wave-2', independentHostVerdictCount: 2, hostVerdictRefs: ['v2', 'v2'] },
    { reviewWaveRef: 'wave-3', independentHostVerdictCount: 2, hostVerdictRefs: ['v3', 'v3'] },
  ],
]) {
  const completion = evaluateAuthorityCompletion({
    jobPlan: jobPlan({ multiHostPolicy: multiHostPolicy({ requireMultiHost: true, requiredHostVerdictCount: 2 }) }),
    execution: execResult({ status: 'done', receiptVerified: true }),
    gateDecision: gateDecision(),
    multiHost: {
      ...SATISFIED_MULTI_HOST,
      reviewWaveProofs,
    },
  });
  assert.equal(completion.authorityDone, true, 'U2e per-run authorityDone still holds');
  assert.equal(completion.fullAuthorityDone, false, 'U2e unrelated/duplicate review-wave proofs cannot certify fullAuthorityDone');
  assert.equal(completion.completed, false);
  assert.equal(completion.multiHostVerified, false);
  assert.match(completion.multiHostBlockedReason ?? '', /insufficient_review_wave_proof/);
}

// U3: authority/DONE always requires multi-host final certification, even if a
// permissive/legacy plan does not set requireMultiHost.
{
  const completion = evaluateAuthorityCompletion({
    jobPlan: jobPlan({ multiHostPolicy: multiHostPolicy() }),
    execution: execResult({ status: 'done', receiptVerified: true }),
    gateDecision: gateDecision(),
  });
  assert.equal(completion.authorityDone, true);
  assert.equal(completion.fullAuthorityDone, false, 'U3 fullAuthorityDone never collapses without multi-host final checks');
  assert.equal(completion.completed, false);
  assert.equal(completion.stopReason, 'multi_host_verification_incomplete');
  assert.equal(completion.multiHostRequired, true);
}

// U4: reject -> fail closed, no receipt ref (reject returns no receipt handle).
{
  const completion = evaluateAuthorityCompletion({
    jobPlan: jobPlan(),
    execution: execResult({ status: 'blocked', receiptVerified: false, stopReason: 'authority_gate_decision_rejected' }),
    gateDecision: { status: 'rejected', decision: 'reject', receiptVerified: false, reason: 'insufficient evidence' },
  });
  assert.equal(completion.authorityDone, false, 'U4 reject never authorityDone');
  assert.equal(completion.completed, false);
  assert.equal(completion.receiptVerified, false);
  assert.equal(completion.blockingReasons[0], 'authority_gate_decision_rejected');
  assert.equal(completion.receiptRefs.length, 0, 'U4 no receipt ref recorded for a reject with no handle');
}

// U5: tampered / unverified receipt -> fail closed; ref recorded but verified=false.
{
  const completion = evaluateAuthorityCompletion({
    jobPlan: jobPlan(),
    execution: execResult({ status: 'blocked', receiptVerified: false, stopReason: 'authority_gate_receipt_unverified' }),
    gateDecision: { status: 'receipt_unverified', decision: 'approve', receiptVerified: false, receiptId: 'rcpt-tampered', decisionDigest: 'dd-tampered', reason: 'signature mismatch' },
  });
  assert.equal(completion.authorityDone, false, 'U5 tampered receipt is never authorityDone');
  assert.equal(completion.completed, false);
  assert.equal(completion.blockingReasons[0], 'authority_gate_receipt_unverified');
  assert.equal(completion.receiptRefs.length, 1, 'U5 still records a traceable receipt ref');
  assert.equal(completion.receiptRefs[0]?.verified, false, 'U5 unverified receipt ref marked verified=false');
}

// U6: wrong key / wrong story / stale / future all surface as receipt_unverified -> identical fail-closed.
for (const reason of ['wrong server key', 'wrong story binding', 'stale receipt', 'future-dated receipt']) {
  const completion = evaluateAuthorityCompletion({
    jobPlan: jobPlan(),
    execution: execResult({ status: 'blocked', receiptVerified: false, stopReason: 'authority_gate_receipt_unverified' }),
    gateDecision: { status: 'receipt_unverified', decision: 'approve', receiptVerified: false, receiptId: 'rcpt-x', decisionDigest: 'dd-x', reason },
  });
  assert.equal(completion.completed, false, `U6 (${reason}) fails closed`);
  assert.equal(completion.authorityDone, false, `U6 (${reason}) never authorityDone`);
  assert.equal(completion.blockingReasons[0], 'authority_gate_receipt_unverified', `U6 (${reason}) maps to receipt_unverified`);
}

// U7: blocked / unavailable / error gate statuses map to specific block reasons.
{
  const cases: Array<[AuthorityGateDecision['status'], string]> = [
    ['blocked', 'authority_gate_decision_blocked'],
    ['receipt_unavailable', 'authority_gate_receipt_unavailable'],
    ['error', 'authority_gate_evaluation_error'],
  ];
  for (const [status, expected] of cases) {
    const completion = evaluateAuthorityCompletion({
      jobPlan: jobPlan(),
      execution: execResult({ status: 'blocked', receiptVerified: false }),
      gateDecision: { status, decision: status === 'error' ? undefined : 'blocked', receiptVerified: false, reason: status },
    });
    assert.equal(completion.blockingReasons[0], expected, `U7 ${status} -> ${expected}`);
    assert.equal(completion.completed, false);
  }
}

// U8: no gate decision at all (no authority config) -> receipt-required block.
{
  const completion = evaluateAuthorityCompletion({
    jobPlan: jobPlan(),
    execution: execResult({ status: 'blocked', receiptVerified: false, stopReason: 'authority_gate_decision_receipt_required' }),
  });
  assert.equal(completion.blockingReasons[0], 'authority_gate_decision_receipt_required');
  assert.equal(completion.completed, false);
  assert.equal(completion.receiptRefs.length, 0);
}

// U9: validation incomplete (blocked prior step) -> validation_incomplete recorded.
{
  const completion = evaluateAuthorityCompletion({
    jobPlan: jobPlan(),
    execution: execResult({ status: 'blocked', receiptVerified: false, stopReason: 'validation_binding_missing' }),
  });
  assert(completion.blockingReasons.includes('validation_incomplete'), 'U9 records validation_incomplete');
  assert.equal(completion.validationPassed, false);
  assert.equal(completion.completed, false);
}

// U10: local mode -> never authority DONE; completes on validation only.
{
  const completion = evaluateAuthorityCompletion({
    jobPlan: jobPlan({ mode: 'local', multiHostPolicy: multiHostPolicy() }),
    execution: execResult({ mode: 'local', status: 'done', receiptVerified: false }),
  });
  assert.equal(completion.authorityDone, false, 'U10 local mode never authorityDone');
  assert.equal(completion.fullAuthorityDone, false);
  assert.equal(completion.completed, true, 'U10 local completes on validation');
  assert.equal(completion.stopReason, 'completed');
}

// U11: authority but non-DONE target -> completes on validation, no authority DONE.
{
  const completion = evaluateAuthorityCompletion({
    jobPlan: jobPlan({ until: 'TEST' }),
    execution: execResult({ until: 'TEST', status: 'done', receiptVerified: false }),
  });
  assert.equal(completion.authorityDone, false, 'U11 non-DONE target never authorityDone');
  assert.equal(completion.completed, true);
}

// ─────────────────────────────────────────────────────────────────────────────
// Part B — completionToFinalizeInput bridge to the lease state machine
// ─────────────────────────────────────────────────────────────────────────────
{
  const done = evaluateAuthorityCompletion({
    jobPlan: jobPlan(),
    execution: execResult({ status: 'done', receiptVerified: true }),
    gateDecision: gateDecision(),
    multiHost: SATISFIED_MULTI_HOST,
  });
  const bridge = completionToFinalizeInput(done, 'result-digest-1');
  assert.equal(bridge.receiptRequired, true, 'bridge: authority/DONE requires a receipt');
  assert.equal(bridge.receiptVerified, true);
  assert.equal(bridge.finalPolicySatisfied, true, 'bridge: completed -> finalPolicySatisfied');
  assert.equal(bridge.resultDigest, 'result-digest-1');

  const blocked = evaluateAuthorityCompletion({
    jobPlan: jobPlan({ multiHostPolicy: multiHostPolicy({ fullAuthorityDoneRequired: true, requiredHostVerdictCount: 2 }) }),
    execution: execResult({ status: 'done', receiptVerified: true }),
    gateDecision: gateDecision(),
  });
  const blockedBridge = completionToFinalizeInput(blocked, 'result-digest-2');
  assert.equal(blockedBridge.finalPolicySatisfied, false, 'bridge: incomplete job -> finalPolicySatisfied false (release, not complete)');
  assert.equal(blockedBridge.releaseReason, 'multi_host_verification_incomplete');

  const local = evaluateAuthorityCompletion({
    jobPlan: jobPlan({ mode: 'local' }),
    execution: execResult({ mode: 'local', status: 'done' }),
  });
  const localBridge = completionToFinalizeInput(local, 'rd');
  assert.equal(localBridge.receiptRequired, false, 'bridge: local job requires no receipt');
  assert.equal(localBridge.finalPolicySatisfied, true);
}

// ─────────────────────────────────────────────────────────────────────────────
// Part C — runAuthorityCompletionLoop end-to-end against a fake Authority server
// ─────────────────────────────────────────────────────────────────────────────

type NativeReceipt = {
  receiptId: string;
  kind: string;
  projectId: string;
  storyId: string;
  actorId: string;
  role: string;
  stateVersion: number;
  policyVersion: string;
  inputDigest: string;
  decisionDigest?: string;
  issuedAt: string;
  serverKeyId: string;
  signature?: string;
};

function signedReceipt(
  over: Partial<NativeReceipt> = {},
  keypair = generateEd25519KeyPair(),
): { receipt: NativeReceipt; serverPublicKeyHex: string } {
  const base: NativeReceipt = {
    receiptId: 'rcpt-loop-1',
    kind: 'gate_decision',
    projectId: 'project-1',
    storyId: 'B-auth',
    actorId: 'lattice-authority-server',
    role: 'server',
    stateVersion: 1,
    policyVersion: 'policy-v1',
    inputDigest: 'input-digest-1',
    decisionDigest: 'dd-1',
    issuedAt: FIXED_NOW.toISOString(),
    serverKeyId: 'server-key-1',
    ...over,
  };
  const signature = Buffer.from(signCanonical(stripSignature(base), keypair.privateKey), 'base64').toString('hex');
  return { receipt: { ...base, signature }, serverPublicKeyHex: Buffer.from(keypair.publicKey, 'base64').toString('hex') };
}

function gateInputDigestFromEvaluateBody(body: any): string {
  return typeof body?.gateInputDigest === 'string'
    ? body.gateInputDigest
    : typeof body?.decision?.decisionId === 'string'
      ? body.decision.decisionId
      : '';
}

function normalizePythonDigestJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(normalizePythonDigestJson).filter(item => item !== undefined);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
      const normalized = normalizePythonDigestJson(item);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }
  return String(value);
}

function receiptInputDigestFromEvaluateBody(body: any): string {
  const decision = { ...(body?.decision ?? {}) };
  const repo = decision.repo;
  if (repo && typeof repo === 'object') {
    const raw = repo as Record<string, unknown>;
    decision.repo = {
      headHash: raw.headHash,
      materialHash: raw.materialHash,
      baseHash: raw.baseHash ?? null,
      treeHash: raw.treeHash ?? null,
      diffHash: raw.diffHash ?? null,
      manifestHash: raw.manifestHash ?? null,
      dirty: raw.dirty ?? false,
    };
  }
  return createHash('sha256')
    .update(JSON.stringify(normalizePythonDigestJson(decision)), 'utf8')
    .digest('hex');
}

function dynamicApprove(): {
  serverPublicKeyHex: string;
  evaluate: { status: number; body: (requestBody: any) => unknown };
  lastReceipt: () => NativeReceipt | undefined;
  lastGateInputDigest: () => string | undefined;
} {
  const keypair = generateEd25519KeyPair();
  let latestReceipt: NativeReceipt | undefined;
  let latestGateInputDigest: string | undefined;
  return {
    serverPublicKeyHex: Buffer.from(keypair.publicKey, 'base64').toString('hex'),
    evaluate: {
      status: 200,
      body: (requestBody: any) => {
        const gateInputDigest = gateInputDigestFromEvaluateBody(requestBody);
        const { receipt } = signedReceipt({ inputDigest: receiptInputDigestFromEvaluateBody(requestBody) }, keypair);
        latestReceipt = receipt;
        latestGateInputDigest = gateInputDigest;
        return { decision: 'approve', decisionDigest: receipt.decisionDigest, gateInputDigest, receipt };
      },
    },
    lastReceipt: () => latestReceipt,
    lastGateInputDigest: () => latestGateInputDigest,
  };
}

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
    evidenceBinding: `B-auth:${stepId}`,
    args: { operation: type },
    ...extra,
  };
}

function loopJobPlan(over: Partial<JobPlan> = {}): JobPlan {
  return jobPlan({
    plannedSteps: [
      step('step-fake', 'provider.fake'),
      step('step-validate', 'validate.run', { validationBinding: 'step-validate' }),
      step('step-gate', 'gate.evaluate'),
      step('step-stop', 'stop.summary'),
    ],
    coverageMap: [{
      checklistItemId: 'CHK-001',
      verificationIntentDigest: 'vid-1',
      plannedStepIds: ['step-fake'],
      validationStepIds: ['step-validate'],
      evidenceRefs: ['B-auth:step-validate'],
      expectedArtifacts: [],
      gatePredicate: 'validate.pass',
    }],
    jobCreateRequest: {
      projectId: 'project-1',
      storyId: 'B-auth',
      plannerRunId: 'prun-1',
      plannedSteps: [],
      mode: 'authority',
    },
    providerPolicy: {
      primaryProvider: 'fake',
      allowedProviders: ['fake'],
      fallbackProviders: [],
      productionDoneProviders: [],
      allowFakeProviderForProductionDone: false,
      credentialsEnvAllowlist: [],
      providerAvailability: 'fail_closed',
    } as unknown as JobPlan['providerPolicy'],
    ...over,
  });
}

function loopStore(phase = 'TEST'): PlannerStoreLike {
  return {
    readStory: (storyId: string): StoryInfo => ({ storyId, phase } as unknown as StoryInfo),
    storyExists: () => true,
    listStoryIds: () => ['B-auth'],
    appendProcessEvent: () => {},
  };
}

function approveEnv(serverPublicKeyHex: string): Record<string, string | undefined> {
  return {
    LATTICE_AUTHORITY_MODE: 'enforce',
    LATTICE_AUTHORITY_URL: 'https://authority.test',
    LATTICE_AUTHORITY_CUSTOMER_API_KEY: 'customer-key-canary',
    LATTICE_AUTHORITY_SERVER_PUBLIC_KEY: serverPublicKeyHex,
    LATTICE_AUTHORITY_SERVER_PUBLIC_KEY_ENCODING: 'hex',
    LATTICE_AUTHORITY_SERVER_KEY_ID: 'server-key-1',
    LATTICE_AUTHORITY_PROJECT_ID: 'project-1',
    LATTICE_AUTHORITY_ACTOR_ID: 'lattice-runner-completion',
    LATTICE_AUTHORITY_ACTOR_ROLE: 'runner',
    LATTICE_AUTHORITY_ACTOR_KEY: runnerActorKeypair.privateKey,
    LATTICE_AUTHORITY_ACTOR_KEY_ENCODING: 'base64',
    LATTICE_AUTHORITY_GATE_ACTOR_ID: 'lattice-main-completion',
    LATTICE_AUTHORITY_GATE_ACTOR_ROLE: 'main',
    LATTICE_AUTHORITY_GATE_ACTOR_KEY: gateActorKeypair.privateKey,
    LATTICE_AUTHORITY_GATE_ACTOR_KEY_ENCODING: 'base64',
  };
}

function serverFetch(opts: {
  evaluate: { status: number; body: unknown | ((requestBody: any) => unknown) };
  receipt?: { status: number; body: unknown };
  /** GET /v1/jobs/{jobId}/verdicts — multi-host verdict reconciliation list. */
  verdicts?: { status: number; body: unknown | (() => unknown) };
  counts?: { events: number; evidence: number; evaluate: number; verdicts?: number };
}): AuthorityFetch {
  const ok = (s: number) => s >= 200 && s < 300;
  return async (input, init) => {
    const url = String(input);
    if (url.endsWith('/events') && init.method === 'POST') {
      if (opts.counts) opts.counts.events += 1;
      return { ok: true, status: 200, text: async () => '' };
    }
    if (url.includes('/v1/evidence/batch') && init.method === 'POST') {
      if (opts.counts) opts.counts.evidence += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ accepted: true, results: [{ accepted: true }] }) };
    }
    if (url.includes('/v1/gates/evaluate') && init.method === 'POST') {
      if (opts.counts) opts.counts.evaluate += 1;
      const requestBody = init.body ? JSON.parse(String(init.body)) : {};
      const body = typeof opts.evaluate.body === 'function' ? opts.evaluate.body(requestBody) : opts.evaluate.body;
      return { ok: ok(opts.evaluate.status), status: opts.evaluate.status, text: async () => JSON.stringify(body) };
    }
    if (url.includes('/verdicts') && init.method === 'GET') {
      if (opts.counts) opts.counts.verdicts = (opts.counts.verdicts ?? 0) + 1;
      const v = opts.verdicts ?? { status: 404, body: {} };
      const body = typeof v.body === 'function' ? v.body() : v.body;
      return { ok: ok(v.status), status: v.status, text: async () => JSON.stringify(body) };
    }
    if (url.includes('/v1/receipts/') && init.method === 'GET') {
      const r = opts.receipt ?? { status: 404, body: {} };
      return { ok: ok(r.status), status: r.status, text: async () => JSON.stringify(r.body) };
    }
    throw Object.assign(new Error(`unexpected fetch ${init.method} ${url}`), { code: 'EUNEXPECTED' });
  };
}

/** A minimal server-stored host_verdict record (passthrough fields like checkedReceiptId allowed). */
function hostVerdictRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  const verdictId = typeof over.verdictId === 'string' ? over.verdictId : 'hv-1';
  const merged = {
    kind: 'host_verdict',
    verdictId,
    jobId: 'jpd',
    runId: 'prun-1',
    storyId: 'B-auth',
    hostId: 'host-a',
    provider: 'codex',
    role: 'verifier',
    decision: 'pass',
    independent: true,
    issuedAt: FIXED_NOW.toISOString(),
    checkedReceiptId: 'rcpt-loop-1',
    reviewWaveId: 'wave-1',
    signature: FAKE_HOST_VERDICT_SIGNATURE,
    ...over,
  } as Record<string, unknown> & Parameters<typeof buildFinalHostReviewPromptDigestInput>[0];
  return {
    ...merged,
    reviewPromptProfile: merged.reviewPromptProfile ?? FINAL_HOST_REVIEW_PROMPT_PROFILE,
    reviewPromptDigest: merged.reviewPromptDigest ?? canonicalDigest(buildFinalHostReviewPromptDigestInput(merged)),
  };
}

const noNetworkFetch: AuthorityFetch = async (input, init) => {
  throw Object.assign(new Error(`network must not be called: ${init.method} ${String(input)}`), { code: 'ENONET' });
};

// INT1: authority/DONE, verified approve, no multi-host verdicts -> per-run
// authorityDone only; fullAuthorityDone remains blocked.
{
  const approve = dynamicApprove();
  const counts = { events: 0, evidence: 0, evaluate: 0, verdicts: 0 };
  const result = await runAuthorityCompletionLoop({
    root: '/tmp/x',
    store: loopStore(),
    jobPlan: loopJobPlan(),
    env: approveEnv(approve.serverPublicKeyHex),
    now: () => FIXED_NOW,
    fetchImpl: serverFetch({ evaluate: approve.evaluate, counts }),
  });
  assert.equal(counts.events, 3, 'INT1 run events appended before the gate: two evidence refs plus the execution summary');
  assert.equal(counts.evidence, 1, 'INT1 evidence batch uploaded before the gate');
  assert.equal(counts.evaluate, 1, 'INT1 /v1/gates/evaluate called automatically');
  assert.equal(result.execution.status, 'done', 'INT1 executor completes on verified approve');
  assert.equal(result.completion.authorityDone, true, 'INT1 authorityDone on verified receipt + completed run');
  assert.equal(result.completion.fullAuthorityDone, false, 'INT1 no host verdicts -> no fullAuthorityDone');
  assert.equal(result.completion.completed, false);
  assert.equal(result.completion.multiHostRequired, true);
  assert.equal(result.completion.blockingReasons[0], 'multi_host_verification_incomplete');
  assert.equal(result.finalOutput.receiptVerified, true);
  assert.equal(result.finalOutput.authorityDone, true);
  assert.equal(result.finalOutput.fullAuthorityDone, false);
  assert.equal(result.finalOutput.gateConfigured, true);
  assert.equal(result.finalOutput.receiptRefs.length, 1, 'INT1 receipt ref recorded');
  assert.equal(result.finalOutput.receiptRefs[0]?.verified, true);
  assert.equal(result.finalOutput.decisionDigest, approve.lastReceipt()?.decisionDigest);
  assert.equal(result.finalOutput.schemaVersion, 'lattice.authority_job_completion.v1');
  assert.equal(result.finalOutput.jobId, result.execution.plannedStepsDigest ? loopJobPlan().jobPlanDigest : undefined);
}

// INT1r: root-scoped authority.md supplies the gate config and relative key paths.
{
  const approve = dynamicApprove();
  const counts = { events: 0, evidence: 0, evaluate: 0 };
  const mdRoot = mkdtempSync(join(tmpdir(), 'lattice-completion-md-root-'));
  try {
    mkdirSync(join(mdRoot, '.lattice', 'secrets'), { recursive: true });
    writeFileSync(join(mdRoot, '.lattice', 'secrets', 'runner.key'), runnerActorKeypair.privateKey);
    writeFileSync(join(mdRoot, '.lattice', 'secrets', 'gate.key'), gateActorKeypair.privateKey);
    writeFileSync(join(mdRoot, '.lattice', 'secrets', 'customer.key'), 'md-customer-key\n');
    writeFileSync(join(mdRoot, '.lattice', 'authority.md'), [
      'serverUrl: https://authority-md-completion.test',
      'projectId: project-1',
      'actorId: lattice-runner-completion',
      'actorRole: runner',
      'actorKeyPath: .lattice/secrets/runner.key',
      'actorKeyEncoding: base64',
      'customerApiKeyPath: .lattice/secrets/customer.key',
      'serverKeyId: server-key-1',
      `serverPublicKey: ${approve.serverPublicKeyHex}`,
      'serverPublicKeyEncoding: hex',
    ].join('\n'));
    const result = await runAuthorityCompletionLoop({
      root: mdRoot,
      store: loopStore(),
      jobPlan: loopJobPlan(),
      env: {
        LATTICE_AUTHORITY_MODE: 'enforce',
        LATTICE_AUTHORITY_GATE_ACTOR_ID: 'lattice-main-completion',
        LATTICE_AUTHORITY_GATE_ACTOR_ROLE: 'main',
        LATTICE_AUTHORITY_GATE_ACTOR_KEY_PATH: '.lattice/secrets/gate.key',
        LATTICE_AUTHORITY_GATE_ACTOR_KEY_ENCODING: 'base64',
      },
      now: () => FIXED_NOW,
      fetchImpl: serverFetch({ evaluate: approve.evaluate, counts }),
    });
    assert.equal(counts.evaluate, 1, 'INT1r completion loop resolves authority.md from options.root');
    assert.equal(result.completion.authorityDone, true, 'INT1r root-scoped authority.md verifies the gate receipt');
  } finally {
    rmSync(mdRoot, { recursive: true, force: true });
  }
}

// INT2: verified approve but multi-host REQUIRED -> blocked until reconciliation supplied.
{
  const approve = dynamicApprove();
  const plan = loopJobPlan({ multiHostPolicy: multiHostPolicy({ fullAuthorityDoneRequired: true, requiredHostVerdictCount: 2 }) });

  const blocked = await runAuthorityCompletionLoop({
    root: '/tmp/x', store: loopStore(), jobPlan: plan, env: approveEnv(approve.serverPublicKeyHex), now: () => FIXED_NOW,
    fetchImpl: serverFetch({ evaluate: approve.evaluate }),
  });
  assert.equal(blocked.completion.authorityDone, true, 'INT2 per-run authorityDone holds');
  assert.equal(blocked.completion.fullAuthorityDone, false, 'INT2 fullAuthorityDone fails closed without multi-host');
  assert.equal(blocked.completion.completed, false, 'INT2 job does not complete without multi-host');
  assert.equal(blocked.finalOutput.stopReason, 'multi_host_verification_incomplete');

  const priorReceipt = approve.lastReceipt();
  assert(priorReceipt, 'INT2 blocked run issued a verified gate receipt before multi-host');
  const completed = await runAuthorityCompletionLoop({
    root: '/tmp/x', store: loopStore(), jobPlan: plan, env: approveEnv(approve.serverPublicKeyHex), now: () => FIXED_NOW,
    fetchImpl: serverFetch({ evaluate: approve.evaluate }),
    multiHost: {
      ...SATISFIED_MULTI_HOST,
      checkedReceiptId: priorReceipt.receiptId,
      checkedGateInputDigest: priorReceipt.inputDigest,
    },
  });
  assert.equal(completed.completion.fullAuthorityDone, true, `INT2 fullAuthorityDone once reconciliation satisfied: ${JSON.stringify({
    completion: completed.completion,
    finalOutput: completed.finalOutput,
    priorReceiptId: priorReceipt.receiptId,
    priorReceiptInputDigest: priorReceipt.inputDigest,
    latestGateInputDigest: approve.lastGateInputDigest(),
  })}`);
  assert.equal(completed.completion.completed, true);
  assert.equal(completed.finalOutput.multiHostVerified, true);
  assert.equal(completed.finalOutput.hostVerdictRefs.length, 6);
}

// INT2q: multi-host REQUIRED, NO injected reconciliation -> the loop QUERIES the
// Authority verdict reconciliation itself and wires it into fullAuthorityDone.
{
  const approve = dynamicApprove();
  const plan = loopJobPlan({ multiHostPolicy: multiHostPolicy({ fullAuthorityDoneRequired: true, requiredHostVerdictCount: 2 }) });
  const checkedGate = (): string => approve.lastReceipt()?.inputDigest ?? 'missing-gate-input';

  // Server reconciliation SATISFIED for only one wave still blocks fullAuthorityDone.
  const counts = { events: 0, evidence: 0, evaluate: 0, verdicts: 0 };
  const oneWave = await runAuthorityCompletionLoop({
    root: '/tmp/x', store: loopStore(), jobPlan: plan, env: approveEnv(approve.serverPublicKeyHex), now: () => FIXED_NOW,
    fetchImpl: serverFetch({
      evaluate: approve.evaluate, counts,
      verdicts: { status: 200, body: () => ({
        jobId: 'jpd', runId: 'prun-1',
        verdicts: [
          hostVerdictRecord({ checkedGateInputDigest: checkedGate() }),
          hostVerdictRecord({ verdictId: 'hv-2', hostId: 'host-b', provider: 'claude', checkedGateInputDigest: checkedGate() }),
        ],
        reconciliation: { independentHostCount: 2, requiredHostCount: 2, passingIndependentHostCount: 2, failingIndependentHostCount: 0, satisfiedReviewWaveCount: 1, requiredReviewWaveCount: 3, reviewWaveRefs: ['wave-1'], satisfied: true },
      }) },
    }),
  });
  assert.equal(counts.verdicts, 1, 'INT2q the loop queried GET /v1/jobs/{jobId}/verdicts exactly once');
  assert.equal(oneWave.completion.authorityDone, true, 'INT2q one-wave: per-run authorityDone holds');
  assert.equal(oneWave.completion.fullAuthorityDone, false, 'INT2q one wave does not satisfy fullAuthorityDone');
  assert.equal(oneWave.completion.completed, false, 'INT2q one wave keeps job blocked');
  assert.equal(oneWave.finalOutput.multiHostVerified, false);
  assert.ok(oneWave.finalOutput.multiHostBlockedReason?.includes('insufficient_review_waves'), 'INT2q one-wave block names missing review waves');

  // Server reconciliation SATISFIED for all three waves completes fullAuthorityDone.
  const satisfied = await runAuthorityCompletionLoop({
    root: '/tmp/x', store: loopStore(), jobPlan: plan, env: approveEnv(approve.serverPublicKeyHex), now: () => FIXED_NOW,
    fetchImpl: serverFetch({
      evaluate: approve.evaluate,
      verdicts: { status: 200, body: () => ({
        jobId: 'jpd', runId: 'prun-1',
        verdicts: [
          hostVerdictRecord({ verdictId: 'hv-1', reviewWaveId: 'wave-1', hostId: 'host-a', provider: 'codex', checkedGateInputDigest: checkedGate() }),
          hostVerdictRecord({ verdictId: 'hv-2', reviewWaveId: 'wave-1', hostId: 'host-b', provider: 'claude', checkedGateInputDigest: checkedGate() }),
          hostVerdictRecord({ verdictId: 'hv-3', reviewWaveId: 'wave-2', hostId: 'host-a', provider: 'codex', checkedGateInputDigest: checkedGate() }),
          hostVerdictRecord({ verdictId: 'hv-4', reviewWaveId: 'wave-2', hostId: 'host-c', provider: 'antigravity', checkedGateInputDigest: checkedGate() }),
          hostVerdictRecord({ verdictId: 'hv-5', reviewWaveId: 'wave-3', hostId: 'host-b', provider: 'claude', checkedGateInputDigest: checkedGate() }),
          hostVerdictRecord({ verdictId: 'hv-6', reviewWaveId: 'wave-3', hostId: 'host-c', provider: 'antigravity', checkedGateInputDigest: checkedGate() }),
        ],
        reconciliation: { independentHostCount: 2, requiredHostCount: 2, passingIndependentHostCount: 2, failingIndependentHostCount: 0, satisfiedReviewWaveCount: 3, requiredReviewWaveCount: 3, reviewWaveRefs: ['wave-1', 'wave-2', 'wave-3'], satisfied: true },
      }) },
    }),
  });
  assert.equal(satisfied.completion.authorityDone, true, 'INT2q three-wave: per-run authorityDone holds');
  assert.equal(satisfied.completion.fullAuthorityDone, true, 'INT2q queried three satisfied waves -> fullAuthorityDone');
  assert.equal(satisfied.completion.completed, true, 'INT2q job completes on queried three-wave reconciliation');
  assert.equal(satisfied.finalOutput.multiHostVerified, true);
  assert.equal(satisfied.finalOutput.requiredHostVerdictCount, 2);
  assert.equal(satisfied.finalOutput.requiredReviewWaveCount, 3);
  assert.equal(satisfied.finalOutput.satisfiedReviewWaveCount, 3);
  assert.equal(satisfied.finalOutput.independentHostVerdictCount, 2, 'INT2q surfaces the queried independent count');
  assert.deepEqual(satisfied.finalOutput.hostVerdictRefs, ['hv-1', 'hv-2', 'hv-3', 'hv-4', 'hv-5', 'hv-6'], 'INT2q surfaces the queried host verdict refs');
  assert.equal(satisfied.finalOutput.multiHostBlockedReason, undefined, 'INT2q no blocked reason on three satisfied waves');

  // A server-reported satisfied reconciliation is not enough if verdicts are bound
  // to the wrong gate input digest; those verdicts belong to a stale/different run.
  const wrongGateDigest = await runAuthorityCompletionLoop({
    root: '/tmp/x', store: loopStore(), jobPlan: plan, env: approveEnv(approve.serverPublicKeyHex), now: () => FIXED_NOW,
    fetchImpl: serverFetch({
      evaluate: approve.evaluate,
      verdicts: { status: 200, body: () => ({
        jobId: 'jpd', runId: 'prun-1',
        verdicts: [
          hostVerdictRecord({ verdictId: 'hv-w1', reviewWaveId: 'wave-1', hostId: 'host-a', provider: 'codex', checkedGateInputDigest: 'sha256:wrong-gate-input' }),
          hostVerdictRecord({ verdictId: 'hv-w2', reviewWaveId: 'wave-1', hostId: 'host-b', provider: 'claude', checkedGateInputDigest: 'sha256:wrong-gate-input' }),
          hostVerdictRecord({ verdictId: 'hv-w3', reviewWaveId: 'wave-2', hostId: 'host-a', provider: 'codex', checkedGateInputDigest: 'sha256:wrong-gate-input' }),
          hostVerdictRecord({ verdictId: 'hv-w4', reviewWaveId: 'wave-2', hostId: 'host-c', provider: 'antigravity', checkedGateInputDigest: 'sha256:wrong-gate-input' }),
          hostVerdictRecord({ verdictId: 'hv-w5', reviewWaveId: 'wave-3', hostId: 'host-b', provider: 'claude', checkedGateInputDigest: 'sha256:wrong-gate-input' }),
          hostVerdictRecord({ verdictId: 'hv-w6', reviewWaveId: 'wave-3', hostId: 'host-c', provider: 'antigravity', checkedGateInputDigest: 'sha256:wrong-gate-input' }),
        ],
        reconciliation: { independentHostCount: 2, requiredHostCount: 2, passingIndependentHostCount: 2, failingIndependentHostCount: 0, satisfiedReviewWaveCount: 3, requiredReviewWaveCount: 3, reviewWaveRefs: ['wave-1', 'wave-2', 'wave-3'], satisfied: true },
      }) },
    }),
  });
  assert.equal(wrongGateDigest.completion.authorityDone, true, 'INT2q wrong-gate digest: per-run authorityDone still holds');
  assert.equal(wrongGateDigest.completion.fullAuthorityDone, false, 'INT2q wrong-gate digest verdicts cannot certify fullAuthorityDone');
  assert.equal(wrongGateDigest.finalOutput.multiHostVerified, false);
  assert.match(wrongGateDigest.finalOutput.multiHostBlockedReason ?? '', /stale_review_wave_after_repair|insufficient_review_waves/, 'INT2q wrong-gate digest verdicts are filtered as stale/different wave evidence');

  // A server-reported three-wave reconciliation is not enough when each wave only
  // contains repeated same-host verdict records.
  const repeated = await runAuthorityCompletionLoop({
    root: '/tmp/x', store: loopStore(), jobPlan: plan, env: approveEnv(approve.serverPublicKeyHex), now: () => FIXED_NOW,
    fetchImpl: serverFetch({
      evaluate: approve.evaluate,
      verdicts: { status: 200, body: () => ({
        jobId: 'jpd', runId: 'prun-1',
        verdicts: [
          hostVerdictRecord({ verdictId: 'hv-r1', reviewWaveId: 'wave-1', hostId: 'host-a', checkedGateInputDigest: checkedGate() }),
          hostVerdictRecord({ verdictId: 'hv-r2', reviewWaveId: 'wave-1', hostId: 'host-a', checkedGateInputDigest: checkedGate() }),
          hostVerdictRecord({ verdictId: 'hv-r3', reviewWaveId: 'wave-2', hostId: 'host-a', checkedGateInputDigest: checkedGate() }),
          hostVerdictRecord({ verdictId: 'hv-r4', reviewWaveId: 'wave-2', hostId: 'host-a', checkedGateInputDigest: checkedGate() }),
          hostVerdictRecord({ verdictId: 'hv-r5', reviewWaveId: 'wave-3', hostId: 'host-a', checkedGateInputDigest: checkedGate() }),
          hostVerdictRecord({ verdictId: 'hv-r6', reviewWaveId: 'wave-3', hostId: 'host-a', checkedGateInputDigest: checkedGate() }),
        ],
        reconciliation: { independentHostCount: 2, requiredHostCount: 2, passingIndependentHostCount: 2, failingIndependentHostCount: 0, satisfiedReviewWaveCount: 3, requiredReviewWaveCount: 3, reviewWaveRefs: ['wave-1', 'wave-2', 'wave-3'], satisfied: true },
      }) },
    }),
  });
  assert.equal(repeated.completion.fullAuthorityDone, false, 'INT2q repeated same-host waves do not satisfy fullAuthorityDone');
  assert.equal(repeated.finalOutput.multiHostVerified, false, 'INT2q repeated same-host waves do not satisfy multiHostVerified');
  assert.ok(repeated.finalOutput.multiHostBlockedReason?.includes('insufficient_review_waves'), 'INT2q repeated-host block names unsatisfied waves');

  // Server reconciliation reports a FAILING host -> disagreement blocks fullAuthorityDone.
  const disagree = await runAuthorityCompletionLoop({
    root: '/tmp/x', store: loopStore(), jobPlan: plan, env: approveEnv(approve.serverPublicKeyHex), now: () => FIXED_NOW,
    fetchImpl: serverFetch({
      evaluate: approve.evaluate,
      verdicts: { status: 200, body: () => ({
        jobId: 'jpd', runId: 'prun-1',
        verdicts: [hostVerdictRecord({ decision: 'fail', checkedGateInputDigest: checkedGate() })],
        reconciliation: { independentHostCount: 2, requiredHostCount: 2, passingIndependentHostCount: 1, failingIndependentHostCount: 1, satisfied: false },
      }) },
    }),
  });
  assert.equal(disagree.completion.authorityDone, true, 'INT2q disagreement: per-run authorityDone still holds');
  assert.equal(disagree.completion.fullAuthorityDone, false, 'INT2q a failing host blocks fullAuthorityDone');
  assert.equal(disagree.completion.completed, false, 'INT2q job does not complete on disagreement');
  assert.equal(disagree.finalOutput.stopReason, 'multi_host_verification_incomplete');
  assert.ok(
    disagree.finalOutput.multiHostBlockedReason?.includes('multi_host_disagreement'),
    'INT2q surfaces the specific disagreement reason in JSON output',
  );

  // Multi-host required but NO server backing (authority mode off) -> fails closed with
  // a machine-readable unavailable reason; zero verdict network attempt is harmless.
  const unavailable = await runAuthorityCompletionLoop({
    root: '/tmp/x', store: loopStore(), jobPlan: plan,
    // mode off -> verdict backing resolves to local, so no server query is possible.
    env: { ...approveEnv(approve.serverPublicKeyHex), LATTICE_AUTHORITY_MODE: 'off' },
    now: () => FIXED_NOW,
    // gate also fails closed (no round-trip); the loop must not touch the network.
    fetchImpl: noNetworkFetch,
  });
  assert.equal(unavailable.completion.fullAuthorityDone, false, 'INT2q no backing -> fullAuthorityDone fails closed');
  assert.ok(
    unavailable.finalOutput.multiHostBlockedReason?.includes('multi_host_reconciliation_unavailable'),
    'INT2q names the reconciliation-unavailable reason when no server backing exists',
  );
}

// INT3: no authority config -> fail closed, zero network, no DONE.
{
  const result = await runAuthorityCompletionLoop({
    root: '/tmp/x', store: loopStore(), jobPlan: loopJobPlan(),
    env: { LATTICE_AUTHORITY_URL: 'https://authority.test' }, // mode unset -> off
    now: () => FIXED_NOW,
    fetchImpl: noNetworkFetch,
  });
  assert.equal(result.resolution.configured, false, 'INT3 no gate round-trip without authority config');
  assert.equal(result.execution.stopReason, 'authority_gate_decision_receipt_required', 'INT3 executor fails closed at the gate');
  assert.equal(result.completion.completed, false);
  assert.equal(result.completion.authorityDone, false);
  assert.equal(result.completion.blockingReasons[0], 'authority_gate_decision_receipt_required');
  assert.equal(result.finalOutput.gateConfigured, false);
}

// INT4: local job -> zero network, never authority DONE, completes on validation.
{
  const result = await runAuthorityCompletionLoop({
    root: '/tmp/x', store: loopStore('DONE'),
    jobPlan: loopJobPlan({ mode: 'local' }),
    env: approveEnv('00'.repeat(32)),
    now: () => FIXED_NOW,
    fetchImpl: noNetworkFetch, // must not be called for a local job
  });
  assert.equal(result.resolution.configured, false, 'INT4 local job runs no authority gate');
  assert.equal(result.completion.authorityDone, false, 'INT4 local never authorityDone');
  assert.equal(result.completion.completed, true, 'INT4 local completes on validation');
  assert.equal(result.finalOutput.gateConfigured, false);
}

// INT5: server reject -> fail closed end to end.
{
  const result = await runAuthorityCompletionLoop({
    root: '/tmp/x', store: loopStore(), jobPlan: loopJobPlan(), env: approveEnv('00'.repeat(32)), now: () => FIXED_NOW,
    fetchImpl: serverFetch({ evaluate: { status: 200, body: { decision: 'reject', reason: 'validation evidence insufficient' } } }),
  });
  assert.equal(result.completion.completed, false, 'INT5 reject fails closed');
  assert.equal(result.completion.authorityDone, false);
  assert.equal(result.completion.blockingReasons[0], 'authority_gate_decision_rejected');
  assert.equal(result.finalOutput.receiptVerified, false);
}

// INT6: tampered receipt -> fail closed end to end.
{
  const { receipt, serverPublicKeyHex } = signedReceipt();
  const tampered = { ...receipt, decisionDigest: 'tampered' }; // signature no longer matches
  const result = await runAuthorityCompletionLoop({
    root: '/tmp/x', store: loopStore(), jobPlan: loopJobPlan(), env: approveEnv(serverPublicKeyHex), now: () => FIXED_NOW,
    fetchImpl: serverFetch({ evaluate: { status: 200, body: { decision: 'approve', decisionDigest: 'tampered', receipt: tampered } } }),
  });
  assert.equal(result.completion.completed, false, 'INT6 tampered receipt fails closed');
  assert.equal(result.completion.authorityDone, false);
  assert.equal(result.completion.blockingReasons[0], 'authority_gate_receipt_unverified');
}

// INT7: future-dated receipt -> fail closed end to end (clock-skew binding).
{
  const { receipt, serverPublicKeyHex } = signedReceipt({ issuedAt: '2030-01-01T00:00:00.000Z' });
  const result = await runAuthorityCompletionLoop({
    root: '/tmp/x', store: loopStore(), jobPlan: loopJobPlan(), env: approveEnv(serverPublicKeyHex), now: () => FIXED_NOW,
    fetchImpl: serverFetch({ evaluate: { status: 200, body: { decision: 'approve', decisionDigest: receipt.decisionDigest, receipt } } }),
  });
  assert.equal(result.completion.completed, false, 'INT7 future-dated receipt fails closed');
  assert.equal(result.completion.blockingReasons[0], 'authority_gate_receipt_unverified');
}

// INT8: stale receipt -> fail closed end to end (freshness binding).
{
  const { receipt, serverPublicKeyHex } = signedReceipt({ issuedAt: '2026-06-05T00:00:00.000Z' });
  const result = await runAuthorityCompletionLoop({
    root: '/tmp/x', store: loopStore(), jobPlan: loopJobPlan(), env: approveEnv(serverPublicKeyHex), now: () => FIXED_NOW,
    fetchImpl: serverFetch({ evaluate: { status: 200, body: { decision: 'approve', decisionDigest: receipt.decisionDigest, receipt } } }),
  });
  assert.equal(result.completion.completed, false, 'INT8 stale receipt fails closed');
  assert.equal(result.completion.blockingReasons[0], 'authority_gate_receipt_unverified');
}

// INT9: wrong story binding -> fail closed end to end (binding mismatch).
{
  const { receipt, serverPublicKeyHex } = signedReceipt({ storyId: 'B-other' });
  const result = await runAuthorityCompletionLoop({
    root: '/tmp/x', store: loopStore(), jobPlan: loopJobPlan(), env: approveEnv(serverPublicKeyHex), now: () => FIXED_NOW,
    fetchImpl: serverFetch({ evaluate: { status: 200, body: { decision: 'approve', decisionDigest: receipt.decisionDigest, receipt } } }),
  });
  assert.equal(result.completion.completed, false, 'INT9 wrong-story receipt fails closed');
  assert.equal(result.completion.authorityDone, false);
  assert.equal(result.completion.blockingReasons[0], 'authority_gate_receipt_unverified');
}

console.log(PASS_LINE);
