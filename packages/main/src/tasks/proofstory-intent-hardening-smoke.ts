#!/usr/bin/env node
/**
 * Focused smoke coverage for ProofStory progressive intent hardening.
 *
 * @task B-3b99
 * @checklist CHK-003
 * @title Smoke ProofStory key requirement and source requirement binding
 * @type test
 * @priority high
 * @description
 *   Smoke-backed evidence for legacy spellings keyRequirements,
 *   originalIntentSnapshot.keyRequirements, and sourceRequirementId. The test
 *   creates an original intent snapshot with keyRequirementIds: ["REQ-001"],
 *   stores milestone rows with sourceRequirementId: "REQ-001", checks request
 *   hash stability, and verifies diagnostics reject unbound milestone sources.
 * @changes
 *   - [CHK-003] Assert keyRequirementIds participate in the original intent request hash.
 *   - [CHK-003] Assert sourceRequirementId rows are accepted only when bound to original intent keyRequirementIds.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import {
  canSendStoryEventWithoutSnapshotCan,
  getGuardFailureReason,
} from '../core/machine.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo, StoryPhase, StorySummaryData } from '../core/types.js';
import { computeIntentRequestHash } from '../core/proofstory.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');
const sessionEnv = {
  ...process.env,
  LATTICE_SESSION_ID: 'proofstory-intent-hardening-smoke',
  LATTICE_AGENT: 'proofstory-intent-hardening-smoke',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf8');
}

function run(root: string, command: string, args: Record<string, unknown>, allowFailure = false): string {
  try {
    return execFileSync(process.execPath, [cliPath, '--root', root, command, JSON.stringify(args)], {
      cwd: root,
      env: sessionEnv,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error: any) {
    const text = String(error.stdout || '') + String(error.stderr || '') + String(error.message || '');
    if (allowFailure) return text;
    throw new Error(text);
  }
}

function jsonRun<T = any>(root: string, command: string, args: Record<string, unknown>): T {
  return JSON.parse(run(root, command, { ...args, json: true })) as T;
}

function writeLifecycleGateBlockedStory(store: StoryStore, storyId: string, phase: Extract<StoryPhase, 'REVIEW' | 'TEST'>): void {
  const now = new Date().toISOString();
  store.writeStory(storyId, {
    storyId,
    name: `${storyId.toLowerCase()}-proofstory-reentry`,
    title: `${phase} ProofStory DEV re-entry smoke`,
    description: 'Fix a lifecycle gate regression with unclear code path and missing ProofStory intent artifacts.',
    type: 'bug',
    phase,
    priority: 'high',
    riskSignals: [{ category: 'state machine/gate', matched: 'lifecycle gate' }],
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase, action: 'advance', timestamp: now }],
  });
  store.writeChecklist(storyId, {
    items: [{
      id: 'CHK-001',
      title: 'Repair lifecycle gate regression',
      status: 'pending',
      startTime: null,
      endTime: null,
      verificationIntent: {
        happy: [{ desc: 'Regression is repaired', type: 'cli' }],
        edge: [],
        adversarial: [],
      },
    }],
  });
}

function assertDevAdmissionBlocked(root: string, store: StoryStore, storyId: string, currentPhase: Extract<StoryPhase, 'PLAN' | 'REVIEW' | 'TEST'>): void {
  assert.equal(store.readStory(storyId).phase, currentPhase, `${currentPhase}->DEV precondition`);
  assert.equal(
    canSendStoryEventWithoutSnapshotCan(storyId, store, currentPhase, 'START', root),
    false,
    `${currentPhase}->DEV machine helper blocks when proofStory.devGateMode=enforce and intent artifacts are incomplete`,
  );
  assert.match(
    getGuardFailureReason(storyId, store, 'DEV', root) ?? '',
    /ProofStory DEV gate is enforce|required intent artifacts are incomplete/,
    `${currentPhase}->DEV guard reason names the ProofStory DEV gate`,
  );
  assert.match(
    run(root, 'story_advance', { storyId, phase: 'DEV' }, true),
    /ProofStory DEV gate is enforce|required intent artifacts are incomplete/,
    `${currentPhase}->DEV lifecycle command blocks through story_advance`,
  );
  assert.equal(store.readStory(storyId).phase, currentPhase, `${currentPhase}->DEV block leaves phase unchanged`);
}

function makeSummary(storyId: string, overrides: Partial<StorySummaryData> = {}): StorySummaryData {
  const now = new Date().toISOString();
  return {
    storyId,
    changes: 'Delivered the requested outcome.',
    usage: 'Run the relevant lattice command.',
    expectedOutcome: 'The original request is satisfied.',
    actualTranscript: 'The requested outcome is present.',
    outcomeDiff: 'No difference.',
    acceptanceVerdict: 'accepted',
    realMachineCoverage: { ran: [], skipped: [] },
    limitations: 'None for smoke.',
    pitfalls: 'Smoke fixture.',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const root = mkdtempSync(join(tmpdir(), 'lattice-proofstory-'));
try {
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'proofstory@example.test']);
  git(root, ['config', 'user.name', 'ProofStory Smoke']);
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
    proofStory: { devGateMode: 'enforce' },
  }, null, 2));
  resetConfigCache();
  write(root, 'README.md', 'proofstory smoke\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);

  const store = new StoryStore(root);
  const storyId = 'B-proofstory';
  const story: StoryInfo = {
    storyId,
    name: 'proofstory-smoke',
    title: 'ProofStory smoke',
    description: 'Fix an auth lifecycle gate regression with unclear code path and all five milestones.',
    type: 'bug',
    phase: 'PLAN',
    priority: 'high',
    riskSignals: [{ category: 'state machine/gate', matched: 'lifecycle gate' }],
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    events: [],
  };
  const checklistItems = Array.from({ length: 5 }, (_, index) => {
    const n = index + 1;
    return {
      id: `CHK-00${n}`,
      title: `Deliver milestone ${n}`,
      status: 'pending' as const,
      startTime: null,
      endTime: null,
      verificationIntent: {
        happy: [{ desc: `Milestone ${n} succeeds`, type: 'cli' as const }],
        edge: n === 1 ? [{ desc: 'Milestone 6 optional edge is reviewed separately', type: 'cli' as const }] : [],
        adversarial: [],
      },
    };
  });
  const checklist: ChecklistData = { items: checklistItems };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  git(root, ['add', '.lattice']);
  git(root, ['commit', '-m', 'story metadata']);

  const observedWithoutDryRun = jsonRun(root, 'proofstory_gate_check', { storyId });
  assert.equal(observedWithoutDryRun.mode, 'observe', 'proofstory_gate_check defaults to observe mode without dryRun');

  let gate = jsonRun(root, 'proofstory_gate_check', { storyId, mode: 'observe' });
  assert.equal(gate.hardeningLevel, 'high_assurance', 'high-risk regression selects high assurance');
  assert.ok(gate.missingMvpArtifacts.some((gap: any) => gap.code === 'missing_original_intent_snapshot'), 'missing snapshot is reported');
  const planReview = JSON.parse(run(root, 'story_review', { storyId }));
  assert.ok(
    planReview.issues.some((issue: any) => issue.type === 'proofstory_advisory' && /missing_original_intent_snapshot/.test(issue.message)),
    'story_review surfaces ProofStory advisory diagnostics before DEV',
  );
  assert.match(
    planReview._reviewPrompt,
    /ProofStory Diagnostics \(advisory only\)[\s\S]*prompt text[\s\S]*do not satisfy gates/i,
    'story_review prompt explains ProofStory guidance without claiming prompt-only evidence satisfies gates',
  );
  assertDevAdmissionBlocked(root, store, storyId, 'PLAN');
  for (const phase of ['REVIEW', 'TEST'] as const) {
    const reentryStoryId = `B-proofstory-${phase.toLowerCase()}-reentry`;
    writeLifecycleGateBlockedStory(store, reentryStoryId, phase);
    assertDevAdmissionBlocked(root, store, reentryStoryId, phase);
  }

  const sourceText = [
    'Fix the auth lifecycle gate regression; the code path is unclear.',
    'Deliver all five milestones:',
    '1. original intent snapshot commands',
    '2. milestone ledger commands',
    '3. ProofStory contract diagnostics',
    '4. dry-run coverage diagnostics',
    '5. process fact verification',
  ].join('\n');
  const snapshot = jsonRun(root, 'original_intent_snapshot_set', {
    storyId,
    sourceText,
    normalizedOutcome: 'ProofStory M0-M2 diagnostics exist without lifecycle gate enforcement.',
    acceptanceClaim: 'Dry-run diagnostics report hardening level and all triggered gaps.',
    keyRequirementIds: ['REQ-001'],
  });
  assert.equal(
    snapshot.requestHash,
    computeIntentRequestHash(sourceText, ['REQ-001']),
    'requestHash is derived from sourceText and stable keyRequirementIds',
  );
  const storedSnapshot = jsonRun(root, 'original_intent_snapshot_get', { storyId });
  assert.equal(storedSnapshot.requestHash, snapshot.requestHash, 'original_intent_snapshot_get reads the stored snapshot');
  assert.equal(storedSnapshot.acceptanceClaim, snapshot.acceptanceClaim, 'snapshot get preserves the acceptance claim');
  assert.match(
    run(root, 'original_intent_snapshot_set', {
      storyId,
      sourceText: '',
      normalizedOutcome: 'Outcome is present.',
      acceptanceClaim: 'Acceptance is present.',
    }, true),
    /sourceText/i,
    'sourceText is required for the Intent MVP',
  );
  assert.match(
    run(root, 'original_intent_snapshot_set', {
      storyId,
      sourceText: 'Source text is present.',
      normalizedOutcome: '',
      acceptanceClaim: 'Acceptance is present.',
    }, true),
    /normalizedOutcome/i,
    'normalizedOutcome is required for the Intent MVP',
  );
  assert.match(
    run(root, 'original_intent_snapshot_set', {
      storyId,
      sourceText: 'Source text is present.',
      normalizedOutcome: 'Outcome is present.',
      acceptanceClaim: '',
    }, true),
    /acceptanceClaim/i,
    'acceptanceClaim is required for the Intent MVP',
  );
  const immutable = run(root, 'original_intent_snapshot_set', {
    storyId,
    sourceText: `${sourceText}\nchanged`,
    normalizedOutcome: 'ProofStory M0-M2 diagnostics exist without lifecycle gate enforcement.',
    acceptanceClaim: 'Dry-run diagnostics report hardening level and all triggered gaps.',
    keyRequirementIds: ['REQ-001'],
  }, true);
  assert.match(immutable, /immutable|requestHash/i, 'snapshot source hash is immutable');

  let coverage = jsonRun(root, 'intent_coverage_check', { storyId, mode: 'observe' });
  assert.ok(coverage.missingMilestoneCoverage.some((gap: any) => gap.code === 'missing_milestone_ledger'), 'structural milestone trigger requires ledger');
  assert.ok(coverage.missingAcceptanceBindings.some((gap: any) => gap.code === 'missing_acceptance_binding'), 'missing acceptance binding is reported');

  const milestones = Array.from({ length: 5 }, (_, index) => {
    const n = index + 1;
    return {
      id: `M${n}`,
      sourceRequirementId: 'REQ-001',
      claim: `Milestone ${n} is delivered`,
      doneMeans: `CHK-00${n} verification intent is present`,
      requiredEvidence: ['verificationIntent'],
      checklistRefs: [`CHK-00${n}`],
      verificationIntentRefs: [`CHK-00${n}:happy:0`],
      status: 'covered',
    };
  });
  const ledger = jsonRun(root, 'milestone_ledger_set', { storyId, milestones });
  assert.equal(ledger.milestones.length, 5, 'five milestone rows are machine-countable');
  const appendedLedger = jsonRun(root, 'milestone_ledger_add', {
    storyId,
    milestone: {
      id: 'M6',
      sourceRequirementId: 'REQ-001',
      claim: 'Milestone add appends a sixth row',
      doneMeans: 'milestone_ledger_get returns the appended row',
      requiredEvidence: ['verificationIntent'],
      checklistRefs: ['CHK-001'],
      verificationIntentRefs: ['CHK-001:edge:0'],
      parentLedgerId: 'PARENT-M6',
      assignedStory: 'B-child-m6',
      status: 'covered',
    },
  });
  assert.equal(appendedLedger.milestones.length, 6, 'milestone_ledger_add appends a row');
  assert.equal(appendedLedger.milestones.at(-1).parentLedgerId, 'PARENT-M6', 'milestone rows preserve optional parent ledger fields');
  assert.equal(appendedLedger.milestones.at(-1).assignedStory, 'B-child-m6', 'milestone rows preserve optional assigned story fields');
  assert.equal(appendedLedger.state, 'candidate', 'direct ledger writes stay candidate until accepted intent collision');
  assert.equal(appendedLedger.ledgerHash.startsWith('sha256:'), true, 'ledger has a stable hash');
  const storedLedger = jsonRun(root, 'milestone_ledger_get', { storyId });
  assert.equal(storedLedger.milestones.length, 6, 'milestone_ledger_get reads set plus appended rows');
  assert.ok(storedLedger.milestones.some((row: any) => row.id === 'M6'), 'stored ledger includes appended milestone');
  assert.match(
    run(root, 'milestone_ledger_set', { storyId, milestones: 'not-an-array' }, true),
    /map|array|milestones/i,
    'non-array milestone payloads fail before writing a malformed ledger',
  );
  assert.match(
    run(root, 'milestone_ledger_add', {
      storyId,
      milestone: {
        id: 'BAD-REF',
        sourceRequirementId: 'REQ-001',
        claim: 'Bad refs are rejected',
        doneMeans: 'Invalid refs do not corrupt the ledger',
        checklistRefs: [42],
        verificationIntentRefs: ['CHK-001:happy:0'],
      },
    }, true),
    /checklistRefs/i,
    'malformed milestone refs fail before corrupting the artifact',
  );
  assert.match(
    run(root, 'milestone_ledger_add', {
      storyId,
      milestone: {
        id: 'BAD-STORY',
        sourceRequirementId: 'REQ-001',
        claim: 'Bad assigned story is rejected',
        doneMeans: 'Invalid assignedStory does not corrupt the ledger',
        checklistRefs: ['CHK-001'],
        verificationIntentRefs: ['CHK-001:happy:0'],
        assignedStory: 'child-without-prefix',
      },
    }, true),
    /assignedStory/i,
    'invalid assignedStory fields fail before corrupting the artifact',
  );

  coverage = jsonRun(root, 'intent_coverage_check', { storyId, mode: 'observe' });
  assert.equal(coverage.missingMilestoneCoverage.length, 0, 'covered ledger rows clear milestone coverage gaps');
  assert.equal(coverage.missingAcceptanceBindings.length, 1, 'acceptance binding remains separate from milestone coverage');
  assert.equal(coverage.ledgerSizing.thresholdState, 'too_broad', 'six high-assurance milestones produce sizing diagnostics');
  assert.match(
    run(root, 'slice_plan_set', {
      storyId,
      slices: [{ id: 'slice-incomplete', milestoneIds: ['M1'], reason: 'Incomplete slice should fail.' }],
    }, true),
    /missing|cover every ledger milestone/i,
    'incomplete slice plan cannot bypass oversized ledger diagnostics',
  );
  const slicePlan = jsonRun(root, 'slice_plan_set', {
    storyId,
    slices: [
      { id: 'slice-1', milestoneIds: ['M1', 'M2', 'M3'], reason: 'First bounded implementation slice.', assignedStory: 'B-child-1' },
      { id: 'slice-2', milestoneIds: ['M4', 'M5', 'M6'], reason: 'Second bounded implementation slice.', assignedStory: 'B-child-2' },
    ],
  });
  assert.equal(slicePlan.slices.length, 2, 'slice_plan_set persists a complete oversized ledger exception');
  coverage = jsonRun(root, 'intent_coverage_check', { storyId, mode: 'observe' });
  assert.equal(coverage.ledgerSizing.oversizedClearedBy, 'slice_plan', 'complete slice plan clears oversized ledger blocking semantics');
  assert.equal(coverage.oversizedLedger.length, 0, 'complete slice plan removes oversized ledger gaps');

  const contract = jsonRun(root, 'proofstory_contract_set', {
    storyId,
    acceptanceBindings: [{
      id: 'ACCEPT-001',
      acceptanceClaim: 'Dry-run diagnostics report hardening level and all triggered gaps.',
      checklistRefs: ['CHK-001'],
      verificationIntentRefs: ['CHK-001:happy:0'],
      milestoneIds: ['M1'],
      note: 'Minimal diagnostic envelope binding for smoke coverage.',
    }],
  });
  assert.equal(contract.diagnosticOnly, false, 'ProofStory contract is a gate-consumable artifact when policy selects enforcement');
  assert.equal(contract.acceptanceBindings.length, 1, 'contract stores minimal acceptance binding');

  gate = jsonRun(root, 'proofstory_gate_check', { storyId, mode: 'observe' });
  assert.equal(gate.missingMvpArtifacts.length, 0, 'snapshot clears MVP artifact gap');
  assert.equal(gate.missingMilestoneCoverage.length, 0, 'ledger clears milestone coverage gaps');
  assert.equal(gate.missingAcceptanceBindings.length, 0, 'contract binding clears acceptance binding gaps');
  assert.ok(gate.missingIntentCollision.some((gap: any) => gap.code === 'missing_intent_collision'), 'triggered missing collision is diagnostic');
  assert.ok(gate.missingRedEvidence.some((gap: any) => gap.code === 'missing_red_evidence'), 'triggered missing red evidence is diagnostic');
  assert.ok(gate.missingSpikeEvidence.some((gap: any) => gap.code === 'missing_spike_evidence'), 'triggered missing spike evidence is diagnostic');
  assert.ok(gate.scopeAmbiguity.some((gap: any) => gap.code === 'scope_ambiguity'), 'scope ambiguity is diagnostic');

  const missingCollision = jsonRun(root, 'intent_collision_get', { storyId });
  assert.equal(missingCollision.status, 'not_configured', 'intent_collision_get degrades when no artifact exists');
  const reviseCollision = jsonRun(root, 'intent_collision_set', { storyId, decision: 'revise_intent', notes: 'Needs human clarification.' });
  assert.equal(reviseCollision.collision.status, 'open', 'non-pass collision remains open');
  gate = jsonRun(root, 'proofstory_gate_check', { storyId, mode: 'observe' });
  assert.ok(gate.missingIntentCollision.some((gap: any) => gap.code === 'missing_intent_collision'), 'non-pass collision does not clear the collision gap');
  const passCollision = jsonRun(root, 'intent_collision_set', {
    storyId,
    decision: 'pass',
    acceptedInterpretation: 'The six listed milestones are the accepted intent; M6 is optional only if explicitly shrunk later.',
  });
  assert.equal(passCollision.collision.status, 'accepted', 'pass collision is accepted');
  assert.equal(passCollision.confirmedLedger.state, 'confirmed', 'pass collision confirms the current ledger');
  gate = jsonRun(root, 'proofstory_gate_check', { storyId, mode: 'observe' });
  assert.equal(gate.missingIntentCollision.length, 0, 'accepted collision clears missing collision');
  assert.equal(gate.ledgerState, 'confirmed', 'gate sees confirmed ledger');

  const enforceFailure = run(root, 'proofstory_gate_check', { storyId, mode: 'enforce' }, true);
  assert.match(enforceFailure, /missing_red_evidence|missing_spike_evidence|scope_ambiguity/i, 'enforce mode exits nonzero when required artifacts are missing');

  const spikeStarted = jsonRun(root, 'spike_start', {
    storyId,
    id: 'SPIKE-A',
    question: 'Which auth gate path owns the regression?',
    disposableCodePaths: ['packages/main/src/tmp-spike.ts'],
  });
  assert.equal(spikeStarted.spikes[0].status, 'active', 'spike_start records active investigation evidence');
  gate = jsonRun(root, 'proofstory_gate_check', { storyId, mode: 'observe' });
  assert.ok(gate.missingSpikeEvidence.some((gap: any) => gap.code === 'unresolved_spike_evidence'), 'active spike remains diagnostic');
  const spikeResolved = jsonRun(root, 'spike_result_set', { storyId, id: 'SPIKE-A', result: 'The existing lifecycle gate path owns the regression.' });
  assert.equal(spikeResolved.spikes[0].status, 'resolved', 'spike_result_set resolves investigation evidence');
  gate = jsonRun(root, 'proofstory_gate_check', { storyId, mode: 'observe' });
  assert.ok(gate.missingSpikeEvidence.some((gap: any) => gap.code === 'active_disposable_spike_code'), 'resolved disposable spike code remains blocking until discarded or promoted');
  const spikePromoted = jsonRun(root, 'spike_promote', { storyId, id: 'SPIKE-A', promotedAs: 'implementation_note', note: 'Disposable path was explicitly reviewed and promoted.' });
  assert.equal(spikePromoted.spikes[0].status, 'promoted', 'spike_promote explicitly clears disposable spike policy');

  const wrongRedEvidence = jsonRun(root, 'red_evidence_create', {
    storyId,
    trigger: 'auth lifecycle gate regression',
    acceptanceTargetRef: 'WRONG-TARGET',
    observedFailure: 'Before the fix, the auth gate accepts an invalid transition.',
    failingCommand: 'npm test -- auth-gate-red',
    expectedGreenCommand: 'npm test -- auth-gate-green',
  });
  assert.equal(wrongRedEvidence.records.length, 1, 'wrong-target red evidence can be recorded for audit');
  gate = jsonRun(root, 'proofstory_gate_check', { storyId, mode: 'observe' });
  assert.ok(gate.missingRedEvidence.some((gap: any) => gap.code === 'missing_red_evidence'), 'wrong-target red evidence does not satisfy diagnostics');
  const staleRedEvidence = jsonRun(root, 'red_evidence_create', {
    storyId,
    trigger: 'auth lifecycle gate regression',
    acceptanceTargetRef: 'ACCEPT-001',
    observedFailure: 'Before the fix, the auth gate accepts an invalid transition.',
    failingCommand: 'npm test -- auth-gate-red',
    expectedGreenCommand: 'npm test -- auth-gate-green',
    greenHeadHash: wrongRedEvidence.records[0].baselineHeadHash,
    greenMaterialHash: wrongRedEvidence.records[0].baselineMaterialHash,
  });
  assert.equal(staleRedEvidence.records.length, 2, 'stale red evidence can be recorded for audit');
  gate = jsonRun(root, 'proofstory_gate_check', { storyId, mode: 'observe' });
  assert.ok(gate.missingRedEvidence.some((gap: any) => gap.code === 'missing_red_evidence'), 'stale red evidence does not satisfy diagnostics');
  const redWithoutFailureProof = jsonRun(root, 'red_evidence_create', {
    storyId,
    trigger: 'auth lifecycle gate regression',
    acceptanceTargetRef: 'ACCEPT-001',
    observedFailure: 'Before the fix, the auth gate accepts an invalid transition.',
    expectedGreenCommand: 'npm test -- auth-gate-green',
    greenHeadHash: 'green-head-after-fix-no-red-proof',
    greenMaterialHash: 'green-material-after-fix-no-red-proof',
  });
  assert.equal(redWithoutFailureProof.records.length, 3, 'red evidence without command or receipt can be recorded for audit');
  gate = jsonRun(root, 'proofstory_gate_check', { storyId, mode: 'observe' });
  assert.ok(gate.missingRedEvidence.some((gap: any) => gap.code === 'missing_red_evidence'), 'red evidence without command or receipt does not satisfy diagnostics');
  const redWithoutGreenProof = jsonRun(root, 'red_evidence_create', {
    storyId,
    trigger: 'auth lifecycle gate regression',
    acceptanceTargetRef: 'ACCEPT-001',
    observedFailure: 'Before the fix, the auth gate accepts an invalid transition.',
    failingCommand: 'npm test -- auth-gate-red',
  });
  assert.equal(redWithoutGreenProof.records.length, 4, 'red evidence without green proof can be recorded for audit');
  gate = jsonRun(root, 'proofstory_gate_check', { storyId, mode: 'observe' });
  assert.ok(gate.missingRedEvidence.some((gap: any) => gap.code === 'missing_red_evidence'), 'red evidence without expected green command or green hashes does not satisfy diagnostics');
  const redEvidence = jsonRun(root, 'red_evidence_create', {
    storyId,
    trigger: 'auth lifecycle gate regression',
    acceptanceTargetRef: 'ACCEPT-001',
    observedFailure: 'Before the fix, the auth gate accepts an invalid transition.',
    failingCommand: 'npm test -- auth-gate-red',
    expectedGreenCommand: 'npm test -- auth-gate-green',
    greenHeadHash: 'green-head-after-fix',
    greenMaterialHash: 'green-material-after-fix',
  });
  assert.equal(redEvidence.records.length, 5, 'red_evidence_create records auditable red evidence rows including the valid target-bound row');

  const storedContract = jsonRun(root, 'proofstory_contract_get', { storyId });
  assert.equal(storedContract.schemaVersion, 'proofstory.contract.v1', 'proofstory_contract_get reads the stored envelope');

  const checklistWithEvidence = store.readChecklist(storyId);
  checklistWithEvidence.items = checklistWithEvidence.items.map((item: any, index: number) => ({
    ...item,
    verificationEvidence: index < 5
      ? [{
        intentRef: `${item.id}:happy:0`,
        kind: 'logic_test',
        result: 'pass',
        note: `Milestone ${index + 1} green proof passes.`,
      }]
      : [],
  }));
  store.writeChecklist(storyId, checklistWithEvidence);
  let doneEquivalence = jsonRun(root, 'done_intent_equivalence_check', { storyId, mode: 'observe' });
  assert.equal(doneEquivalence.equivalenceMode, 'strict_milestone', 'slice-plan stories use strict DONE equivalence');
  assert.deepEqual(doneEquivalence.uncoveredRequiredMilestoneIds, ['M6'], 'DONE equivalence reports uncovered required milestones');
  assert.ok(
    doneEquivalence.gaps.some((gap: any) => gap.code === 'missing_parent_ledger_rollup'),
    'slice-plan DONE equivalence requires parent child-story coverage roll-up',
  );
  const rollup = jsonRun(root, 'parent_ledger_rollup_set', {
    storyId,
    children: [
      { storyId: 'B-child-1', milestoneIds: ['M1', 'M2', 'M3'], status: 'covered', evidenceRefs: ['B-child-1:summary'] },
      { storyId: 'B-child-2', milestoneIds: ['M4', 'M5', 'M6'], status: 'done', evidenceRefs: ['B-child-2:summary'] },
    ],
  });
  assert.equal(rollup.children.length, 2, 'parent_ledger_rollup_set records child-story coverage');
  doneEquivalence = jsonRun(root, 'done_intent_equivalence_check', { storyId, mode: 'observe' });
  assert.equal(
    doneEquivalence.gaps.some((gap: any) => gap.code === 'missing_parent_ledger_rollup'),
    false,
    'complete parent roll-up clears child-story coverage gap',
  );
  const checklistWithFailedSuccessVerdict = store.readChecklist(storyId);
  checklistWithFailedSuccessVerdict.items[0].verificationEvidence = [
    ...(checklistWithFailedSuccessVerdict.items[0].verificationEvidence ?? []),
    {
      intentRef: 'CHK-001:edge:0',
      kind: 'logic_test',
      result: 'fail',
      verdict: 'success',
      note: 'A failed row with a success verdict label must not satisfy ProofStory coverage.',
    },
  ];
  store.writeChecklist(storyId, checklistWithFailedSuccessVerdict);
  doneEquivalence = jsonRun(root, 'done_intent_equivalence_check', { storyId, mode: 'observe' });
  assert.deepEqual(doneEquivalence.uncoveredRequiredMilestoneIds, ['M6'], 'result=fail plus verdict=success does not satisfy ProofStory DONE equivalence');
  const failedSuccessReviewCompleteness = jsonRun(root, 'proofstory_review_completeness_check', { storyId, mode: 'warn' });
  assert.ok(
    failedSuccessReviewCompleteness.gaps.some((gap: any) => /CHK-001:edge:0/.test(gap.message)),
    'result=fail plus verdict=success does not satisfy ProofStory REVIEW completeness',
  );
  const checklistWithFailedWaiver = store.readChecklist(storyId);
  checklistWithFailedWaiver.items[0].verificationEvidence = [
    ...(checklistWithFailedWaiver.items[0].verificationEvidence ?? []).filter((row: any) => row.intentRef !== 'CHK-001:edge:0'),
    {
      intentRef: 'CHK-001:edge:0',
      kind: 'waiver',
      result: 'fail',
      verdict: 'waived',
      note: 'A failed waiver row must not satisfy ProofStory coverage.',
    },
  ];
  store.writeChecklist(storyId, checklistWithFailedWaiver);
  doneEquivalence = jsonRun(root, 'done_intent_equivalence_check', { storyId, mode: 'observe' });
  assert.deepEqual(doneEquivalence.uncoveredRequiredMilestoneIds, ['M6'], 'result=fail plus waiver does not satisfy ProofStory DONE equivalence');
  const checklistWithDeferredWaiver = store.readChecklist(storyId);
  checklistWithDeferredWaiver.items[0].verificationEvidence = [
    ...(checklistWithDeferredWaiver.items[0].verificationEvidence ?? []),
    {
      intentRef: 'CHK-001:edge:0',
      kind: 'waiver',
      waiverType: 'deferred_gate_evidence',
      verdict: 'waived',
      note: 'Temporary gate self-test waiver must not satisfy ProofStory DONE equivalence.',
    },
  ];
  store.writeChecklist(storyId, checklistWithDeferredWaiver);
  doneEquivalence = jsonRun(root, 'done_intent_equivalence_check', { storyId, mode: 'observe' });
  assert.deepEqual(doneEquivalence.uncoveredRequiredMilestoneIds, ['M6'], 'deferred gate waiver does not satisfy ProofStory DONE equivalence');
  assert.match(
    run(root, 'scope_shrinkage_decision_set', {
      storyId,
      decision: 'confirmed',
      removedMilestoneIds: ['M6'],
      reason: 'Missing human confirmation should block confirmed shrinkage.',
      approvedBy: 'proofstory-smoke',
    }, true),
    /userConfirmed:true/i,
    'confirmed scope shrinkage requires explicit user confirmation',
  );
  const shrinkage = jsonRun(root, 'scope_shrinkage_decision_set', {
    storyId,
    decision: 'confirmed',
    userConfirmed: true,
    removedMilestoneIds: ['M6'],
    reason: 'M6 was explicitly removed from this delivery after accepted interpretation.',
    approvedBy: 'proofstory-smoke',
  });
  assert.equal(shrinkage.decision, 'confirmed', 'scope shrinkage decision is explicit and auditable');
  assert.equal(shrinkage.userConfirmed, true, 'confirmed scope shrinkage records explicit user confirmation');
  doneEquivalence = jsonRun(root, 'done_intent_equivalence_check', { storyId, mode: 'enforce' });
  assert.equal(doneEquivalence.status, 'pass', 'confirmed shrinkage clears DONE equivalence without deleting the audit trail');

  gate = jsonRun(root, 'proofstory_gate_check', { storyId, mode: 'observe' });
  assert.equal(gate.missingRedEvidence.length, 0, 'red evidence clears triggered red evidence gap');
  assert.equal(gate.missingSpikeEvidence.length, 0, 'resolved spike clears triggered spike gap');
  assert.equal(gate.scopeAmbiguity.length, 0, 'explicit shrinkage decision clears scope ambiguity diagnostic');

  const reviewCompleteness = jsonRun(root, 'proofstory_review_completeness_check', { storyId, mode: 'warn' });
  assert.equal(reviewCompleteness.status, 'pass', 'review completeness sees bound evidence after shrinkage and green proofs');

  const phaseAfter = store.readStory(storyId).phase;
  assert.equal(phaseAfter, 'PLAN', 'ProofStory diagnostics do not advance lifecycle phase');

  const lightStoryId = 'B-light';
  const lightStory: StoryInfo = {
    storyId: lightStoryId,
    name: 'label-normalizer',
    title: 'Add label normalizer',
    description: 'Provide a small internal helper for formatting labels.',
    type: 'feature',
    phase: 'PLAN',
    priority: 'medium',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    events: [],
  };
  store.writeStory(lightStoryId, lightStory);
  store.writeChecklist(lightStoryId, { items: [] });
  const lightGate = jsonRun(root, 'proofstory_gate_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(lightGate.hardeningLevel, 'intent_mvp', 'clear low-risk feature keeps Intent MVP classification');
  assert.equal(lightGate.missingIntentCollision.length, 0, 'clear low-risk feature does not require intent collision');
  assert.equal(lightGate.missingRedEvidence.length, 0, 'clear new feature does not require red evidence by default');
  jsonRun(root, 'original_intent_snapshot_set', {
    storyId: lightStoryId,
    sourceText: 'Provide a small internal helper for formatting labels.',
    normalizedOutcome: 'Labels are formatted consistently.',
    acceptanceClaim: 'The label normalizer formats a representative input.',
  });
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Added label normalization.',
    actualTranscript: 'Representative label normalized successfully.',
    outcomeDiff: 'No difference from the original request.',
  }));
  const lightDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'enforce' });
  assert.equal(lightDone.equivalenceMode, 'lightweight_single_outcome', 'single-outcome DONE equivalence uses lightweight path');
  assert.equal(lightDone.status, 'pass', 'single-outcome DONE equivalence passes without a confirmed ledger');
  const highSingleOutcomeStoryId = 'B-high-single-outcome';
  const highSingleOutcomeNow = new Date().toISOString();
  const highSingleOutcomeStory: StoryInfo = {
    storyId: highSingleOutcomeStoryId,
    name: 'proof-gate-label',
    title: 'Harden proof gate label',
    description: 'Harden one proof gate label so operators see the accepted outcome clearly.',
    type: 'feature',
    phase: 'TEST',
    priority: 'high',
    createdAt: highSingleOutcomeNow,
    startedAt: highSingleOutcomeNow,
    endedAt: null,
    events: [],
  };
  store.writeStory(highSingleOutcomeStoryId, highSingleOutcomeStory);
  store.writeChecklist(highSingleOutcomeStoryId, { items: [] });
  jsonRun(root, 'original_intent_snapshot_set', {
    storyId: highSingleOutcomeStoryId,
    sourceText: 'Harden one proof gate label so operators see the accepted outcome clearly.',
    normalizedOutcome: 'One proof gate label clearly reports the accepted outcome.',
    acceptanceClaim: 'The summary shows the accepted proof gate label outcome.',
  });
  store.writeSummary(highSingleOutcomeStoryId, makeSummary(highSingleOutcomeStoryId, {
    changes: 'Updated the proof gate label.',
    actualTranscript: 'The accepted proof gate label outcome is visible.',
    outcomeDiff: 'No difference from the original request.',
  }));
  const highSingleOutcomeGate = jsonRun(root, 'proofstory_gate_check', { storyId: highSingleOutcomeStoryId, mode: 'observe' });
  assert.equal(highSingleOutcomeGate.hardeningLevel, 'high_assurance', 'high-risk wording still selects high-assurance hardening');
  const highSingleOutcomeDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: highSingleOutcomeStoryId, mode: 'enforce' });
  assert.equal(highSingleOutcomeDone.equivalenceMode, 'lightweight_single_outcome', 'high-assurance single-outcome DONE uses lightweight path without milestone evidence');
  assert.equal(highSingleOutcomeDone.status, 'pass', 'high-assurance single-outcome DONE passes without a confirmed ledger when no milestone path exists');
  const highSingleOutcomeShrinkStoryId = 'B-high-single-outcome-shrink';
  const highSingleOutcomeShrinkNow = new Date().toISOString();
  const highSingleOutcomeShrinkStory: StoryInfo = {
    storyId: highSingleOutcomeShrinkStoryId,
    name: 'proof-gate-label-shrink',
    title: 'Harden proof gate label with confirmed shrinkage',
    description: 'Harden one proof gate label and defer the optional tooltip after explicit user confirmation.',
    type: 'feature',
    phase: 'TEST',
    priority: 'high',
    createdAt: highSingleOutcomeShrinkNow,
    startedAt: highSingleOutcomeShrinkNow,
    endedAt: null,
    events: [],
  };
  store.writeStory(highSingleOutcomeShrinkStoryId, highSingleOutcomeShrinkStory);
  store.writeChecklist(highSingleOutcomeShrinkStoryId, { items: [] });
  jsonRun(root, 'original_intent_snapshot_set', {
    storyId: highSingleOutcomeShrinkStoryId,
    sourceText: 'Harden one proof gate label and add an optional tooltip.',
    normalizedOutcome: 'One proof gate label is hardened; the optional tooltip is explicitly deferred.',
    acceptanceClaim: 'The summary shows the accepted proof gate label outcome and confirmed tooltip deferral.',
  });
  const highSingleOutcomeShrink = jsonRun(root, 'scope_shrinkage_decision_set', {
    storyId: highSingleOutcomeShrinkStoryId,
    decision: 'confirmed',
    userConfirmed: true,
    removedMilestoneIds: ['OUTCOME-tooltip'],
    reason: 'The user explicitly confirmed the optional tooltip is out of scope for this delivery.',
    approvedBy: 'proofstory-smoke',
  });
  assert.equal(highSingleOutcomeShrink.userConfirmed, true, 'single-outcome shrinkage records explicit user confirmation');
  store.writeSummary(highSingleOutcomeShrinkStoryId, makeSummary(highSingleOutcomeShrinkStoryId, {
    changes: 'Updated the proof gate label; optional tooltip deferred by confirmed scope shrinkage.',
    actualTranscript: 'The accepted proof gate label outcome is visible.',
    outcomeDiff: 'Optional tooltip excluded by explicit user-confirmed scope shrinkage.',
  }));
  const highSingleOutcomeShrinkDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: highSingleOutcomeShrinkStoryId, mode: 'enforce' });
  assert.equal(highSingleOutcomeShrinkDone.equivalenceMode, 'strict_milestone', 'confirmed single-outcome shrinkage selects strict DONE equivalence without a ledger or slice');
  assert.equal(highSingleOutcomeShrinkDone.status, 'pass', 'confirmed single-outcome shrinkage passes strict DONE equivalence with explicit user confirmation');
  assert.equal(
    highSingleOutcomeShrinkDone.gaps.some((gap: any) => gap.code === 'missing_confirmed_milestone_ledger'),
    false,
    'confirmed single-outcome shrinkage does not invent a milestone-ledger requirement',
  );
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    acceptanceVerdict: 'partial',
    outcomeDiff: 'Partial narrower delivery; remaining cases deferred.',
  }));
  const narrowLightDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.ok(
    narrowLightDone.gaps.some((gap: any) => gap.code === 'done_summary_not_accepted' || gap.code === 'unconfirmed_single_outcome_shrinkage'),
    'narrow single-outcome DONE claims require confirmed shrinkage instead of passing silently',
  );

  const redSignalStories: StoryInfo[] = [
    {
      storyId: 'B-bug-signal',
      name: 'bug-signal',
      title: 'Fix login bug',
      description: 'Fix a confirmed login bug.',
      type: 'bug',
      phase: 'PLAN',
      priority: 'medium',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      endedAt: null,
      events: [],
    },
    {
      storyId: 'B-auth-signal',
      name: 'auth-signal',
      title: 'Update auth session handling',
      description: 'Update auth session handling.',
      type: 'chore',
      phase: 'PLAN',
      priority: 'medium',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      endedAt: null,
      events: [],
    },
    {
      storyId: 'B-behavior-signal',
      name: 'behavior-signal',
      title: 'Change retry behavior',
      description: 'Change retry behavior for transient failures.',
      type: 'feature',
      phase: 'PLAN',
      priority: 'medium',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      endedAt: null,
      events: [],
    },
    {
      storyId: 'B-benchmark-signal',
      name: 'benchmark-signal',
      title: 'Add benchmark claim',
      description: 'Add benchmark claim for throughput.',
      type: 'feature',
      phase: 'PLAN',
      priority: 'medium',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      endedAt: null,
      events: [],
    },
  ];
  for (const redSignalStory of redSignalStories) {
    store.writeStory(redSignalStory.storyId, redSignalStory);
    store.writeChecklist(redSignalStory.storyId, { items: [] });
    const redSignalGate = jsonRun(root, 'proofstory_gate_check', { storyId: redSignalStory.storyId, mode: 'observe' });
    assert.ok(
      redSignalGate.missingRedEvidence.some((gap: any) => gap.code === 'missing_red_evidence'),
      `${redSignalStory.name} still triggers red evidence diagnostics`,
    );
  }

  const typoStoryId = 'B-typo';
  const typoStory: StoryInfo = {
    storyId: typoStoryId,
    name: 'small-typo',
    title: 'Complete this small typo fix',
    description: 'Complete this small typo fix.',
    type: 'chore',
    phase: 'PLAN',
    priority: 'medium',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    events: [],
  };
  store.writeStory(typoStoryId, typoStory);
  store.writeChecklist(typoStoryId, { items: [] });
  const typoGate = jsonRun(root, 'proofstory_gate_check', { storyId: typoStoryId, mode: 'observe' });
  assert.equal(typoGate.hardeningLevel, 'intent_mvp', 'documented small typo example stays Intent MVP');
  assert.equal(
    typoGate.triggerReasons.some((reason: any) => reason.code === 'structural_milestone_intent'),
    false,
    'isolated complete wording does not trigger milestone ledger by itself',
  );
  assert.equal(typoGate.missingMilestoneCoverage.length, 0, 'isolated complete wording has no milestone coverage gap');
  assert.equal(
    typoGate.triggerReasons.some((reason: any) => reason.code === 'collision_required_standard'),
    false,
    'isolated typo fix wording does not trigger standard collision intent',
  );
  assert.equal(
    typoGate.triggerReasons.some((reason: any) => reason.code === 'red_evidence_required'),
    false,
    'isolated typo fix wording does not trigger red evidence',
  );
  assert.equal(
    typoGate.triggerReasons.some((reason: any) => reason.code === 'scope_ambiguity'),
    false,
    'isolated complete wording does not trigger scope ambiguity',
  );
  assert.equal(typoGate.missingIntentCollision.length, 0, 'documented typo example has no collision diagnostic gap');
  assert.equal(typoGate.missingRedEvidence.length, 0, 'documented typo example has no red evidence diagnostic gap');
  assert.equal(typoGate.scopeAmbiguity.length, 0, 'documented typo example has no scope ambiguity diagnostic gap');

  console.log('ProofStory intent hardening smoke passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
