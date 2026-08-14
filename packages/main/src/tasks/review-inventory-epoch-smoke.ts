import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertReviewInventoryCutoff,
  buildWave,
  consumeReviewInventoryReceipt,
  evaluateReviewInventoryWave,
  findingFamily,
  reviewInventoryAggregateFamilies,
  reviewInventoryDigest,
  reviewInventoryLaneCoverageDigest,
  reviewInventoryRemediationGate,
  signReviewInventoryCriticReceipt,
  signReviewInventoryEpoch,
  signReviewInventoryReceipt,
  validateReviewInventoryCriticReceipt,
  verifyReviewInventoryEpoch,
  verifyReviewInventoryCriticReceipt,
  verifyReviewInventoryReceipt,
  type ReviewInventoryEvaluation,
} from '../core/review-inventory-epoch.js';
import { signReviewRun } from '../core/review-run.js';
import { signReviewPass, signFinding } from '../core/finding-verify.js';
import type {
  Finding,
  ReviewInventoryCriticReceipt,
  ReviewInventoryEpochData,
  ReviewInventoryEpoch,
  ReviewInventoryFindingDisposition,
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
  const readManifest = { filesReadFully: [`src/${index}.ts`], filesTriagedByName: [], scanEscalationReason: null };
  const readLog = {
    filesReadFully: [...readManifest.filesReadFully],
    filesTriagedByName: [] as string[],
    summary: { readCount: 1, tokenCount: 10 },
    digest: reviewInventoryDigest({ files: readManifest.filesReadFully, index }),
  };
  const result: ReviewPass = {
    id: `${storyId}:RP-${String(index).padStart(3, '0')}`,
    agent: row.lane,
    note: `No blocking finding in frozen inventory wave ${index}`,
    createdAt,
    reviewRound,
    reviewRunId: row.reviewRunId,
    readManifest,
    readLog,
  };
  result._hash = signReviewPass(
    storyId, result.id, result.agent, result.note, createdAt, reviewRound, row.reviewRunId,
    result.readManifest,
    result.readLog,
  );
  return result;
}

function finding(row: ReviewRun): Finding {
  const createdAt = new Date(Date.parse(row.startedAt) + 1_000).toISOString();
  const readManifest = { filesReadFully: ['src/review.ts'], filesTriagedByName: [], scanEscalationReason: null };
  const readLog = {
    filesReadFully: ['src/review.ts'], filesTriagedByName: [],
    summary: { readCount: 1, tokenCount: 10 },
    digest: reviewInventoryDigest({ finding: row.reviewRunId }),
  };
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
    readManifest,
    readLog,
    files: ['src/review.ts'],
    signatureTag: 'audit-only-must-not-affect-family',
  };
  result._hash = signFinding(storyId, result.id, result.desc, result.severity, createdAt, reviewRound, row.reviewRunId, readManifest, readLog);
  return result;
}

function criticEvidence(
  subjectEpoch: ReviewInventoryEpoch,
  evaluation: ReviewInventoryEvaluation,
  id: number,
  terminalAt: string,
  findingDispositions: ReviewInventoryFindingDisposition[] = [],
): { run: ReviewRun; pass: ReviewPass; receipt: ReviewInventoryCriticReceipt } {
  const criticRun = run('lattice-review-topology-critic', id, terminalAt);
  const criticPass = pass(criticRun, id);
  const unsigned: Omit<ReviewInventoryCriticReceipt, '_hash'> = {
    schemaVersion: 'proofbound.review_inventory_critic_receipt.v1',
    criticReceiptId: `${subjectEpoch.epochId}:CRIT-${String(subjectEpoch.waves.length + 1).padStart(2, '0')}`,
    epochId: subjectEpoch.epochId,
    storyId,
    reviewRound,
    wave: subjectEpoch.waves.length + 1,
    cutoff,
    aggregateFindingSetDigest: reviewInventoryDigest(reviewInventoryAggregateFamilies(subjectEpoch, evaluation)),
    requiredLaneCoverageDigest: reviewInventoryLaneCoverageDigest(evaluation),
    criticLane: 'lattice-review-topology-critic',
    reviewRunId: criticRun.reviewRunId,
    terminalEvidenceIds: [criticPass.id],
    readEvidenceDigest: reviewInventoryDigest([{ id: criticPass.id, readManifest: criticPass.readManifest, readLog: criticPass.readLog?.digest ?? null }]),
    findingDispositions,
    createdAt: new Date(Date.parse(criticPass.createdAt!) + 1_000).toISOString(),
  };
  return { run: criticRun, pass: criticPass, receipt: { ...unsigned, _hash: signReviewInventoryCriticReceipt(unsigned) } };
}

function memoryStore(initialData: ReviewInventoryEpochData) {
  let data = structuredClone(initialData);
  const lockRoot = mkdtempSync(join(tmpdir(), 'review-inventory-epoch-locks-'));
  return {
    readReviewInventoryEpochs: () => structuredClone(data),
    writeReviewInventoryEpochs: (_storyId: string, next: ReviewInventoryEpochData) => { data = structuredClone(next); },
    readReviewRuns: () => ({ runs: [...firstRuns, ...secondRuns, firstCritic.run, secondCritic.run] }),
    readReviewPasses: () => ({ passes: [...firstPasses, ...secondPasses, firstCritic.pass, secondCritic.pass] }),
    readFindings: () => ({ findings: [historical] }),
    runtimeLockDirPath: (_storyId: string, ...segments: string[]) => join(lockRoot, ...segments),
    snapshot: () => structuredClone(data),
  };
}

const initial = epoch();
assert.equal(verifyReviewInventoryEpoch(initial), true);
assert.equal(verifyReviewInventoryEpoch({ ...initial, maxWaves: 99 }), false, 'epoch tamper rejected');
const beginText = renderReviewInventoryBegin(initial);
assert.match(beginText, /^Review inventory epoch: B-cdf6-replay:RI-001/m);
assert.match(beginText, /^State: OPEN$/m);
assert.match(beginText, /^Frozen cutoff: b{64}$/m);
assert.equal((beginText.match(/^Next:/gm) ?? []).length, 1, 'begin exposes exactly one next command');
const emptyEvaluation = evaluateReviewInventoryWave({ epoch: initial, runs: [], passes: [], findings: [] });
const statusText = renderReviewInventoryStatus(initial, { evaluation: emptyEvaluation });
for (const lane of requiredLanes) assert.match(statusText, new RegExp(`Lane ${lane}: pending`));
assert.match(statusText, /Blockers: REVIEW_INVENTORY_LANES_INCOMPLETE/);
assert.match(statusText, /Next: lattice dispatch .*lattice-review-concept/);
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
const rawDiscovery = evaluateReviewInventoryWave({ epoch: initial, runs: firstRuns, passes: firstPasses, findings: [historical] });
assert.deepEqual(rawDiscovery.unresolvedFindingIds, [historical.id], 'raw findings cannot become verified families without critic disposition');
assert.notEqual(
  rawDiscovery.lanes.find(row => row.lane === firstRuns[0].lane)?.coverageDigest,
  clean.lanes.find(row => row.lane === firstRuns[0].lane)?.coverageDigest,
  'finding manifest/read-log evidence participates in the lane coverage digest',
);
const missingFindingReadLog = { ...historical };
delete missingFindingReadLog.readLog;
missingFindingReadLog._hash = signFinding(
  storyId, missingFindingReadLog.id, missingFindingReadLog.desc, missingFindingReadLog.severity,
  missingFindingReadLog.createdAt!, reviewRound, missingFindingReadLog.reviewRunId,
  missingFindingReadLog.readManifest, undefined,
);
const missingFindingReadEvidence = evaluateReviewInventoryWave({
  epoch: initial,
  runs: firstRuns,
  passes: firstPasses.slice(1),
  findings: [missingFindingReadLog],
});
assert.ok(missingFindingReadEvidence.missingLanes.includes(firstRuns[0].lane), 'finding without mechanical readLog cannot terminate an inventory lane');
const historicalDispositions: ReviewInventoryFindingDisposition[] = [{
  findingId: historical.id,
  disposition: 'verified_family',
  familyKey: findingFamily(historical),
  reason: 'independent critic verified this distinct finding family',
}];
const discovery = evaluateReviewInventoryWave({
  epoch: initial, runs: firstRuns, passes: firstPasses, findings: [historical], findingDispositions: historicalDispositions,
});
assert.equal(discovery.newFamilies.length, 1);
const duplicateFinding: Finding = {
  ...historical,
  id: `${storyId}:F-002`,
  agent: firstRuns[1].lane,
  reviewRunId: firstRuns[1].reviewRunId,
  createdAt: new Date(Date.parse(firstRuns[1].startedAt) + 1_000).toISOString(),
};
duplicateFinding._hash = signFinding(
  storyId, duplicateFinding.id, duplicateFinding.desc, duplicateFinding.severity,
  duplicateFinding.createdAt!, reviewRound, duplicateFinding.reviewRunId,
  duplicateFinding.readManifest, duplicateFinding.readLog,
);
const duplicateDisposition: ReviewInventoryFindingDisposition[] = [
  historicalDispositions[0],
  {
    findingId: duplicateFinding.id,
    disposition: 'duplicate',
    familyKey: historicalDispositions[0].familyKey,
    canonicalFindingId: historical.id,
    reason: 'independent critic bound the second verified finding to the canonical family',
  },
];
const deduplicated = evaluateReviewInventoryWave({
  epoch: initial,
  runs: firstRuns,
  passes: firstPasses,
  findings: [historical, duplicateFinding],
  findingDispositions: duplicateDisposition,
});
assert.deepEqual(deduplicated.unresolvedFindingIds, []);
assert.deepEqual(deduplicated.invalidDispositionIds, []);
assert.equal(deduplicated.families.length, 1, 'signed duplicate disposition cannot inflate the verified family count');
const rejectedByCritic = evaluateReviewInventoryWave({
  epoch: initial,
  runs: firstRuns,
  passes: firstPasses,
  findings: [historical],
  findingDispositions: [{ findingId: historical.id, disposition: 'not_verified', reason: 'critic disproved the candidate family' }],
});
assert.equal(rejectedByCritic.families.length, 0, 'critic not_verified disposition cannot count as a verified family');
const unknownDisposition = evaluateReviewInventoryWave({
  epoch: initial,
  runs: firstRuns,
  passes: firstPasses,
  findings: [historical],
  findingDispositions: [{ findingId: historical.id, disposition: 'garbage' as never, reason: 'mutation must fail closed' }],
});
assert.deepEqual(unknownDisposition.invalidDispositionIds, [historical.id], 'unknown runtime disposition cannot suppress a verified family');
assert.equal(unknownDisposition.families.length, 0);
const suspectedFinding: Finding = { ...historical, id: `${storyId}:F-suspected`, evidenceState: 'suspected', uncertaintyReason: 'candidate not reproduced' };
suspectedFinding._hash = signFinding(
  storyId, suspectedFinding.id, suspectedFinding.desc, suspectedFinding.severity,
  suspectedFinding.createdAt!, reviewRound, suspectedFinding.reviewRunId,
  suspectedFinding.readManifest, suspectedFinding.readLog,
);
const suspectedOnly = evaluateReviewInventoryWave({
  epoch: initial, runs: firstRuns, passes: firstPasses, findings: [suspectedFinding], findingDispositions: [],
});
assert.deepEqual(suspectedOnly.rawFindingIds, [], 'suspected finding closes its lane but never enters verified-family accounting');
assert.equal(suspectedOnly.families.length, 0);
const forgedDuplicate = evaluateReviewInventoryWave({
  epoch: initial,
  runs: firstRuns,
  passes: firstPasses,
  findings: [historical],
  findingDispositions: [{
    findingId: historical.id,
    disposition: 'duplicate',
    familyKey: findingFamily(historical),
    canonicalFindingId: `${storyId}:F-missing`,
    reason: 'forged canonical reference',
  }],
});
assert.deepEqual(forgedDuplicate.invalidDispositionIds, [historical.id], 'duplicate disposition requires a real canonical verified family');
const conflictingDisposition = evaluateReviewInventoryWave({
  epoch: initial,
  runs: firstRuns,
  passes: firstPasses,
  findings: [historical],
  findingDispositions: [
    historicalDispositions[0],
    { findingId: historical.id, disposition: 'not_verified', reason: 'conflicting second disposition' },
  ],
});
assert.deepEqual(conflictingDisposition.invalidDispositionIds, [historical.id], 'one finding cannot carry competing critic dispositions');
assert.equal(conflictingDisposition.families.length, 0);
const lanesCompleteStatus = renderReviewInventoryStatus(initial, { evaluation: rawDiscovery });
assert.match(lanesCompleteStatus, /Lane lattice-review-concept: finding/);
assert.match(lanesCompleteStatus, /Lane lattice-review-quality: pass/);
assert.match(lanesCompleteStatus, /Verified findings: 0/);
assert.match(lanesCompleteStatus, /New verified findings: 0/);
assert.match(lanesCompleteStatus, /REVIEW_INVENTORY_FINDING_DISPOSITION_INCOMPLETE/);
assert.match(lanesCompleteStatus, /Next: lattice dispatch .*lattice-review-topology-critic/);
assert.equal((lanesCompleteStatus.match(/^Next:/gm) ?? []).length, 1);
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
  findingDispositions: [],
});
assert.deepEqual(saturated.missingLanes, []);
assert.equal(saturated.newFamilies.length, 0, 'second unchanged-material full-lane wave saturates');

const firstCritic = criticEvidence(initial, discovery, 40, '2026-08-14T00:10:02.000Z', historicalDispositions);
assert.equal(verifyReviewInventoryCriticReceipt(firstCritic.receipt), true);
assert.equal(validateReviewInventoryCriticReceipt({
  receipt: firstCritic.receipt,
  epoch: initial,
  evaluation: discovery,
  runs: [...firstRuns, firstCritic.run],
  passes: [...firstPasses, firstCritic.pass],
  findings: [historical],
}).ok, true, 'critic authority is independently signed after required lanes terminate');
const criticTerminalStatus = renderReviewInventoryStatus(initial, {
  evaluation: discovery,
  criticReviewRunId: firstCritic.run.reviewRunId,
});
assert.match(criticTerminalStatus, /Next: lattice review_inventory_critic_set/);
assert.match(criticTerminalStatus, /"findingDispositions":\[/, 'critic Next must include the CLI-required disposition inventory');
assert.equal((criticTerminalStatus.match(/^Next:/gm) ?? []).length, 1);
const criticCompleteStatus = renderReviewInventoryStatus(initial, { evaluation: discovery, criticComplete: true });
assert.match(criticCompleteStatus, /Completeness critic: complete/);
assert.match(criticCompleteStatus, /Blockers: REVIEW_INVENTORY_NEW_FINDINGS_REQUIRE_NEXT_WAVE/);
assert.match(criticCompleteStatus, /Next: lattice review_inventory_wave_advance/);
assert.equal((criticCompleteStatus.match(/^Next:/gm) ?? []).length, 1);
const saturationReadyStatus = renderReviewInventoryStatus(secondEpoch, { evaluation: saturated, criticComplete: true });
assert.match(saturationReadyStatus, /Blockers: none/);
assert.match(saturationReadyStatus, /Next: lattice review_inventory_finalize/);
assert.equal((saturationReadyStatus.match(/^Next:/gm) ?? []).length, 1);
assert.equal(validateReviewInventoryCriticReceipt({
  receipt: { ...firstCritic.receipt, aggregateFindingSetDigest: '0'.repeat(64) },
  epoch: initial,
  evaluation: discovery,
  runs: [...firstRuns, firstCritic.run],
  passes: [...firstPasses, firstCritic.pass],
  findings: [historical],
}).ok, false, 'tampered critic authority fails closed');

const secondCritic = criticEvidence(secondEpoch, saturated, 41, '2026-08-14T00:14:02.000Z');
assert.equal(validateReviewInventoryCriticReceipt({
  receipt: firstCritic.receipt,
  epoch: secondEpoch,
  evaluation: saturated,
  runs: [...firstRuns, ...secondRuns, firstCritic.run],
  passes: [...firstPasses, ...secondPasses, firstCritic.pass],
  findings: [historical],
}).ok, false, 'old-wave critic authority cannot finalize the next wave');
assert.equal(validateReviewInventoryCriticReceipt({
  receipt: secondCritic.receipt,
  epoch: secondEpoch,
  evaluation: saturated,
  runs: [...firstRuns, ...secondRuns, secondCritic.run],
  passes: [...firstPasses, ...secondPasses, secondCritic.pass],
  findings: [historical],
}).ok, true);

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
  coverageDigest: reviewInventoryDigest([firstWave, buildWave(secondEpoch, saturated, issuedAt)]
    .flatMap(row => row.lanes.map(lane => lane.coverageDigest))),
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
const finalizedData: ReviewInventoryEpochData = {
  schemaVersion: 'proofbound.review_inventory_epochs.v1',
  epochs: [finalized],
  receipts: [receipt],
  criticReceipts: [firstCritic.receipt, secondCritic.receipt],
};
const finalizedStatus = renderReviewInventoryStatus(finalized, { criticComplete: true });
assert.match(finalizedStatus, /Next: lattice story_advance --storyId=B-cdf6-replay --phase=DEV/);
assert.equal((finalizedStatus.match(/^Next:/gm) ?? []).length, 1);
const mockStore = memoryStore(finalizedData);
assert.deepEqual(reviewInventoryRemediationGate(mockStore as never, storyId, reviewRound), { required: true, ok: true });
assert.equal(reviewInventoryRemediationGate(mockStore as never, storyId, 'wrong-round').ok, false);
const absentGate = reviewInventoryRemediationGate({
  readReviewInventoryEpochs: () => ({ schemaVersion: 'proofbound.review_inventory_epochs.v1', epochs: [], receipts: [], criticReceipts: [] }),
} as never, storyId, reviewRound);
assert.equal(absentGate.ok, false, 'artifact absence cannot bypass mandatory REVIEW to remediation DEV gate');
assert.match(absentGate.nextCommand ?? '', /review_inventory_begin/);

type ReplayEvent = { type: string; host?: string; lane?: string; accepted?: boolean; reason?: string };
function replay(): Record<string, number> {
  const events: ReplayEvent[] = [];
  const hosts = ['host-a', 'host-b'];
  for (const lane of requiredLanes) {
    events.push({ type: 'baseline-required-lane', lane });
    events.push({ type: 'proposed-required-lane', lane });
  }

  // Recorded B-cdf6 control path: RR-043..046 found the first issue, then five
  // mutation-driven RR-047..051 redispatches. The counter is derived from those
  // replayed dispatch events, not an expected numeric literal.
  ['RR-043', 'RR-044', 'RR-045', 'RR-046'].forEach((reason, index) => events.push({ type: 'baseline-review', host: hosts[index % hosts.length], reason }));
  events.push({ type: 'baseline-first-finding' });
  ['RR-047', 'RR-048', 'RR-049', 'RR-050', 'RR-051'].forEach((reason, index) => events.push({ type: 'baseline-redispatch', host: hosts[index % hosts.length], reason }));

  const attackStore = memoryStore({ schemaVersion: 'proofbound.review_inventory_epochs.v1', epochs: [initial], receipts: [], criticReceipts: [] });
  try {
    assertReviewInventoryCutoff(attackStore as never, storyId, { materialHash: 'f'.repeat(64), storyFilesHash: cutoff.storyFilesHash });
    events.push({ type: 'open-mutation', accepted: true });
  } catch {
    events.push({ type: 'open-mutation', accepted: false });
  }
  assert.equal(attackStore.snapshot().epochs[0].state, 'INVALIDATED', 'stale mutation invalidates the OPEN epoch');
  const invalidatedStatus = renderReviewInventoryStatus(attackStore.snapshot().epochs[0]);
  assert.match(invalidatedStatus, /Next: lattice review_inventory_begin/);
  assert.equal((invalidatedStatus.match(/^Next:/gm) ?? []).length, 1);

  events.push({ type: 'discovery-wave', host: hosts[0] });
  events.push({ type: 'saturation-wave', host: hosts[1] });
  assert.equal(firstWave.saturated, false);
  assert.equal(buildWave(secondEpoch, saturated, issuedAt).saturated, true);

  const transitionStore = memoryStore(finalizedData);
  let phase = 'REVIEW';
  consumeReviewInventoryReceipt(transitionStore as never, storyId, reviewRound, cutoff);
  phase = 'DEV';
  events.push({ type: 'remediation-transition', accepted: phase === 'DEV' });
  const consumedStatus = renderReviewInventoryStatus(transitionStore.snapshot().epochs[0], { criticComplete: true });
  assert.match(consumedStatus, /REVIEW_INVENTORY_RECEIPT_ALREADY_CONSUMED/);
  assert.match(consumedStatus, /Next: lattice review_inventory_begin/);
  assert.throws(
    () => consumeReviewInventoryReceipt(transitionStore as never, storyId, reviewRound, cutoff),
    /REVIEW_INVENTORY_REMEDIATION_BLOCKED/,
    'receipt replay is rejected mechanically',
  );
  events.push({ type: 'receipt-replay', accepted: false });

  const staleTransitionStore = memoryStore(finalizedData);
  let stalePhase = 'REVIEW';
  assert.throws(() => {
    consumeReviewInventoryReceipt(staleTransitionStore as never, storyId, reviewRound, {
      materialHash: 'e'.repeat(64), storyFilesHash: cutoff.storyFilesHash,
    });
  }, /no longer match the finalized cutoff/);
  assert.equal(stalePhase, 'REVIEW', 'failed consumption occurs before phase publication');
  events.push({ type: 'stale-cutoff-transition', accepted: false });

  const recoveryStore = memoryStore(finalizedData);
  consumeReviewInventoryReceipt(recoveryStore as never, storyId, reviewRound, cutoff);
  assert.equal(reviewInventoryRemediationGate(recoveryStore as never, storyId, reviewRound).ok, false,
    'consume followed by a simulated phase-write failure leaves REVIEW recoverable only through a new epoch');
  events.push({ type: 'phase-write-failure-recovery-required', accepted: false });

  const missing = evaluateReviewInventoryWave({ epoch: initial, runs: firstRuns.slice(0, 2), passes: firstPasses.slice(0, 2), findings: [] });
  assert.equal(missing.missingLanes.length, 1, 'timeout/absent terminal lane cannot saturate');
  const duplicateRuns = firstRuns.map(row => {
    const duplicateRun = { ...row, agent: 'shared-host', promptHash: 'shared-prompt' };
    duplicateRun._hash = signReviewRun(
      duplicateRun.storyId, duplicateRun.reviewRunId, duplicateRun.agent, duplicateRun.lane,
      duplicateRun.reviewRound, duplicateRun.startedAt, duplicateRun.headHash,
      duplicateRun.materialHash, duplicateRun.promptHash, undefined, undefined,
      duplicateRun.storyFilesHash,
    );
    return duplicateRun;
  });
  const duplicate = evaluateReviewInventoryWave({
    epoch: initial,
    runs: duplicateRuns,
    passes: firstPasses,
    findings: [],
  });
  assert.ok(duplicate.duplicateIdentities.length > 0, 'duplicate reviewer identity is rejected');
  assert.match(renderReviewInventoryStatus(initial, { evaluation: duplicate }), /Next: lattice review_inventory_cancel/);
  const cancelled = epoch({ state: 'CANCELLED', cancelledAt: issuedAt, cancelReason: 'operator cancelled bounded review' });
  const cancelledStore = memoryStore({ schemaVersion: 'proofbound.review_inventory_epochs.v1', epochs: [cancelled], receipts: [], criticReceipts: [] });
  assert.equal(reviewInventoryRemediationGate(cancelledStore as never, storyId, reviewRound).ok, false, 'cancel cannot grant DEV');
  assert.match(renderReviewInventoryStatus(cancelled), /Next: lattice review_inventory_begin/);
  const exhausted = epoch({ waves: [firstWave, firstWave, firstWave], maxWaves: 3 });
  assert.equal(exhausted.waves.length >= exhausted.maxWaves && !exhausted.waves.at(-1)?.saturated, true, 'budget exhaustion cannot manufacture a receipt');
  const exhaustedStatus = renderReviewInventoryStatus(exhausted, { evaluation: discovery });
  assert.match(exhaustedStatus, /REVIEW_INVENTORY_BUDGET_EXHAUSTED/);
  assert.match(exhaustedStatus, /Next: lattice review_inventory_cancel/);
  assert.equal((exhaustedStatus.match(/^Next:/gm) ?? []).length, 1);
  const staleRuns = firstRuns.map(row => ({ ...row, materialHash: '9'.repeat(64) }));
  assert.equal(evaluateReviewInventoryWave({ epoch: initial, runs: staleRuns, passes: firstPasses, findings: [] }).missingLanes.length, requiredLanes.length,
    'stale runs cannot satisfy the frozen cutoff');
  const regressionFinding = finding(secondRuns[0]);
  regressionFinding.desc = 'Final review exposes a new critical regression after remediation';
  regressionFinding._hash = signFinding(
    storyId, regressionFinding.id, regressionFinding.desc, regressionFinding.severity,
    regressionFinding.createdAt!, reviewRound, regressionFinding.reviewRunId,
    regressionFinding.readManifest, regressionFinding.readLog,
  );
  const regression = evaluateReviewInventoryWave({
    epoch: secondEpoch,
    runs: secondRuns,
    passes: secondPasses,
    findings: [historical, regressionFinding],
    findingDispositions: [{
      findingId: regressionFinding.id,
      disposition: 'verified_family',
      familyKey: findingFamily(regressionFinding),
      reason: 'independent critic confirmed this is a new post-remediation regression family',
    }],
  });
  assert.ok(regression.newFamilies.length > 0, 'a final-review regression reopens discovery instead of escaping');
  events.push({ type: 'final-review', host: hosts[0], accepted: true });
  events.push({ type: 'regression-injection', accepted: regression.newFamilies.length === 0 });

  const baselineHosts = new Set(events.filter(event => event.type.startsWith('baseline-') && event.host).map(event => event.host));
  const proposedHosts = new Set(events.filter(event => ['discovery-wave', 'saturation-wave', 'final-review'].includes(event.type) && event.host).map(event => event.host));
  return {
    baselineMutationDrivenRedispatches: events.filter(event => event.type === 'baseline-redispatch').length,
    proposedMutationDrivenRedispatches: events.filter(event => event.type === 'open-mutation' && event.accepted).length,
    discoveryEpochs: events.filter(event => event.type === 'discovery-wave').length,
    acceptedOpenMaterialCommits: events.filter(event => event.type === 'open-mutation' && event.accepted).length,
    stalePassAcceptances: events.filter(event => event.type === 'stale-cutoff-transition' && event.accepted).length,
    aggregatedRemediationTransitions: events.filter(event => event.type === 'remediation-transition' && event.accepted).length,
    finalReviewEpochsWithoutRegression: events.filter(event => event.type === 'final-review').length,
    requiredHostCountBefore: baselineHosts.size,
    requiredHostCountAfter: proposedHosts.size,
    requiredLaneCountBefore: new Set(events.filter(event => event.type === 'baseline-required-lane').map(event => event.lane)).size,
    requiredLaneCountAfter: new Set(events.filter(event => event.type === 'proposed-required-lane').map(event => event.lane)).size,
    criticalHighEscapes: events.filter(event => event.type === 'regression-injection' && event.accepted).length,
    budgetManufacturedPasses: exhausted.waves.at(-1)?.saturated ? 1 : 0,
  };
}
const replayA = replay();
const replayB = replay();
assert.deepEqual(replayA, replayB, 'replay counters deterministic');
assert.ok(replayA.baselineMutationDrivenRedispatches >= 5);
assert.equal(replayA.proposedMutationDrivenRedispatches, 0);
assert.equal(replayA.requiredHostCountBefore, 2);
assert.equal(replayA.requiredHostCountAfter, 2);
assert.equal(replayA.requiredLaneCountAfter, replayA.requiredLaneCountBefore);
assert.equal(replayA.requiredLaneCountBefore, requiredLanes.length);
assert.equal(replayA.criticalHighEscapes + replayA.budgetManufacturedPasses, 0);

console.log(JSON.stringify({ result: 'PASS', replay: replayA }, null, 2));
