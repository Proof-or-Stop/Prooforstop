#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import {
  consumeReviewInventoryReceipt,
  finalizedUnconsumedReviewInventory,
  signReviewInventoryEpoch,
  signReviewInventoryReceipt,
} from '../core/review-inventory-epoch.js';
import { signFinding } from '../core/finding-verify.js';
import type { Finding, StoryInfo } from '../core/types.js';
import { createReviewInventoryHandlers } from '../handlers/review-inventory.js';
import {
  computeCanonicalDependencyClosure,
  postRemediationReviewSelection,
  verifyCurrentPostRemediationReviewSelection,
  verifyPostRemediationReviewSelection,
} from '../core/review-incremental-context.js';
import { computeFinalReviewRoster, renderFinalReviewRoster, type ActiveReviewer } from '../handlers/reviewer-list.js';

const storyId = 'B-inventory-handler';
const reviewRound = '2020-01-01T00:00:00.000Z';
const cliPath = fileURLToPath(new URL('../../../../bin/lattice.js', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function cli(root: string, command: string, payload: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(process.execPath, [cliPath, '--root', root, command, JSON.stringify(payload)], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      LATTICE_OWNER_SESSION_ADAPTER_PROVIDER: process.env.LATTICE_OWNER_SESSION_ADAPTER_PROVIDER ?? 'codex-cli',
      ...env,
    },
  }).trim();
}

function cliAsync(root: string, command: string, payload: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => execFile(process.execPath, [cliPath, '--root', root, command, JSON.stringify(payload)], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      LATTICE_OWNER_SESSION_ADAPTER_PROVIDER: process.env.LATTICE_OWNER_SESSION_ADAPTER_PROVIDER ?? 'codex-cli',
      ...env,
    },
  }, (error, stdout, stderr) => resolve({ ok: !error, output: `${stdout}${stderr}` })));
}

function waitForFile(path: string, timeoutMs = 5_000): void {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'review-inventory-handler-'));
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  mkdirSync(join(root, 'packages/main/tests'), { recursive: true });
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', storyDir: '.lattice/story/actives', requirementsDir: 'docs/requirements',
  }));
  writeFileSync(join(root, 'packages/main/src/subject.ts'), 'export const subject = 1;\n');
  writeFileSync(join(root, 'packages/main/src/consumer-a.ts'), "export { subject } from './subject.js';\n");
  writeFileSync(join(root, 'packages/main/src/consumer-b.ts'), "export { subject } from './consumer-a.js';\n");
  writeFileSync(join(root, 'packages/main/tests/isolated.test.ts'), 'export const isolatedTest = 1;\n');
  git(root, ['init']);
  git(root, ['checkout', '-b', 'main']);
  git(root, ['config', 'user.name', 'lattice-implementer']);
  git(root, ['config', 'user.email', 'lattice-implementer@noreply.local']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial']);
  resetConfigCache();
  const store = new StoryStore(root);
  const story: StoryInfo = {
    storyId, name: 'inventory-handler-smoke', title: 'Inventory handler smoke',
    description: 'Exercise real review inventory handler persistence and fail-closed paths.',
    type: 'chore', phase: 'REVIEW', priority: 'high', createdAt: reviewRound,
    startedAt: reviewRound, endedAt: null, currentReviewRound: reviewRound,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: reviewRound }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, { items: [
    { id: 'CHK-001', title: 'Synthetic handler coverage', context: 'real handler smoke', status: 'done', files: [
      'packages/main/src/subject.ts',
      'packages/main/src/consumer-a.ts',
      'packages/main/src/consumer-b.ts',
      'packages/main/src/opaque.ts',
      'packages/main/tests/isolated.test.ts',
    ] },
  ] } as never);
  return { root, store, handlers: createReviewInventoryHandlers({ root, scanRoot: join(root, 'packages/main'), store }) };
}

const first = setup();
const criticDispatch = cli(first.root, 'dispatch', { storyId, agentType: 'lattice-review-topology-critic' }, {
  LATTICE_AGENT: 'lattice-review-topology-critic',
  LATTICE_SESSION_ID: 'sess-inventory-topology-critic',
});
assert.match(criticDispatch, /findingDispositions/);
const actualCriticRun = cli(first.root, 'review_run_start', { storyId, agent: 'lattice-review-topology-critic' }, {
  LATTICE_AGENT: 'lattice-review-topology-critic',
  LATTICE_SESSION_ID: 'sess-inventory-topology-critic',
});
assert.match(actualCriticRun, /Review run B-inventory-handler:RR-/);
const begin = cli(first.root, 'review_inventory_begin', { storyId, maxWaves: 2 });
assert.match(begin, /State: OPEN/);
assert.match(first.handlers.review_inventory_status({ storyId }), /REVIEW_INVENTORY_LANES_INCOMPLETE/);
assert.match(cli(first.root, 'review_inventory_status', { storyId }), /REVIEW_INVENTORY_LANES_INCOMPLETE/);
const reloaded = new StoryStore(first.root);
assert.equal(reloaded.readReviewInventoryEpochs(storyId).epochs.length, 1, 'begin persists across store reload');
const epoch = reloaded.readReviewInventoryEpochs(storyId).epochs[0];
const beforeIncompleteAdvance = JSON.stringify(reloaded.readReviewInventoryEpochs(storyId));
assert.throws(
  () => cli(first.root, 'review_inventory_wave_advance', { storyId }),
  /REVIEW_INVENTORY_LANES_INCOMPLETE/,
  'real wave_advance rejects incomplete lanes',
);
assert.equal(JSON.stringify(reloaded.readReviewInventoryEpochs(storyId)), beforeIncompleteAdvance, 'incomplete wave rejection is side-effect free');
const readManifest = { filesReadFully: ['packages/main/src/subject.ts'], filesTriagedByName: [], scanEscalationReason: null };
const readEvents = [{ path: 'packages/main/src/subject.ts', mode: 'full', action: 'Read', tokenCount: 8 }];
let realFindingId = '';
const firstWaveRuns = new Map<string, { reviewRunId: string; sessionId: string }>();
for (const [index, lane] of epoch.requiredLanes.entries()) {
  const sessionId = `sess-inventory-${lane}`;
  cli(first.root, 'dispatch', { storyId, agentType: lane }, { LATTICE_AGENT: lane, LATTICE_SESSION_ID: sessionId });
  const started = cli(first.root, 'review_run_start', { storyId, agent: lane }, { LATTICE_AGENT: lane, LATTICE_SESSION_ID: sessionId });
  const reviewRunId = started.match(/Review run (\S+) started/)?.[1];
  assert.ok(reviewRunId, `real review_run_start must return a signed run for ${lane}: ${started}`);
  firstWaveRuns.set(lane, { reviewRunId, sessionId });
  if (index === 0) {
    const finding = cli(first.root, 'finding_add', {
      storyId,
      agent: lane,
      reviewRunId,
      desc: 'Synthetic verified family proving the real finding_add terminal path.',
      severity: 'medium',
      category: 'missing',
      evidenceState: 'verified',
      files: ['packages/main/src/subject.ts'],
      readManifest,
      readEvents,
    }, { LATTICE_AGENT: lane, LATTICE_SESSION_ID: sessionId });
    realFindingId = finding.match(/(B-inventory-handler:F-\d+)/)?.[1] ?? '';
    assert.ok(realFindingId, `real finding_add must persist an ID: ${finding}`);
  } else {
    cli(first.root, 'review_pass_set', {
      storyId,
      agent: lane,
      reviewRunId,
      note: `Real handler smoke found no blocker for ${lane}.`,
      readManifest,
      readEvents,
    }, { LATTICE_AGENT: lane, LATTICE_SESSION_ID: sessionId });
  }
}
const multiRunLane = epoch.requiredLanes[0];
const multiRunSession = `sess-inventory-newer-pass-${multiRunLane}`;
cli(first.root, 'dispatch', { storyId, agentType: multiRunLane }, { LATTICE_AGENT: multiRunLane, LATTICE_SESSION_ID: multiRunSession });
const newerSameLaneStarted = cli(first.root, 'review_run_start', { storyId, agent: multiRunLane }, {
  LATTICE_AGENT: multiRunLane, LATTICE_SESSION_ID: multiRunSession,
});
const newerSameLaneRunId = newerSameLaneStarted.match(/Review run (\S+) started/)?.[1];
assert.ok(newerSameLaneRunId);
cli(first.root, 'review_pass_set', {
  storyId, agent: multiRunLane, reviewRunId: newerSameLaneRunId,
  note: 'Newer same-lane pass must not hide the older run verified finding.', readManifest, readEvents,
}, { LATTICE_AGENT: multiRunLane, LATTICE_SESSION_ID: multiRunSession });
const beforeCriticAdvance = JSON.stringify(reloaded.readReviewInventoryEpochs(storyId));
assert.throws(
  () => cli(first.root, 'review_inventory_wave_advance', { storyId }),
  /REVIEW_INVENTORY_CRITIC_INCOMPLETE/,
  'real wave_advance rejects a complete lane set without critic authority',
);
assert.equal(JSON.stringify(reloaded.readReviewInventoryEpochs(storyId)), beforeCriticAdvance, 'critic-incomplete rejection is side-effect free');
cli(first.root, 'dispatch', { storyId, agentType: 'lattice-review-topology-critic' }, {
  LATTICE_AGENT: 'lattice-review-topology-critic', LATTICE_SESSION_ID: 'sess-inventory-critic-terminal',
});
const criticStarted = cli(first.root, 'review_run_start', { storyId, agent: 'lattice-review-topology-critic' }, {
  LATTICE_AGENT: 'lattice-review-topology-critic', LATTICE_SESSION_ID: 'sess-inventory-critic-terminal',
});
const criticReviewRunId = criticStarted.match(/Review run (\S+) started/)?.[1];
assert.ok(criticReviewRunId, `real critic review_run_start must return a signed run: ${criticStarted}`);
cli(first.root, 'review_pass_set', {
  storyId,
  agent: 'lattice-review-topology-critic',
  reviewRunId: criticReviewRunId,
  note: 'Independent critic reviewed the exact aggregate and lane coverage.',
  readManifest,
  readEvents,
}, { LATTICE_AGENT: 'lattice-review-topology-critic', LATTICE_SESSION_ID: 'sess-inventory-critic-terminal' });
const critic = cli(first.root, 'review_inventory_critic_set', {
  storyId, epochId: epoch.epochId, reviewRunId: criticReviewRunId,
  agent: 'lattice-review-topology-critic',
  findingDispositions: [{
    findingId: realFindingId,
    disposition: 'verified_family',
    familyKey: `finding:${realFindingId}`,
    reason: 'Independent critic conservatively retained this verified family',
  }],
}, { LATTICE_AGENT: 'lattice-review-topology-critic' });
assert.match(critic, /Completeness critic: complete/);
const discoveryStatus = cli(first.root, 'review_inventory_status', { storyId });
assert.match(discoveryStatus, /Blockers: REVIEW_INVENTORY_NEW_FINDINGS_REQUIRE_NEXT_WAVE/);
assert.match(discoveryStatus, /Next: lattice review_inventory_wave_advance/);
assert.equal((discoveryStatus.match(/^Next:/gm) ?? []).length, 1);
assert.throws(
  () => cli(first.root, 'review_inventory_finalize', { storyId }),
  /REVIEW_INVENTORY_NEW_FINDINGS_REQUIRE_NEXT_WAVE/,
  'finalize cannot persist a non-saturated wave as an implicit checkpoint',
);
assert.equal(reloaded.readReviewInventoryEpochs(storyId).epochs[0].waves.length, 0, 'rejected finalize is side-effect free');
const discoveryWave = cli(first.root, 'review_inventory_wave_advance', { storyId });
assert.match(discoveryWave, /State: OPEN/);
assert.match(discoveryWave, /Current wave: 2\/2/);
const oldWaveLane = epoch.requiredLanes[1];
const oldWaveRun = firstWaveRuns.get(oldWaveLane)!;
assert.throws(
  () => cli(first.root, 'review_pass_set', {
    storyId, agent: oldWaveLane, reviewRunId: oldWaveRun.reviewRunId,
    note: 'A late terminal from the prior wave must be rejected.', readManifest, readEvents,
  }, { LATTICE_AGENT: oldWaveLane, LATTICE_SESSION_ID: oldWaveRun.sessionId }),
  /REVIEW_INVENTORY_WAVE_EVIDENCE_SEALED/,
  'F031: wave checkpoint seals every ReviewRun that started before the new wave boundary',
);
// Force the already-persisted positive wave to be the configured budget edge,
// then prove the real CLI refuses before writing another checkpoint.
let budgetData = reloaded.readReviewInventoryEpochs(storyId);
const budgetEpoch = budgetData.epochs[0];
const { _hash: _budgetHash, ...budgetUnsigned } = budgetEpoch;
const exhaustedUnsigned = { ...budgetUnsigned, maxWaves: 1 };
budgetData.epochs[0] = { ...exhaustedUnsigned, _hash: signReviewInventoryEpoch(exhaustedUnsigned) };
reloaded.writeReviewInventoryEpochs(storyId, budgetData);
const beforeBudgetAdvance = JSON.stringify(reloaded.readReviewInventoryEpochs(storyId));
assert.throws(
  () => cli(first.root, 'review_inventory_wave_advance', { storyId }),
  /REVIEW_INVENTORY_BUDGET_EXHAUSTED/,
  'real wave_advance rejects exhaustion instead of manufacturing progress',
);
assert.equal(JSON.stringify(reloaded.readReviewInventoryEpochs(storyId)), beforeBudgetAdvance, 'budget rejection is side-effect free');
budgetData = reloaded.readReviewInventoryEpochs(storyId);
const exhaustedEpoch = budgetData.epochs[0];
const { _hash: _exhaustedHash, ...exhaustedBase } = exhaustedEpoch;
const restoredBudgetUnsigned = { ...exhaustedBase, maxWaves: 2 };
budgetData.epochs[0] = { ...restoredBudgetUnsigned, _hash: signReviewInventoryEpoch(restoredBudgetUnsigned) };
reloaded.writeReviewInventoryEpochs(storyId, budgetData);
const secondWaveRuns = new Map<string, { reviewRunId: string; sessionId: string }>();
for (const lane of epoch.requiredLanes) {
  const sessionId = `sess-inventory-wave2-${lane}`;
  cli(first.root, 'dispatch', { storyId, agentType: lane }, { LATTICE_AGENT: lane, LATTICE_SESSION_ID: sessionId });
  const started = cli(first.root, 'review_run_start', { storyId, agent: lane }, { LATTICE_AGENT: lane, LATTICE_SESSION_ID: sessionId });
  const reviewRunId = started.match(/Review run (\S+) started/)?.[1];
  assert.ok(reviewRunId, `second-wave review_run_start must return a signed run for ${lane}: ${started}`);
  secondWaveRuns.set(lane, { reviewRunId, sessionId });
  cli(first.root, 'review_pass_set', {
    storyId, agent: lane, reviewRunId,
    note: `Second complete unchanged-material wave found no new family for ${lane}.`,
    readManifest, readEvents,
  }, { LATTICE_AGENT: lane, LATTICE_SESSION_ID: sessionId });
}
cli(first.root, 'dispatch', { storyId, agentType: 'lattice-review-topology-critic' }, {
  LATTICE_AGENT: 'lattice-review-topology-critic', LATTICE_SESSION_ID: 'sess-inventory-wave2-critic',
});
const secondCriticStarted = cli(first.root, 'review_run_start', { storyId, agent: 'lattice-review-topology-critic' }, {
  LATTICE_AGENT: 'lattice-review-topology-critic', LATTICE_SESSION_ID: 'sess-inventory-wave2-critic',
});
const secondCriticReviewRunId = secondCriticStarted.match(/Review run (\S+) started/)?.[1];
assert.ok(secondCriticReviewRunId);
cli(first.root, 'review_pass_set', {
  storyId, agent: 'lattice-review-topology-critic', reviewRunId: secondCriticReviewRunId,
  note: 'Second-wave critic verified zero new finding families.', readManifest, readEvents,
}, { LATTICE_AGENT: 'lattice-review-topology-critic', LATTICE_SESSION_ID: 'sess-inventory-wave2-critic' });
cli(first.root, 'review_inventory_critic_set', {
  storyId, epochId: epoch.epochId, reviewRunId: secondCriticReviewRunId,
  agent: 'lattice-review-topology-critic', findingDispositions: [],
}, { LATTICE_AGENT: 'lattice-review-topology-critic' });
const beforeZeroNewAdvance = JSON.stringify(reloaded.readReviewInventoryEpochs(storyId));
assert.throws(
  () => cli(first.root, 'review_inventory_wave_advance', { storyId }),
  /REVIEW_INVENTORY_ZERO_NEW_READY_TO_FINALIZE/,
  'real wave_advance refuses the zero-new state reserved for finalize',
);
assert.equal(JSON.stringify(reloaded.readReviewInventoryEpochs(storyId)), beforeZeroNewAdvance, 'zero-new rejection is side-effect free');
const finalized = cli(first.root, 'review_inventory_finalize', { storyId });
assert.match(finalized, /State: FINALIZED/);
assert.ok(finalizedUnconsumedReviewInventory(reloaded, storyId), 'finalized signed receipt is visible to the begin barrier');
assert.throws(() => cli(first.root, 'review_inventory_begin', { storyId }), /REVIEW_INVENTORY_RECEIPT_UNCONSUMED/);
const finalizedData = reloaded.readReviewInventoryEpochs(storyId);
const receipt = finalizedData.receipts[0];
const sealedLane = epoch.requiredLanes[0];
const sealedRun = secondWaveRuns.get(sealedLane)!;
assert.throws(
  () => cli(first.root, 'review_pass_set', {
    storyId, agent: sealedLane, reviewRunId: sealedRun.reviewRunId,
    note: 'Late pass must not mutate a finalized review inventory.', readManifest, readEvents,
  }, { LATTICE_AGENT: sealedLane, LATTICE_SESSION_ID: sealedRun.sessionId }),
  /REVIEW_INVENTORY_EVIDENCE_SEALED/,
  'review_pass_set cannot append after FINALIZED',
);
assert.throws(
  () => cli(first.root, 'finding_add', {
    storyId, agent: sealedLane, reviewRunId: sealedRun.reviewRunId,
    desc: 'Late verified finding must not escape the finalized aggregate.',
    severity: 'medium', category: 'adversarial', evidenceState: 'verified',
    files: ['packages/main/src/subject.ts'], readManifest, readEvents,
  }, { LATTICE_AGENT: sealedLane, LATTICE_SESSION_ID: sealedRun.sessionId }),
  /REVIEW_INVENTORY_EVIDENCE_SEALED/,
  'finding_add cannot append after FINALIZED',
);
assert.equal(reloaded.readReviewInventoryEpochs(storyId).receipts[0]._hash, receipt._hash, 'sealed writer refusals preserve the receipt');

// Simulate an out-of-band/crash-era writer that bypassed the shared lock. The
// consumer must still recompute the live aggregate and reject the old receipt.
const findingsBeforeTamper = reloaded.readFindings(storyId);
const sourceFinding = findingsBeforeTamper.findings.find(row => row.id === realFindingId)!;
const lateId = `${storyId}:F-999`;
const lateCreatedAt = new Date(Date.parse(receipt.issuedAt) + 1).toISOString();
const lateDesc = 'Out-of-band late verified finding omitted from the finalized receipt.';
const lateFinding: Finding = {
  ...sourceFinding,
  id: lateId,
  desc: lateDesc,
  agent: sealedLane,
  createdAt: lateCreatedAt,
  reviewRunId: sealedRun.reviewRunId,
  reviewRound,
  _hash: signFinding(
    storyId, lateId, lateDesc, sourceFinding.severity, lateCreatedAt, reviewRound,
    sealedRun.reviewRunId, sourceFinding.readManifest, sourceFinding.readLog, sourceFinding.readDiagnostics,
  ),
};
findingsBeforeTamper.findings.push(lateFinding);
reloaded.writeFindings(storyId, findingsBeforeTamper);
assert.throws(
  () => consumeReviewInventoryReceipt(reloaded, storyId, reviewRound, epoch.cutoff),
  /REVIEW_INVENTORY_LIVE_AGGREGATE_CHANGED/,
  'consumer re-verifies live terminals/finding families instead of trusting a stale frozen aggregate',
);
const restoredFindings = reloaded.readFindings(storyId);
restoredFindings.findings = restoredFindings.findings.filter(row => row.id !== lateId);
reloaded.writeFindings(storyId, restoredFindings);
writeFileSync(join(first.root, 'packages/main/src/subject.ts'), 'export const subject = 99;\n');
assert.throws(
  () => cli(first.root, 'story_advance', { storyId, phase: 'DEV' }),
  /REVIEW_INVENTORY|cutoff|material|invalid/i,
  'real story_advance rejects a post-finalize pre-consumption material mutation',
);
assert.equal(reloaded.readStory(storyId).phase, 'REVIEW', 'TOCTOU rejection cannot publish DEV');
assert.equal(reloaded.readReviewInventoryEpochs(storyId).receipts[0].consumedAt, undefined, 'TOCTOU rejection cannot consume the receipt');
writeFileSync(join(first.root, 'packages/main/src/subject.ts'), 'export const subject = 1;\n');
const remediationAdvance = cli(first.root, 'story_advance', { storyId, phase: 'DEV' });
assert.match(remediationAdvance, /DEV/);
assert.equal(reloaded.readStory(storyId).phase, 'DEV', 'real story_advance consumes the receipt before publishing DEV');
assert.throws(() => consumeReviewInventoryReceipt(reloaded, storyId, reviewRound, epoch.cutoff), /REVIEW_INVENTORY_REMEDIATION_BLOCKED/);
assert.equal(reloaded.readReviewInventoryEpochs(storyId).receipts[0].receiptId, receipt.receiptId);
assert.throws(
  () => cli(first.root, 'finding_add', {
    storyId, agent: sealedLane, reviewRunId: sealedRun.reviewRunId,
    desc: 'An old review run cannot append evidence after DEV phase publication.',
    severity: 'medium', category: 'adversarial', evidenceState: 'verified',
    files: ['packages/main/src/subject.ts'], readManifest, readEvents,
  }, { LATTICE_AGENT: sealedLane, LATTICE_SESSION_ID: sealedRun.sessionId }),
  /REVIEW_EVIDENCE_PHASE_REQUIRED/,
  'F030: reviewer evidence is phase-bound, so DEV cannot accept an old-run writer',
);

const postRemediationStory = reloaded.readStory(storyId);
postRemediationStory.currentReviewRound = '2020-01-02T00:00:00.000Z';
reloaded.writeStory(storyId, postRemediationStory);
writeFileSync(join(first.root, 'packages/main/tests/isolated.test.ts'), 'export const isolatedTest = 2;\n');
git(first.root, ['add', 'packages/main/tests/isolated.test.ts']);
git(first.root, ['commit', '-m', 'narrow post-remediation repair']);
const activeReviewers: ActiveReviewer[] = [
  { name: 'concept', reason: 'baseline' },
  { name: 'quality', reason: 'baseline' },
  { name: 'test-coverage', reason: 'baseline' },
  { name: 'behavior', reason: 'riskSignal: gate' },
  { name: 'docs', reason: 'touchpoints .md' },
];
const narrowClosure = computeCanonicalDependencyClosure(first.root, ['packages/main/tests/isolated.test.ts']);
assert.equal(narrowClosure.complete, true, JSON.stringify(narrowClosure));
const narrowSelection = postRemediationReviewSelection(reloaded, first.root, storyId, activeReviewers);
assert.equal(narrowSelection.selection, 'dependency-closure', JSON.stringify(narrowSelection));
assert.deepEqual(narrowSelection.selectedLanes, [
  'lattice-review-quality',
  'lattice-review-test-coverage',
]);
assert.equal(narrowSelection.requiredHostAssurance, 'unchanged');
assert.equal(verifyPostRemediationReviewSelection(narrowSelection), true);
assert.equal(verifyCurrentPostRemediationReviewSelection(reloaded, first.root, storyId, narrowSelection, activeReviewers), true);
for (const forged of [
  { ...narrowSelection, _hash: '' },
  { ...narrowSelection, storyId: 'B-cross-story' },
  { ...narrowSelection, reviewRound: 'cross-round' },
  { ...narrowSelection, headHash: '0'.repeat(40) },
  { ...narrowSelection, materialHash: '0'.repeat(64) },
  { ...narrowSelection, storyFilesHash: '0'.repeat(64) },
]) {
  assert.equal(verifyPostRemediationReviewSelection(forged), false, 'unsigned, cross-boundary, or forged lineage cannot narrow final review');
}
const roster = computeFinalReviewRoster(reloaded, first.root, storyId, activeReviewers);
assert.deepEqual(roster.requiredReviewers.map(row => row.name), ['quality', 'test-coverage']);
const rosterStatus = renderFinalReviewRoster(roster, storyId);
assert.match(rosterStatus, /^Final-review lanes: lattice-review-quality, lattice-review-test-coverage$/m);
assert.match(rosterStatus, /^Selection: dependency-closure \(PROVEN_CANONICAL_DEPENDENCY_CLOSURE: 1 changed file\(s\) close over 1 tracked dependency file\(s\)\)$/m);
assert.equal((rosterStatus.match(/^Next:/gm) ?? []).length, 1);
assert.deepEqual(
  computeCanonicalDependencyClosure(first.root, ['packages/main/src/subject.ts', 'packages/main/src/subject.ts']),
  computeCanonicalDependencyClosure(first.root, ['packages/main/src/subject.ts']),
  'dependency closure canonicalizes ordering and duplicate inputs',
);

writeFileSync(join(first.root, 'packages/main/tests/isolated.test.ts'), 'export const isolatedTest = 3;\n');
const dirtySelection = postRemediationReviewSelection(reloaded, first.root, storyId, activeReviewers);
assert.equal(dirtySelection.selection, 'full-set');
assert.equal(dirtySelection.reason, 'DIRTY_MATERIAL');
assert.equal(verifyCurrentPostRemediationReviewSelection(reloaded, first.root, storyId, narrowSelection, activeReviewers), false, 'dirty material invalidates a prior narrow selection even though HEAD is unchanged');
writeFileSync(join(first.root, 'packages/main/tests/isolated.test.ts'), 'export const isolatedTest = 2;\n');

writeFileSync(join(first.root, '.git/info/exclude'), 'packages/main/src/ignored.ts\n');
writeFileSync(join(first.root, 'packages/main/src/ignored.ts'), 'export const ignored = true;\n');
const ignoredSelection = postRemediationReviewSelection(reloaded, first.root, storyId, activeReviewers);
assert.equal(ignoredSelection.selection, 'full-set');
assert.equal(ignoredSelection.reason, 'UNTRACKED_OR_IGNORED_MATERIAL');
unlinkSync(join(first.root, 'packages/main/src/ignored.ts'));

git(first.root, ['mv', 'packages/main/src/subject.ts', 'packages/main/src/renamed-subject.ts']);
git(first.root, ['commit', '-m', 'inject unsupported rename']);
const renameSelection = postRemediationReviewSelection(reloaded, first.root, storyId, activeReviewers);
assert.equal(renameSelection.selection, 'full-set');
assert.equal(renameSelection.reason, 'UNSUPPORTED_RENAME_OR_DELETE');
git(first.root, ['mv', 'packages/main/src/renamed-subject.ts', 'packages/main/src/subject.ts']);
git(first.root, ['commit', '-m', 'restore canonical subject path']);

writeFileSync(join(first.root, 'packages/main/src/consumer-a.ts'), "export { subject } from './subject.js'; export const a = 2;\n");
writeFileSync(join(first.root, 'packages/main/src/consumer-b.ts'), "export { subject } from './consumer-a.js'; export const b = 2;\n");
git(first.root, ['add', 'packages/main/src/consumer-a.ts', 'packages/main/src/consumer-b.ts']);
git(first.root, ['commit', '-m', 'add transitive shared dependants']);
const expandedClosure = computeCanonicalDependencyClosure(first.root, ['packages/main/src/subject.ts']);
assert.equal(expandedClosure.complete, true, JSON.stringify(expandedClosure));
assert.deepEqual(expandedClosure.files, [
  'packages/main/src/consumer-a.ts',
  'packages/main/src/consumer-b.ts',
  'packages/main/src/subject.ts',
]);
assert.equal(verifyCurrentPostRemediationReviewSelection(reloaded, first.root, storyId, narrowSelection, activeReviewers), false, 'new dependency invalidates the prior narrow selection binding');
const recomputedSelection = postRemediationReviewSelection(reloaded, first.root, storyId, activeReviewers);
assert.notEqual(recomputedSelection._hash, narrowSelection._hash);
assert.ok(recomputedSelection.closureFiles.includes('packages/main/src/consumer-b.ts'), 'current-material recomputation follows transitive dependants');

writeFileSync(join(first.root, 'packages/main/src/untracked.ts'), 'export const hidden = true;\n');
const untrackedSelection = postRemediationReviewSelection(reloaded, first.root, storyId, activeReviewers);
assert.equal(untrackedSelection.selection, 'full-set');
assert.equal(untrackedSelection.reason, 'UNTRACKED_OR_IGNORED_MATERIAL');
unlinkSync(join(first.root, 'packages/main/src/untracked.ts'));

writeFileSync(join(first.root, 'packages/main/src/opaque.ts'), "declare const target: string; export const load = () => import(target);\n");
git(first.root, ['add', 'packages/main/src/opaque.ts']);
git(first.root, ['commit', '-m', 'inject opaque dependency']);
const opaqueSelection = postRemediationReviewSelection(reloaded, first.root, storyId, activeReviewers);
assert.equal(opaqueSelection.selection, 'full-set');
assert.equal(opaqueSelection.reason, 'DEPENDENCY_CLOSURE_INCOMPLETE');
assert.match(opaqueSelection.reasonDetail, /opaque dynamic dependency/);
assert.deepEqual(opaqueSelection.selectedLanes, opaqueSelection.activeLanes);
const opaqueStatus = renderFinalReviewRoster(computeFinalReviewRoster(reloaded, first.root, storyId, activeReviewers), storyId);
assert.match(opaqueStatus, /^Selection: full-set \(DEPENDENCY_CLOSURE_INCOMPLETE: opaque dynamic dependency:/m);
assert.equal((opaqueStatus.match(/^Next:/gm) ?? []).length, 1);
assert.equal(computeCanonicalDependencyClosure(first.root, ['../subject.ts']).complete, false, 'path traversal cannot enter the canonical source inventory');

const expandedChecklist = reloaded.readChecklist(storyId);
expandedChecklist.items[0].files = { modify: ['packages/main/src/subject.ts', 'packages/main/src/expanded.ts'], create: [], test: [] };
reloaded.writeChecklist(storyId, expandedChecklist);
const expandedScopeSelection = postRemediationReviewSelection(reloaded, first.root, storyId, activeReviewers);
assert.equal(expandedScopeSelection.selection, 'full-set');
assert.equal(expandedScopeSelection.reason, 'SCOPE_OR_POLICY_CHANGED');
assert.deepEqual(expandedScopeSelection.selectedLanes, narrowSelection.activeLanes, 'scope expansion restores every active lane');

const provenance = [
  ['8e9f72fc5424f499cb396ad92bc13558d88fb712', 'B-cdf6:RR-043'],
  ['57bbc87d5faba0610cca88e088af1b54a327c0ef', 'B-cdf6:RR-044'],
  ['8e9f72fc5424f499cb396ad92bc13558d88fb712', 'B-cdf6:RR-045'],
  ['8e9f72fc5424f499cb396ad92bc13558d88fb712', 'B-cdf6:RR-046'],
  ['26a30e6cd7f00672e2b399d5d8e7473a4cbb1360', 'B-cdf6:F-036'],
] as const;
for (const [commit, identifier] of provenance) {
  git(repositoryRoot, ['cat-file', '-e', `${commit}^{commit}`]);
  git(repositoryRoot, ['grep', '-q', '-F', identifier, commit, '--', '.lattice/story/actives/B-cdf6']);
}
git(repositoryRoot, ['cat-file', '-e', '155e787d0c92612f16e9c2dd011531b0caa18ee6^{commit}']);
const decisionText = readFileSync(join(repositoryRoot, 'docs/requirements/decisions/review-inventory-epoch-and-saturation-gate.md'), 'utf8');
for (const [, identifier] of provenance) assert.ok(decisionText.includes(identifier), `decision provenance must cite ${identifier}`);
assert.ok(decisionText.includes('155e787d0c92612f16e9c2dd011531b0caa18ee6'), 'decision provenance must cite the exact material-fix commit');
assert.ok(!decisionText.includes('claude-session-b-cdf6-review-convergence-analysis-and-optimization.md'), 'decision provenance cannot depend on the excluded analysis document');
console.log('B3F3D-006-H3 docs/provenance: PASS');

const symlinkCase = setup();
symlinkSync('subject.ts', join(symlinkCase.root, 'packages/main/src/subject-alias.ts'));
git(symlinkCase.root, ['add', 'packages/main/src/subject-alias.ts']);
git(symlinkCase.root, ['commit', '-m', 'inject source alias']);
const symlinkClosure = computeCanonicalDependencyClosure(symlinkCase.root, ['packages/main/src/subject-alias.ts']);
assert.equal(symlinkClosure.complete, false);
assert.match(symlinkClosure.reason ?? '', /symlink/);

const cancelled = setup();
cli(cancelled.root, 'review_inventory_begin', { storyId });
assert.match(cli(cancelled.root, 'review_inventory_cancel', { storyId, reason: 'operator cancels this real handler smoke epoch' }), /State: CANCELLED/);
assert.match(cli(cancelled.root, 'review_inventory_begin', { storyId }), /State: OPEN/, 'cancelled epoch permits a fresh persisted epoch');

const cancelRace = setup();
cli(cancelRace.root, 'review_inventory_begin', { storyId });
const raceLane = 'lattice-review-concept';
const raceSession = 'sess-inventory-cancel-race';
cli(cancelRace.root, 'dispatch', { storyId, agentType: raceLane }, { LATTICE_AGENT: raceLane, LATTICE_SESSION_ID: raceSession });
const raceStarted = cli(cancelRace.root, 'review_run_start', { storyId, agent: raceLane }, { LATTICE_AGENT: raceLane, LATTICE_SESSION_ID: raceSession });
const raceRunId = raceStarted.match(/Review run (\S+) started/)?.[1];
assert.ok(raceRunId);
const [cancelRaceResult, findingRaceResult] = await Promise.all([
  cliAsync(cancelRace.root, 'review_inventory_cancel', { storyId, reason: 'concurrent late evidence recovery race' }),
  cliAsync(cancelRace.root, 'finding_add', {
    storyId, agent: raceLane, reviewRunId: raceRunId,
    desc: 'Concurrent finding is either durably before cancel or rejected after its boundary.',
    severity: 'high', category: 'adversarial', evidenceState: 'verified',
    files: ['packages/main/src/subject.ts'], readManifest, readEvents,
  }, { LATTICE_AGENT: raceLane, LATTICE_SESSION_ID: raceSession }),
]);
assert.equal(cancelRaceResult.ok, true, cancelRaceResult.output);
if (!findingRaceResult.ok) assert.match(findingRaceResult.output, /REVIEW_INVENTORY_EVIDENCE_SEALED/);
const racePersistedFindingIds = cancelRace.store.readFindings(storyId).findings.map(row => row.id).sort();
cli(cancelRace.root, 'review_inventory_begin', { storyId });
assert.deepEqual(
  cancelRace.store.readReviewInventoryEpochs(storyId).epochs.at(-1)!.baselineFindingIds,
  racePersistedFindingIds,
  'cancel-vs-finding lock order either rejects the late writer or carries its durable finding into the fresh epoch',
);

const finalizedRecovery = setup();
const recoveryCutoff = finalizedRecovery.handlers.review_inventory_begin({ storyId });
assert.match(recoveryCutoff, /State: OPEN/);
let recoveryData = finalizedRecovery.store.readReviewInventoryEpochs(storyId);
const recoveryEpoch = recoveryData.epochs[0];
const recoveryIssuedAt = new Date().toISOString();
const recoveryReceiptUnsigned = {
  schemaVersion: 'proofbound.review_inventory_receipt.v1' as const,
  receiptId: `${recoveryEpoch.epochId}:RCP-001`, epochId: recoveryEpoch.epochId, storyId,
  reviewRound, cutoff: recoveryEpoch.cutoff, scopeDigest: recoveryEpoch.scopeDigest,
  requiredLanes: recoveryEpoch.requiredLanes, waveCount: 1,
  findingSetDigest: 'f'.repeat(64), coverageDigest: 'e'.repeat(64),
  saturationResult: 'ZERO_NEW_VERIFIED_FINDINGS' as const,
  authority: 'inventory-completeness-only' as const, authorizesTest: false as const,
  issuedAt: recoveryIssuedAt,
};
const recoveryFinalizedUnsigned = {
  ...recoveryEpoch, state: 'FINALIZED' as const, updatedAt: recoveryIssuedAt,
  receiptId: recoveryReceiptUnsigned.receiptId,
};
delete (recoveryFinalizedUnsigned as Partial<typeof recoveryFinalizedUnsigned>)._hash;
recoveryData.epochs[0] = { ...recoveryFinalizedUnsigned, _hash: signReviewInventoryEpoch(recoveryFinalizedUnsigned) };
recoveryData.receipts.push({ ...recoveryReceiptUnsigned, _hash: signReviewInventoryReceipt(recoveryReceiptUnsigned) });
finalizedRecovery.store.writeReviewInventoryEpochs(storyId, recoveryData);
assert.match(
  cli(finalizedRecovery.root, 'review_inventory_cancel', { storyId, reason: 'genuine late finding requires a fresh signed inventory' }),
  /State: CANCELLED/,
  'F029: operator can signed-invalidate an unconsumed FINALIZED receipt',
);
recoveryData = finalizedRecovery.store.readReviewInventoryEpochs(storyId);
assert.ok(recoveryData.receipts[0].invalidatedAt);
assert.equal(recoveryData.receipts[0].invalidationReason, 'genuine late finding requires a fresh signed inventory');
assert.equal(finalizedUnconsumedReviewInventory(finalizedRecovery.store, storyId), null);
assert.match(cli(finalizedRecovery.root, 'review_inventory_begin', { storyId }), /State: OPEN/);

const carryForward = setup();
const carryLane = 'lattice-review-concept';
const carrySession = 'sess-inventory-carry-forward';
cli(carryForward.root, 'dispatch', { storyId, agentType: carryLane }, { LATTICE_AGENT: carryLane, LATTICE_SESSION_ID: carrySession });
const carryStarted = cli(carryForward.root, 'review_run_start', { storyId, agent: carryLane }, { LATTICE_AGENT: carryLane, LATTICE_SESSION_ID: carrySession });
const carryRunId = carryStarted.match(/Review run (\S+) started/)?.[1];
assert.ok(carryRunId);
const carryFindingOutput = cli(carryForward.root, 'finding_add', {
  storyId, agent: carryLane, reviewRunId: carryRunId,
  desc: 'Pre-epoch verified finding must survive cancel and begin recovery.',
  severity: 'high', category: 'adversarial', evidenceState: 'verified',
  files: ['packages/main/src/subject.ts'], readManifest, readEvents,
}, { LATTICE_AGENT: carryLane, LATTICE_SESSION_ID: carrySession });
const carryFindingId = carryFindingOutput.match(/(B-inventory-handler:F-\d+)/)?.[1];
assert.ok(carryFindingId);
cli(carryForward.root, 'review_inventory_begin', { storyId });
let carryEpoch = carryForward.store.readReviewInventoryEpochs(storyId).epochs.at(-1)!;
assert.deepEqual(carryEpoch.baselineFindingIds, [carryFindingId], 'F032: begin signs the current-cutoff/current-round open verified baseline');
assert.ok(carryForward.handlers.review_inventory_status({ storyId }).includes('REVIEW_INVENTORY_FINDING_DISPOSITION_INCOMPLETE'));
cli(carryForward.root, 'review_inventory_cancel', { storyId, reason: 'exercise cancellation without losing a verified finding' });
cli(carryForward.root, 'review_inventory_begin', { storyId });
carryEpoch = carryForward.store.readReviewInventoryEpochs(storyId).epochs.at(-1)!;
assert.deepEqual(carryEpoch.baselineFindingIds, [carryFindingId], 'F032: cancellation/rebegin cannot erase an existing verified finding');

const scopeDrift = setup();
const scopeNow = new Date().toISOString();
scopeDrift.store.writeScopeContract(storyId, {
  storyId, mode: 'enforce',
  allowedModify: ['packages/main/src/subject.ts'], allowedCreate: [],
  allowedTest: ['packages/main/tests/isolated.test.ts'], protectedFiles: [], explicitExcludes: [],
  acknowledgements: [], createdAt: scopeNow, updatedAt: scopeNow,
});
cli(scopeDrift.root, 'review_inventory_begin', { storyId });
cli(scopeDrift.root, 'scope_contract_acknowledge', {
  storyId, paths: ['packages/main/src/consumer-a.ts'],
  reason: 'Expand the frozen review scope for deterministic drift coverage.',
});
const scopeDriftStatus = cli(scopeDrift.root, 'review_inventory_status', { storyId });
assert.match(scopeDriftStatus, /State: INVALIDATED/);
assert.match(scopeDriftStatus, /OPEN_REVIEW_INVENTORY_SCOPE_MUTATION/);
assert.throws(
  () => cli(scopeDrift.root, 'review_inventory_finalize', { storyId }),
  /no OPEN epoch/,
  'F035: begin -> scope acknowledgement invalidates old lanes and rejects finalize',
);

const longHolder = setup();
const longLanes = ['lattice-review-concept', 'lattice-review-quality'];
const longRuns = new Map<string, { reviewRunId: string; sessionId: string }>();
for (const lane of longLanes) {
  const sessionId = `sess-long-holder-${lane}`;
  cli(longHolder.root, 'dispatch', { storyId, agentType: lane }, { LATTICE_AGENT: lane, LATTICE_SESSION_ID: sessionId });
  const started = cli(longHolder.root, 'review_run_start', { storyId, agent: lane }, { LATTICE_AGENT: lane, LATTICE_SESSION_ID: sessionId });
  longRuns.set(lane, { reviewRunId: started.match(/Review run (\S+) started/)![1], sessionId });
}
const readyFile = join(longHolder.root, 'long-review-pass.ready');
const firstLong = longRuns.get(longLanes[0])!;
const secondLong = longRuns.get(longLanes[1])!;
const longHolderStartedAt = Date.now();
const firstLongPromise = cliAsync(longHolder.root, 'review_pass_set', {
  storyId, agent: longLanes[0], reviewRunId: firstLong.reviewRunId,
  note: 'Long live-holder pass remains authoritative beyond ten seconds.', readManifest, readEvents,
}, {
  LATTICE_AGENT: longLanes[0], LATTICE_SESSION_ID: firstLong.sessionId, NODE_ENV: 'test',
  LATTICE_INTERNAL_REVIEW_PASS_HOLD_MS: '11000',
  LATTICE_INTERNAL_REVIEW_PASS_READY_FILE: readyFile,
});
waitForFile(readyFile);
const secondLongPromise = cliAsync(longHolder.root, 'review_pass_set', {
  storyId, agent: longLanes[1], reviewRunId: secondLong.reviewRunId,
  note: 'Concurrent waiter must not reclaim a live review-pass lock.', readManifest, readEvents,
}, { LATTICE_AGENT: longLanes[1], LATTICE_SESSION_ID: secondLong.sessionId, NODE_ENV: 'test' });
const [firstLongResult, secondLongResult] = await Promise.all([firstLongPromise, secondLongPromise]);
assert.equal(firstLongResult.ok, true, firstLongResult.output);
assert.equal(secondLongResult.ok, true, secondLongResult.output);
assert.ok(Date.now() - longHolderStartedAt >= 10_500, 'F036 stress must actually cross the historical 10s stale threshold');
const durableLongPasses = longHolder.store.readReviewPasses(storyId).passes
  .filter(row => longLanes.includes(row.agent));
assert.equal(durableLongPasses.length, 2, 'F036: >10s live holder preserves both concurrent signed passes');
assert.equal(new Set(durableLongPasses.map(row => row.id)).size, 2, 'F036: atomic RMW assigns unique durable pass IDs');

const drifted = setup();
cli(drifted.root, 'review_inventory_begin', { storyId });
writeFileSync(join(drifted.root, 'packages/main/src/subject.ts'), 'export const subject = 2;\n');
git(drifted.root, ['add', 'packages/main/src/subject.ts']);
git(drifted.root, ['commit', '-m', 'mutate frozen review material']);
assert.throws(
  () => cli(drifted.root, 'review_inventory_wave_advance', { storyId }),
  /OPEN_REVIEW_INVENTORY_MATERIAL_MUTATION|State: INVALIDATED/,
  'real wave_advance detects frozen-cutoff drift before admission',
);
const driftedData = drifted.store.readReviewInventoryEpochs(storyId);
assert.equal(driftedData.epochs[0].state, 'INVALIDATED', 'drift persists only the intentional invalidation');
assert.equal(driftedData.epochs[0].waves.length, 0, 'drift rejection never persists a wave');
assert.equal(driftedData.receipts.length, 0, 'drift rejection never mints a receipt');
assert.throws(() => drifted.handlers.review_inventory_finalize({ storyId }), /no OPEN epoch/);

const unsupported = setup();
const unsupportedBegin = unsupported.handlers.review_inventory_begin({ storyId });
const unsupportedEpoch = unsupported.store.readReviewInventoryEpochs(storyId).epochs[0];
const before = JSON.stringify(unsupported.store.readReviewInventoryEpochs(storyId));
assert.throws(() => unsupported.handlers.review_inventory_critic_set({
  storyId, epochId: unsupportedEpoch.epochId, reviewRunId: 'unsupported-run',
  agent: 'lattice-review-topology-critic', findingDispositions: [],
}), /only lattice-review-topology-critic|agent_dispatch_mutation_denied|LANES_INCOMPLETE/);
assert.equal(JSON.stringify(unsupported.store.readReviewInventoryEpochs(storyId)), before, 'rejected critic mutation is side-effect free');
assert.match(unsupportedBegin, /Next: lattice review_inventory_status/);

console.log('review inventory real handler smoke: PASS');
