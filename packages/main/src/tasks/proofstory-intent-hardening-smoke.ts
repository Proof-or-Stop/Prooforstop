#!/usr/bin/env node
/**
 * Focused smoke coverage for ProofStory progressive intent hardening.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
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
  }, null, 2));
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
      status: 'covered',
    },
  });
  assert.equal(appendedLedger.milestones.length, 6, 'milestone_ledger_add appends a row');
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

  coverage = jsonRun(root, 'intent_coverage_check', { storyId, mode: 'observe' });
  assert.equal(coverage.missingMilestoneCoverage.length, 0, 'covered ledger rows clear milestone coverage gaps');
  assert.equal(coverage.missingAcceptanceBindings.length, 1, 'acceptance binding remains separate from milestone coverage');
  assert.equal(coverage.ledgerSizing.thresholdState, 'too_broad', 'six high-assurance milestones produce sizing diagnostics');

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

  const spikeStarted = jsonRun(root, 'spike_start', { storyId, id: 'SPIKE-A', question: 'Which auth gate path owns the regression?' });
  assert.equal(spikeStarted.spikes[0].status, 'active', 'spike_start records active investigation evidence');
  gate = jsonRun(root, 'proofstory_gate_check', { storyId, mode: 'observe' });
  assert.ok(gate.missingSpikeEvidence.some((gap: any) => gap.code === 'unresolved_spike_evidence'), 'active spike remains diagnostic');
  const spikeResolved = jsonRun(root, 'spike_result_set', { storyId, id: 'SPIKE-A', result: 'The existing lifecycle gate path owns the regression.' });
  assert.equal(spikeResolved.spikes[0].status, 'resolved', 'spike_result_set resolves investigation evidence');

  const redEvidence = jsonRun(root, 'red_evidence_create', {
    storyId,
    trigger: 'auth lifecycle gate regression',
    observedFailure: 'Before the fix, the auth gate accepts an invalid transition.',
    failingCommand: 'npm test -- auth-gate-red',
    expectedGreenCommand: 'npm test -- auth-gate-green',
  });
  assert.equal(redEvidence.records.length, 1, 'red_evidence_create records a pre-fix failure');

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
  assert.deepEqual(doneEquivalence.uncoveredRequiredMilestoneIds, ['M6'], 'DONE equivalence reports uncovered required milestones');
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
