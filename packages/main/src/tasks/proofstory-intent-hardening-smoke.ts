#!/usr/bin/env node
/**
 * Focused smoke coverage for ProofStory progressive intent hardening.
 *
 * @task B-3b99
 * @checklist CHK-003
 * @title Smoke ProofStory key requirement and source requirement binding
 * @type chore
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
import type { ChecklistData, MilestoneLedgerData, StoryInfo, StoryPhase, StorySummaryData } from '../core/types.js';
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

  // Negative control: duplicate milestone ledger rows must be rejected, not silently kept.
  // milestone_ledger_set with two rows sharing the same id fails before writing the artifact.
  assert.match(
    run(root, 'milestone_ledger_set', {
      storyId,
      milestones: [
        { id: 'DUP-1', sourceRequirementId: 'REQ-001', claim: 'First DUP-1 row', doneMeans: 'ledger rejects the second DUP-1 row', checklistRefs: ['CHK-001'], verificationIntentRefs: ['CHK-001:happy:0'], status: 'covered' },
        { id: 'DUP-1', sourceRequirementId: 'REQ-001', claim: 'Second DUP-1 row', doneMeans: 'ledger rejects the second DUP-1 row', checklistRefs: ['CHK-002'], verificationIntentRefs: ['CHK-002:happy:0'], status: 'covered' },
      ],
    }, true),
    /duplicate milestone id: DUP-1/i,
    'milestone_ledger_set rejects two rows sharing the same milestone id',
  );
  // milestone_ledger_add appending an id that already exists in the ledger (M1) fails before appending.
  assert.match(
    run(root, 'milestone_ledger_add', {
      storyId,
      milestone: {
        id: 'M1',
        sourceRequirementId: 'REQ-001',
        claim: 'Duplicate M1 append is rejected',
        doneMeans: 'milestone_ledger_add refuses a second row with an existing id',
        checklistRefs: ['CHK-001'],
        verificationIntentRefs: ['CHK-001:happy:0'],
        status: 'covered',
      },
    }, true),
    /duplicate milestone id: M1/i,
    'milestone_ledger_add rejects appending a row whose id already exists in the ledger',
  );
  const ledgerAfterDupAttempts = jsonRun(root, 'milestone_ledger_get', { storyId });
  assert.equal(
    ledgerAfterDupAttempts.milestones.length,
    6,
    'rejected duplicate milestone rows do not mutate the existing ledger',
  );
  assert.equal(
    new Set(ledgerAfterDupAttempts.milestones.map((row: any) => row.id)).size,
    ledgerAfterDupAttempts.milestones.length,
    'stored ledger milestone ids remain unique after rejected duplicate attempts',
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

  // B-2c03 CHK-001/CHK-002: path-like/code-like tokens in DONE summaries must not
  // trip the claimsShrinkage heuristic. Regression for the B-d6a0 incident where
  // the literal file name core/partial-done-recovery.ts matched \bpartial\b
  // (hyphens are word boundaries) and blocked DONE with
  // unconfirmed_single_outcome_shrinkage until the summary avoided the file name.
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Fixed the first-row corruption in core/partial-done-recovery.ts and updated its callers.',
    actualTranscript: 'The porcelain audit output is correct for the first row.',
    outcomeDiff: 'No difference from the original request.',
  }));
  const fileNameDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    fileNameDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    false,
    'a summary naming core/partial-done-recovery.ts is not a shrinkage claim (B-d6a0 false positive)',
  );
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Documented the `deferred` flag and cleaned up src/excluded/list.ts.',
    actualTranscript: 'The label normalizer output is unchanged.',
    outcomeDiff: 'No difference from the original request.',
  }));
  const codeTokenDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    codeTokenDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    false,
    'backticked spans and slash-segmented paths are code-like tokens, not shrinkage claims',
  );
  // Adversarial control: a genuine prose shrinkage claim sitting next to a path
  // token must still trigger — the sanitizer must not swallow surrounding prose.
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Fixed core/partial-done-recovery.ts; the remaining cases were deferred to a follow-up.',
  }));
  const proseShrinkDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    proseShrinkDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    true,
    'genuine prose shrinkage claims still require a confirmed shrinkage decision',
  );
  // B-2c03 CHK-003: bare "remaining" was too broad — prose about pre-existing
  // unrelated failures is not a scope-shrinkage claim for this story, while
  // shrinkage-flavored "remaining <scope-noun>" phrasing still is.
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Added label normalization.',
    limitations: 'Two remaining suite failures are pre-existing upstream issues unrelated to this story.',
  }));
  const preexistingDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    preexistingDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    false,
    'bare "remaining" describing pre-existing unrelated failures is not a shrinkage claim',
  );
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Added label normalization.',
    limitations: 'The remaining cases were left for a follow-up story.',
  }));
  const remainingScopeDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    remainingScopeDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    true,
    '"remaining <scope-noun>" phrasing is still a shrinkage claim',
  );
  // B-2c03 F-001: hyphenated trigger words are prose, not code tokens — the
  // sanitizer must only strip path-shaped tokens (slash or dotted), so phrasing
  // like "deferred-for-now" keeps matching \bdeferred\b (hyphen is a boundary).
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Added label normalization.',
    limitations: 'The tooltip work was deferred-for-now.',
  }));
  const hyphenTriggerDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    hyphenTriggerDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    true,
    'hyphenated trigger words like deferred-for-now are still shrinkage claims (F-001)',
  );
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Added label normalization.',
    limitations: 'Some inputs were excluded-here on purpose.',
  }));
  const hyphenExcludedDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    hyphenExcludedDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    true,
    'hyphenated trigger words like excluded-here are still shrinkage claims (F-001)',
  );
  // Dotted file names without a directory prefix are still code-like and must
  // not trigger even though a segment is a trigger word.
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Renamed partial-done-recovery.ts helpers for clarity.',
    actualTranscript: 'The helpers behave as before.',
    outcomeDiff: 'No difference from the original request.',
  }));
  const bareFileNameDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    bareFileNameDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    false,
    'a dotted file name without a directory prefix (partial-done-recovery.ts) is still not a shrinkage claim',
  );
  // B-2c03 F-002: a hyphenated trigger word with a NON-extension dotted suffix
  // (partial-release.rc1, deferred-work.next) is not a file name — only tokens
  // ending in a real file extension may be stripped, so the trigger segment
  // must survive and keep matching.
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Added label normalization.',
    limitations: 'Support for partial-release.rc1 was dropped from this delivery.',
  }));
  const dottedSuffixDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    dottedSuffixDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    true,
    'a hyphenated trigger word with a non-extension dotted suffix (partial-release.rc1) is still a shrinkage claim (F-002)',
  );
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Added label normalization.',
    limitations: 'The deferred-work.next backlog entries were not delivered.',
  }));
  const dottedSuffixDeferredDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    dottedSuffixDeferredDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    true,
    'a hyphenated trigger word with a dotted non-extension suffix (deferred-work.next) is still a shrinkage claim (F-002)',
  );
  // Multi-dot file names with a real extension stay stripped.
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Renamed partial-recovery.test.mjs for clarity.',
    actualTranscript: 'The helpers behave as before.',
    outcomeDiff: 'No difference from the original request.',
  }));
  const multiDotFileDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    multiDotFileDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    false,
    'a multi-dot file name with a real extension (partial-recovery.test.mjs) is still not a shrinkage claim',
  );
  // B-2c03 F-003: the narrowed "remaining <scope-noun>" trigger must accept
  // hyphen/underscore connectors, not just whitespace — "remaining-scope items"
  // is natural shrinkage prose and survives the sanitizer unstripped.
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Added label normalization.',
    limitations: 'The remaining-scope items were pushed to a follow-up story.',
  }));
  const hyphenRemainingDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    hyphenRemainingDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    true,
    'hyphen-connected "remaining-scope" phrasing is still a shrinkage claim (F-003)',
  );
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Added label normalization.',
    limitations: 'The remaining_work backlog was intentionally dropped.',
  }));
  const underscoreRemainingDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    underscoreRemainingDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    true,
    'underscore-connected "remaining_work" phrasing is still a shrinkage claim (F-003)',
  );
  // Host-B (codex) rounds 1+2 / F-011: modifier prose between "remaining" and
  // the scope noun must fire regardless of modifier count, commas, or unicode
  // dashes — the trigger uses a bounded same-sentence character window, not a
  // fixed word count. (These cases were first added pre-fix and observed RED;
  // a concurrent reviewer cleanup reverted them before commit — F-011.)
  const remainingWindowClaims = [
    'The remaining browser-only edge cases are left for a follow-up story.',
    'The remaining hard multi-tenant migration tasks were handed to the platform team.',
    'The remaining browser-only Safari mobile edge cases were left to a follow-up story.',
    'The remaining high-priority, user-visible cases were left to a follow-up story.',
    'The remaining browser–only edge cases were left to follow-up.',
    // codex round 3: long conjunction-joined modifier chains and heading-style
    // colon prose are genuine claims the bare pre-story trigger caught.
    'The remaining browser-only Safari mobile localization and reduced-motion edge cases were left to a follow-up story.',
    'Remaining: mobile Safari cases are left for a follow-up story.',
    // codex round 4: collective "of" constructions and slash-delimited
    // modifiers are noun-phrase internal, not clause breaks.
    'The remaining set of cases was left for a follow-up story.',
    'The remaining UI/UX cases were left for a follow-up story.',
  ];
  for (const claim of remainingWindowClaims) {
    store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
      changes: 'Added label normalization.',
      limitations: claim,
    }));
    const windowDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
    assert.equal(
      windowDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
      true,
      `"remaining <modifiers> <scope-noun>" phrasing still fires (host-B window class): ${claim}`,
    );
  }
  // Negative controls: no scope noun inside the same-sentence window, and a
  // scope noun that only appears in the NEXT sentence, both stay quiet.
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Added label normalization.',
    limitations: 'Two remaining suite failures are pre-existing upstream problems unrelated to this change.',
  }));
  const windowControlNoNoun = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    windowControlNoNoun.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    false,
    'bare "remaining" prose without a scope noun in the window still does not fire (CHK-003 decision)',
  );
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Added label normalization.',
    limitations: 'Two remaining suite failures are pre-existing. Scope work continues next sprint.',
  }));
  const windowControlNextSentence = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    windowControlNextSentence.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    false,
    'the "remaining" window does not leak across a sentence boundary',
  );
  // B-2c03 F-012: the window is a MODIFIER CHAIN, not raw character
  // proximity — a scope noun sitting in a different clause (past other nouns
  // or verbs) must NOT fire, or the CHK-003 false-positive class returns.
  const remainingCrossClauseControls = [
    'Two remaining flaky tests, unrelated to this fix, cover edge cases in CI.',
    'The remaining CI flakes are old infra items, not part of this change.',
    'The two remaining suite failures are pre-existing issues, not new test cases from this change.',
    // F-013: clause-coordinating conjunctions (comma+conjunction, or a state
    // verb before a bare conjunction) must not bridge into the next clause.
    'Two remaining issues exist, and scope work continues in a follow-up story.',
    'Two remaining test failures linger, and coverage improvements are tracked in a follow-up.',
    'Two remaining issues exist and scope work continues in a follow-up story.',
  ];
  for (const control of remainingCrossClauseControls) {
    store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
      changes: 'Added label normalization.',
      limitations: control,
    }));
    const crossClauseDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
    assert.equal(
      crossClauseDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
      false,
      `a scope noun in a different clause does not fire (F-012): ${control}`,
    );
  }
  // Host-B (codex) finding 5 (round 1): pathological long hyphen/dot tokens
  // must not cause superlinear scan time in the DONE gate.
  {
    const pathological = `${'a-'.repeat(20000)}partial-done-recovery.ts The remaining cases were left for follow-up.`;
    store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
      changes: 'Added label normalization.',
      limitations: pathological,
    }));
    const t0 = Date.now();
    const pathologicalDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
    const elapsedMs = Date.now() - t0;
    assert.equal(
      pathologicalDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
      true,
      'the genuine claim after a pathological token still fires (host-B finding 5)',
    );
    // CLI spawn overhead dominates; the regex scan itself must stay linear-ish.
    // Pre-fix the scan alone took >6s, so a generous end-to-end bound catches it.
    assert.ok(elapsedMs < 5000, `pathological-token DONE check stayed fast (took ${elapsedMs}ms; host-B finding 5)`);
  }
  // Host-B round 2, finding 1: a whitespace-free backticked trigger token
  // (`deferred`) is a code reference and strips BY REQUIREMENT (the original
  // user request names backticked spans explicitly). In such sentences the
  // claim is carried by the verb ("left to a follow-up"), which belongs to the
  // follow-up vocabulary story. Pinned so any future change is deliberate.
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Added label normalization.',
    limitations: 'The `deferred` work was left to a follow-up story.',
  }));
  const backtickTriggerTokenDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    backtickTriggerTokenDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    false,
    'a whitespace-free backticked trigger token strips by requirement; verb recall is the vocabulary follow-up',
  );
  // Same connector class as F-003 for the multi-word triggers: hyphenated
  // "out-of-scope" / "not-covered" are common technical phrasings, survive the
  // sanitizer unstripped (hyphen-only tokens are kept), and must still match.
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Added label normalization.',
    limitations: 'The extra endpoints are out-of-scope for this delivery.',
  }));
  const hyphenOutOfScopeDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    hyphenOutOfScopeDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    true,
    'hyphenated "out-of-scope" phrasing is still a shrinkage claim (F-003 class)',
  );
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Added label normalization.',
    limitations: 'Two branches were left not-covered by the new tests.',
  }));
  const hyphenNotCoveredDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    hyphenNotCoveredDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    true,
    'hyphenated "not-covered" phrasing is still a shrinkage claim (F-003 class)',
  );
  // B-2c03 F-005: extensions that read as ordinary short English words (log,
  // go, map, sh, ...) are ambiguous — a hyphenated trigger word with such a
  // suffix must fail SAFE (keep the token, fire the gap) instead of being
  // silently erased. Unambiguous technical extensions (.ts, .test.mjs) still
  // strip (see bareFileNameDone / multiDotFileDone above).
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Added label normalization.',
    limitations: 'The excluded-approach.log entry was removed from this delivery.',
  }));
  const ambiguousExtLogDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    ambiguousExtLogDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    true,
    'a trigger word with an ambiguous common-word suffix (excluded-approach.log) fails safe and still fires (F-005)',
  );
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Added label normalization.',
    limitations: 'The deferred-plan.go decision was made anyway, skipping the rest.',
  }));
  const ambiguousExtGoDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    ambiguousExtGoDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    true,
    'a trigger word with an ambiguous common-word suffix (deferred-plan.go) fails safe and still fires (F-005)',
  );
  // B-2c03 F-006: the stripping rules must not erase genuine prose claims.
  // (1) Backticked spans containing whitespace are quoted prose, not code
  // tokens, and must keep firing.
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Added label normalization.',
    limitations: 'Note: `the remaining scope items were deferred` due to time constraints.',
  }));
  const backtickProseDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    backtickProseDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    true,
    'a backticked span containing whitespace is quoted prose and still fires (F-006)',
  );
  // (2) A single slash between two prose words is not a path.
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'The remaining/scope work was intentionally cut from this delivery.',
    actualTranscript: 'The label normalizer output is unchanged.',
    outcomeDiff: 'No difference from the original request.',
  }));
  const slashProseDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    slashProseDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    true,
    'a single slash between prose words (remaining/scope) is not a path and still fires (F-006)',
  );
  // (3) A bare trigger word with a dot-extension but a simple stem (partial.md)
  // is ambiguous between a file name and mid-sentence prose — fail safe.
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'We decided the partial.md approach was best for now.',
    actualTranscript: 'The label normalizer output is unchanged.',
    outcomeDiff: 'No difference from the original request.',
  }));
  const simpleStemDotDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    simpleStemDotDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    true,
    'a trigger word with a simple stem and dot extension (partial.md) fails safe and still fires (F-006)',
  );
  // B-2c03 F-007: slash count alone is not path semantics — English
  // slash-separated enumerations (excluded/deferred/partial) must keep firing;
  // only tokens with a dot or a leading path prefix (./ ../ ~/ /) strip.
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'The excluded/deferred/partial items were dropped from this delivery.',
    actualTranscript: 'The label normalizer output is unchanged.',
    outcomeDiff: 'No difference from the original request.',
  }));
  const slashEnumerationDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    slashEnumerationDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    true,
    'a multi-slash English enumeration (excluded/deferred/partial) is not a path and still fires (F-007)',
  );
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'The remaining/scope/details were dropped from this delivery.',
    actualTranscript: 'The label normalizer output is unchanged.',
    outcomeDiff: 'No difference from the original request.',
  }));
  const slashEnumerationRemainingDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    slashEnumerationRemainingDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    true,
    'a multi-slash enumeration starting with remaining (remaining/scope/details) still fires (F-007)',
  );
  // Control: dotted and prefix-led paths still strip regardless of slash count.
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Cleaned up ./excluded/queue and src/deferred/list.ts in passing.',
    actualTranscript: 'The label normalizer output is unchanged.',
    outcomeDiff: 'No difference from the original request.',
  }));
  const pathPrefixDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    pathPrefixDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    false,
    'prefix-led (./excluded/queue) and dotted (src/deferred/list.ts) paths still strip (F-007 control)',
  );
  // B-2c03 F-008: dot-glued multi-word triggers are prose too. Such tokens
  // survive the sanitizer (their suffix is not a file extension), so the
  // trigger connectors must accept a dot alongside whitespace/slash/dash.
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'The remaining.scope work was intentionally cut from this delivery.',
    actualTranscript: 'The label normalizer output is unchanged.',
    outcomeDiff: 'No difference from the original request.',
  }));
  const dotRemainingDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    dotRemainingDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    true,
    'dot-glued "remaining.scope" phrasing is still a shrinkage claim (F-008)',
  );
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Added label normalization.',
    limitations: 'The out.of.scope items were skipped too.',
  }));
  const dotOutOfScopeDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    dotOutOfScopeDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    true,
    'dot-glued "out.of.scope" phrasing is still a shrinkage claim (F-008)',
  );
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Added label normalization.',
    limitations: 'Two edge branches were left not.covered by the new tests.',
  }));
  const dotNotCoveredDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    dotNotCoveredDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    true,
    'dot-glued "not.covered" phrasing is still a shrinkage claim (F-008)',
  );
  // B-2c03 F-009: an incidental dotted segment inside a slash enumeration
  // (excluded/deferred/v2.1) must not turn the whole token into a "path" —
  // only explicit path markers (leading prefix, URL scheme, or a final segment
  // ending in a known extension) strip.
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'The excluded/deferred/v2.1 items were dropped from this delivery.',
    actualTranscript: 'The label normalizer output is unchanged.',
    outcomeDiff: 'No difference from the original request.',
  }));
  const slashEnumerationDotDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    slashEnumerationDotDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    true,
    'a slash enumeration with an incidental dotted segment (excluded/deferred/v2.1) still fires (F-009)',
  );
  // Control: URL-scheme tokens naming trigger words are paths, not prose.
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Documented the flow at https://example.com/deferred/setup.md for operators.',
    actualTranscript: 'The label normalizer output is unchanged.',
    outcomeDiff: 'No difference from the original request.',
  }));
  const urlControlDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    urlControlDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    false,
    'URL-scheme tokens (https://example.com/deferred/setup.md) still strip (F-009 control)',
  );
  // Delivery-review record: a trigger-stemmed FILE NAME with an unambiguous
  // extension (deferred-query.sql) is stripped BY REQUIREMENT — it is
  // shape-identical to partial-done-recovery.ts, the token class B-d6a0
  // demands stay silent. The shrinkage meaning in such sentences is carried by
  // the verb (skipped/removed), which the trigger vocabulary has never
  // covered; verb-recall expansion is the follow-up vocabulary story. This
  // case pins the designed direction so any future change is deliberate.
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'The deferred-query.sql export was skipped for this delivery.',
    actualTranscript: 'The label normalizer output is unchanged.',
    outcomeDiff: 'No difference from the original request.',
  }));
  const triggerStemFileDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    triggerStemFileDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    false,
    'a trigger-stemmed file name with an unambiguous extension strips by requirement (B-d6a0 class); the verb belongs to the vocabulary follow-up',
  );
  // ...while the same sentence with an explicit trigger phrase still fires.
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'The deferred-query.sql export was skipped; the remaining scope was cut.',
    actualTranscript: 'The label normalizer output is unchanged.',
    outcomeDiff: 'No difference from the original request.',
  }));
  const triggerStemFileWithClaimDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    triggerStemFileWithClaimDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    true,
    'a genuine trigger phrase next to a trigger-stemmed file name still fires',
  );
  // Control: a dotted token whose tail IS a scope noun but whose head is not a
  // trigger (label.scope) must not fire, and file names stay stripped.
  store.writeSummary(lightStoryId, makeSummary(lightStoryId, {
    changes: 'Refactored the label.scope helper and renamed partial-done-recovery.ts.',
    actualTranscript: 'The helpers behave as before.',
    outcomeDiff: 'No difference from the original request.',
  }));
  const dotControlDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: lightStoryId, mode: 'observe' });
  assert.equal(
    dotControlDone.gaps.some((gap: any) => gap.code === 'unconfirmed_single_outcome_shrinkage'),
    false,
    'non-trigger dotted identifiers (label.scope) and real file names still do not fire (F-008 control)',
  );

  // B-f7b3 CHK-004: a CONFIRMED milestone ledger that is empty OR whose rows are
  // all not_applicable (without a valid decision) must NOT vacuously satisfy the
  // milestone DONE requirement. These are negative controls over the CHK-007
  // (not_applicable_missing_decision) and CHK-004 (empty_confirmed_milestone_ledger)
  // guards in evaluateDoneIntentEquivalence. Ledgers are written directly as
  // `confirmed` so the assertion isolates DONE equivalence from the collision dance.
  const confirmedLedger = (
    storyId: string,
    milestones: Record<string, unknown>[],
  ): Record<string, unknown> => ({
    schemaVersion: 'proofstory.milestone_ledger.v1',
    storyId,
    state: 'confirmed',
    ledgerHash: `sha256:confirmed-${storyId}`,
    milestones,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // Case 1: all-not_applicable confirmed ledger WITHOUT a valid notApplicableDecision.
  // A milestone ledger with rows keeps hasMilestonePath true and the confirmed state
  // clears missing_confirmed_milestone_ledger, so the ONLY thing standing between the
  // gate and a vacuous pass is the CHK-007 not_applicable_missing_decision guard.
  const notApplicableStoryId = 'B-not-applicable-only';
  const notApplicableStory: StoryInfo = {
    storyId: notApplicableStoryId,
    name: 'not-applicable-only',
    title: 'Deliver all milestones',
    description: 'Deliver all three milestones for the accepted intent.',
    type: 'feature',
    phase: 'TEST',
    priority: 'medium',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    events: [],
  };
  store.writeStory(notApplicableStoryId, notApplicableStory);
  store.writeChecklist(notApplicableStoryId, { items: [] });
  store.writeMilestoneLedger(notApplicableStoryId, confirmedLedger(notApplicableStoryId, [
    {
      id: 'M-na-1',
      sourceRequirementId: 'REQ-001',
      claim: 'First milestone is marked not applicable',
      doneMeans: 'A not_applicable row without a decision cannot self-exempt',
      requiredEvidence: [],
      checklistRefs: [],
      verificationIntentRefs: [],
      status: 'not_applicable',
    },
    {
      id: 'M-na-2',
      sourceRequirementId: 'REQ-001',
      claim: 'Second milestone is marked not applicable',
      doneMeans: 'A not_applicable row without a decision cannot self-exempt',
      requiredEvidence: [],
      checklistRefs: [],
      verificationIntentRefs: [],
      status: 'not_applicable',
    },
  ]) as unknown as MilestoneLedgerData);
  const notApplicableDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: notApplicableStoryId, mode: 'observe' });
  assert.equal(notApplicableDone.equivalenceMode, 'strict_milestone', 'a confirmed ledger with rows uses strict milestone equivalence');
  assert.notEqual(notApplicableDone.status, 'pass', 'an all-not_applicable confirmed ledger without decisions must not vacuously pass');
  const notApplicableGap = notApplicableDone.gaps.find((gap: any) => gap.code === 'not_applicable_missing_decision');
  assert.ok(notApplicableGap, 'all-not_applicable ledger yields a not_applicable_missing_decision gap');
  assert.match(notApplicableGap.message, /M-na-1/, 'the not_applicable_missing_decision gap names the unjustified rows');
  assert.match(notApplicableGap.message, /M-na-2/, 'the not_applicable_missing_decision gap names every unjustified row');
  const notApplicableEnforce = run(root, 'done_intent_equivalence_check', { storyId: notApplicableStoryId, mode: 'enforce' }, true);
  assert.match(notApplicableEnforce, /not_applicable_missing_decision/, 'enforce mode blocks an all-not_applicable ledger without decisions');

  // Case 2: an EMPTY confirmed ledger on a milestone-path story must not be treated
  // as fully covered. Without the empty_confirmed_milestone_ledger guard the coverage
  // loop over zero rows would produce no gaps and the milestone path would pass silently.
  const emptyLedgerStoryId = 'B-empty-confirmed-ledger';
  const emptyLedgerStory: StoryInfo = {
    storyId: emptyLedgerStoryId,
    name: 'empty-confirmed-ledger',
    title: 'Deliver all milestones',
    description: 'Deliver all remaining milestones for the accepted intent.',
    type: 'feature',
    phase: 'TEST',
    priority: 'medium',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    events: [],
  };
  store.writeStory(emptyLedgerStoryId, emptyLedgerStory);
  store.writeChecklist(emptyLedgerStoryId, { items: [] });
  store.writeMilestoneLedger(emptyLedgerStoryId, confirmedLedger(emptyLedgerStoryId, []) as unknown as MilestoneLedgerData);
  const emptyLedgerDone = jsonRun(root, 'done_intent_equivalence_check', { storyId: emptyLedgerStoryId, mode: 'observe' });
  assert.equal(emptyLedgerDone.equivalenceMode, 'strict_milestone', 'a structural-milestone story stays on the strict milestone path');
  assert.notEqual(emptyLedgerDone.status, 'pass', 'an empty confirmed ledger must not be reported as fully covered');
  assert.ok(
    emptyLedgerDone.gaps.some((gap: any) => gap.code === 'empty_confirmed_milestone_ledger'),
    'an empty confirmed ledger on the milestone path yields an empty_confirmed_milestone_ledger gap',
  );
  assert.deepEqual(
    emptyLedgerDone.uncoveredRequiredMilestoneIds,
    [],
    'the empty-ledger guard is a ledger-shape gap, not a per-row uncovered-milestone report',
  );
  const emptyLedgerEnforce = run(root, 'done_intent_equivalence_check', { storyId: emptyLedgerStoryId, mode: 'enforce' }, true);
  assert.match(emptyLedgerEnforce, /empty_confirmed_milestone_ledger/, 'enforce mode blocks an empty confirmed ledger on the milestone path');

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
