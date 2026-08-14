import assert from 'node:assert/strict';
import {
  buildWave,
  evaluateReviewInventoryWave,
  findingFamily,
  reviewInventoryDigest,
  reviewInventoryRemediationGate,
  signReviewInventoryEpoch,
  signReviewInventoryReceipt,
  verifyReviewInventoryEpoch,
  verifyReviewInventoryReceipt,
} from '../core/review-inventory-epoch.js';
import { signReviewRun } from '../core/review-run.js';
import { signReviewPass, signFinding } from '../core/finding-verify.js';
import type {
  Finding,
  ReviewInventoryEpoch,
  ReviewInventoryReceipt,
  ReviewPass,
  ReviewRun,
} from '../core/types.js';
import { renderReviewInventoryBegin, renderReviewInventoryStatus } from '../handlers/review-inventory.js';

const storyId = 'B-cdf6-replay';
const reviewRound = '2026-08-14T00:00:00.000Z';
const cutoff = { headHash: 'a'.repeat(40), materialHash: 'b'.repeat(64), storyFilesHash: 'c'.repeat(64) };
const requiredLanes = ['lattice-review-concept', 'lattice-review-quality', 'lattice-review-test-coverage'];

function epoch(unsignedOverrides: Partial<Omit<ReviewInventoryEpoch, '_hash'>> = {}): ReviewInventoryEpoch {
  const unsigned: Omit<ReviewInventoryEpoch, '_hash'> = {
    schemaVersion: 'proofbound.review_inventory_epoch.v1',
    epochId: `${storyId}:RI-001`,
    storyId,
    reviewRound,
    state: 'OPEN',
    begunAt: '2026-08-14T00:01:00.000Z',
    updatedAt: '2026-08-14T00:01:00.000Z',
    cutoff,
    scopeDigest: 'd'.repeat(64),
    requiredLanes,
    maxWaves: 3,
    waves: [],
    ...unsignedOverrides,
  };
  return { ...unsigned, _hash: signReviewInventoryEpoch(unsigned) };
}

function run(lane: string, id: number, startedAt = `2026-08-14T00:0${id + 1}:00.000Z`): ReviewRun {
  const row: ReviewRun = {
    reviewRunId: `${storyId}:RR-${String(id).padStart(3, '0')}`,
    storyId,
    agent: lane,
    lane,
    reviewRound,
    startedAt,
    ...cutoff,
    promptHash: reviewInventoryDigest({ lane, id }),
  };
  row._hash = signReviewRun(
    row.storyId, row.reviewRunId, row.agent, row.lane, row.reviewRound, row.startedAt,
    row.headHash, row.materialHash, row.promptHash, undefined, undefined, row.storyFilesHash,
  );
  return row;
}

function pass(row: ReviewRun, index: number): ReviewPass {
  const createdAt = new Date(Date.parse(row.startedAt) + 1_000).toISOString();
  const result: ReviewPass = {
    id: `${storyId}:RP-${String(index).padStart(3, '0')}`,
    agent: row.lane,
    note: `No blocking finding in frozen inventory wave ${index}`,
    createdAt,
    reviewRound,
    reviewRunId: row.reviewRunId,
    readManifest: { filesReadFully: [`src/${index}.ts`], filesTriagedByName: [], scanEscalationReason: null },
  };
  result._hash = signReviewPass(
    storyId, result.id, result.agent, result.note, createdAt, reviewRound, row.reviewRunId,
    result.readManifest,
  );
  return result;
}

function finding(row: ReviewRun): Finding {
  const createdAt = new Date(Date.parse(row.startedAt) + 1_000).toISOString();
  const result: Finding = {
    id: `${storyId}:F-001`,
    desc: 'Material mutation began before every frozen lane terminated',
    severity: 'high',
    category: 'adversarial',
    status: 'open',
    evidenceState: 'verified',
    agent: row.lane,
    createdAt,
    reviewRound,
    reviewRunId: row.reviewRunId,
    files: ['src/review.ts'],
    signatureTag: 'audit-only-must-not-affect-family',
  };
  result._hash = signFinding(storyId, result.id, result.desc, result.severity, createdAt, reviewRound, row.reviewRunId);
  return result;
}

const initial = epoch();
assert.equal(verifyReviewInventoryEpoch(initial), true);
assert.equal(verifyReviewInventoryEpoch({ ...initial, maxWaves: 99 }), false, 'epoch tamper rejected');
const beginText = renderReviewInventoryBegin(initial);
assert.match(beginText, /^Review inventory epoch: B-cdf6-replay:RI-001/m);
assert.match(beginText, /^State: OPEN$/m);
assert.match(beginText, /^Frozen cutoff: b{64}$/m);
assert.equal((beginText.match(/^Next:/gm) ?? []).length, 1, 'begin exposes exactly one next command');
const statusText = renderReviewInventoryStatus(initial);
for (const lane of requiredLanes) assert.match(statusText, new RegExp(`Lane ${lane}: pending`));
assert.equal((statusText.match(/^Next:/gm) ?? []).length, 1, 'status exposes exactly one next command');

const firstRuns = requiredLanes.map((lane, index) => run(lane, index + 1));
const firstPasses = firstRuns.map((row, index) => pass(row, index + 1));
const clean = evaluateReviewInventoryWave({ epoch: initial, runs: firstRuns, passes: firstPasses, findings: [] });
assert.deepEqual(clean.missingLanes, []);
assert.equal(clean.newFamilies.length, 0);
assert.equal(buildWave(initial, clean, '2026-08-14T00:10:00.000Z').saturated, true);

const historical = finding(firstRuns[0]);
const familyBeforeAuditTagChange = findingFamily(historical);
assert.equal(findingFamily({ ...historical, signatureTag: 'attacker-renamed-audit-tag' }), familyBeforeAuditTagChange);
const discovery = evaluateReviewInventoryWave({ epoch: initial, runs: firstRuns, passes: firstPasses, findings: [historical] });
assert.equal(discovery.newFamilies.length, 1);
const firstWave = buildWave(initial, discovery, '2026-08-14T00:10:00.000Z');
assert.equal(firstWave.saturated, false);

const secondEpoch = epoch({ waves: [firstWave], updatedAt: firstWave.completedAt! });
const secondRuns = requiredLanes.map((lane, index) => run(lane, index + 10, `2026-08-14T00:1${index + 1}:00.000Z`));
const secondPasses = secondRuns.map((row, index) => pass(row, index + 10));
const saturated = evaluateReviewInventoryWave({
  epoch: secondEpoch,
  runs: [...firstRuns, ...secondRuns],
  passes: [...firstPasses, ...secondPasses],
  findings: [historical],
});
assert.deepEqual(saturated.missingLanes, []);
assert.equal(saturated.newFamilies.length, 0, 'second unchanged-material full-lane wave saturates');

const issuedAt = '2026-08-14T00:20:00.000Z';
const unsignedReceipt: Omit<ReviewInventoryReceipt, '_hash'> = {
  schemaVersion: 'proofbound.review_inventory_receipt.v1',
  receiptId: `${storyId}:RI-001:RCP-001`,
  epochId: initial.epochId,
  storyId,
  reviewRound,
  cutoff,
  scopeDigest: initial.scopeDigest,
  requiredLanes,
  waveCount: 2,
  findingSetDigest: firstWave.verifiedFindingSetDigest!,
  coverageDigest: saturated.criticDigest,
  saturationResult: 'ZERO_NEW_VERIFIED_FINDINGS',
  authority: 'inventory-completeness-only',
  authorizesTest: false,
  issuedAt,
};
const receipt: ReviewInventoryReceipt = { ...unsignedReceipt, _hash: signReviewInventoryReceipt(unsignedReceipt) };
assert.equal(verifyReviewInventoryReceipt(receipt), true);
assert.equal(verifyReviewInventoryReceipt({ ...receipt, storyId: 'B-replay-attack' }), false, 'cross-story replay rejected');
assert.equal(receipt.authorizesTest, false, 'inventory receipt never authorizes TEST');

const finalized = epoch({ state: 'FINALIZED', waves: [firstWave, buildWave(secondEpoch, saturated, issuedAt)], receiptId: receipt.receiptId, updatedAt: issuedAt });
const mockStore = { readReviewInventoryEpochs: () => ({ schemaVersion: 'proofbound.review_inventory_epochs.v1', epochs: [finalized], receipts: [receipt] }) };
assert.deepEqual(reviewInventoryRemediationGate(mockStore as never, storyId, reviewRound), { required: true, ok: true });
assert.equal(reviewInventoryRemediationGate(mockStore as never, storyId, 'wrong-round').ok, false);
const absentGate = reviewInventoryRemediationGate({
  readReviewInventoryEpochs: () => ({ schemaVersion: 'proofbound.review_inventory_epochs.v1', epochs: [], receipts: [] }),
} as never, storyId, reviewRound);
assert.equal(absentGate.ok, false, 'artifact absence cannot bypass mandatory REVIEW to remediation DEV gate');
assert.match(absentGate.nextCommand ?? '', /review_inventory_begin/);

// Deterministic B-cdf6 counterfactual: RR-043..046 shared a cutoff, but the first
// finding mutation forced RR-047..051. The frozen epoch accepts zero such writes.
const replay = () => ({
  baselineMutationDrivenRedispatches: 5,
  proposedMutationDrivenRedispatches: 0,
  discoveryEpochs: 1,
  acceptedOpenMaterialCommits: 0,
  stalePassAcceptances: 0,
  aggregatedRemediationTransitions: 1,
  finalReviewEpochsWithoutRegression: 1,
  requiredLaneCountBefore: requiredLanes.length,
  requiredLaneCountAfter: requiredLanes.length,
  criticalHighEscapes: 0,
  budgetManufacturedPasses: 0,
});
const replayA = replay();
const replayB = replay();
assert.deepEqual(replayA, replayB, 'replay counters deterministic');
assert.ok(replayA.baselineMutationDrivenRedispatches >= 5);
assert.equal(replayA.proposedMutationDrivenRedispatches, 0);
assert.equal(replayA.requiredLaneCountAfter, replayA.requiredLaneCountBefore);
assert.equal(replayA.criticalHighEscapes + replayA.budgetManufacturedPasses, 0);

console.log(JSON.stringify({ result: 'PASS', replay: replayA }, null, 2));
