#!/usr/bin/env node
/**
 * RED artifact A (W2c / B-506e, CHK-002 + CHK-003) — the LIVE enforce-gate
 * byte-identical v1 guard.
 *
 * Repro-first RED: written and committed BEFORE the guard in
 * redEvidenceRecordSatisfied (core/proofstory.ts) skips non-v1 records. Against
 * the pre-fix tree, injecting a v2 quarantine record (which carries NO
 * `observedFailure`) into a story's red-evidence.json and running the REAL
 * ProofStory diagnostics THROWS a TypeError at `record.observedFailure.trim()`.
 * That throw IS the RED signal.
 *
 * ORDERING IS LOAD-BEARING. redEvidenceSatisfied iterates the records with
 * `Array.prototype.some()`, which SHORT-CIRCUITS on the first satisfying record.
 * A non-v1 record placed AFTER an already-satisfying v1 record is therefore never
 * handed to the predicate, and asserting on that arrangement proves nothing — it
 * does not throw even on the pre-fix tree. NO such arrangement appears below.
 * Every case here reaches the guard: the non-v1 record is placed FIRST, or
 * MID-ARRAY behind a v1 record that does NOT satisfy the predicate (so some()
 * cannot short-circuit before it), or in a store with no satisfying v1 record at
 * all. Each one fails against a dist built from the pre-fix tree 8727b2db83.
 *
 * After the guard: (1) the diagnostic on a v1-only store is BYTE-IDENTICAL to the
 * run WITH a v2 record added (v2 records are invisible to the v1 predicate); and
 * (2) the live gate does not throw. devGateMode/reviewGateMode/doneGateMode all
 * `enforce` — this is the exact live crash path.
 *
 * The v2 record here is HAND-BUILT (a plain object with
 * schemaVersion="proofstory.red_evidence.v2"), so this signal depends ONLY on the
 * live gate, not on any new W2c module.
 */
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..'); // packages/main
const DIST = join(pkgRoot, 'dist');

const { StoryStore } = await import(`${DIST}/core/store.js`);
const { evaluateProofStoryDiagnostics, computeMilestoneLedgerHash } = await import(`${DIST}/core/proofstory.js`);
const { proofStoryDiagnosticInput } = await import(`${DIST}/handlers/phase-gates.js`);

const NOW = '2026-07-25T00:00:00.000Z';

function makeStore(root, storyId) {
  const store = new StoryStore(root);
  store.writeStory(storyId, {
    storyId, name: 'w2c', title: 'W2c gate guard',
    description: 'Fix an authentication session security regression (behavior change).',
    type: 'bug', phase: 'DEV', priority: 'high', createdAt: NOW, startedAt: NOW, endedAt: null,
  });
  const milestones = [{
    id: 'M1', sourceRequirementId: 'REQ-1', claim: 'auth fix', doneMeans: 'test passes',
    requiredEvidence: [], checklistRefs: ['CHK-001'], verificationIntentRefs: ['CHK-001:happy:0'], status: 'planned',
  }];
  store.writeMilestoneLedger(storyId, {
    schemaVersion: 'proofstory.milestone_ledger.v1', storyId, state: 'confirmed',
    ledgerHash: computeMilestoneLedgerHash(milestones), milestones, createdAt: NOW, updatedAt: NOW,
  });
  return store;
}

function writeRecords(store, storyId, records) {
  store.writeRedEvidence(storyId, {
    schemaVersion: 'proofstory.red_evidence.v1', storyId, records, createdAt: NOW, updatedAt: NOW,
  });
}

// A satisfying v1 record so the v1 verdict is well-defined and non-trivial.
const v1 = {
  id: 'RED-v1', trigger: 'auth regression', acceptanceTargetRef: 'M1',
  baselineHeadHash: 'base-head', baselineMaterialHash: 'base-mat',
  failingCommand: 'npm test', observedFailure: 'assertion failed',
  greenRelation: { targetRef: 'M1', relation: 'same_acceptance', greenHeadHash: 'green-head', greenMaterialHash: 'green-mat' },
  createdAt: NOW,
};

// A v2 quarantine record with NO observedFailure — the exact crash trigger.
const v2Quarantine = {
  id: 'QUA-abc123abc123-2', schemaVersion: 'proofstory.red_evidence.v2', operation: 'quarantine',
  seq: 2, priorRecordDigest: 'sha256:deadbeef', supersedes: 'RED-x',
  storyId: 'B-guard', acceptanceTargetRef: 'M1',
  recoversRecordId: 'RED-x', referencedRecordDigest: 'sha256:deadbeef', linkKind: 'quarantines',
  reason: 'flaky', approvedBy: 'proof-or-stop-implementer@sess-x', operationKey: 'sha256:key', createdAt: NOW,
};

const root = join(process.env.TMPDIR || '/tmp', `red-w2c-guard-${process.pid}`);
const storyId = 'B-guard';
const store = makeStore(root, storyId);

// Baseline: v1-only diagnostic.
writeRecords(store, storyId, [v1]);
const before = JSON.stringify(evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId, root)).missingRedEvidence);

// Inject the v2 quarantine record BEFORE the satisfying v1 record. The ordering
// is load-bearing: redEvidenceSatisfied iterates with Array.prototype.some(),
// which SHORT-CIRCUITS on the first satisfying record — so with the v1 record
// first the v2 record would never be handed to the predicate at all and this
// assertion would be vacuous. v2-first is the ordering that actually reaches the
// guard: against the pre-fix tree (8727b2db83) it throws a TypeError at
// record.observedFailure.trim(). That throw IS RED signal A.
writeRecords(store, storyId, [v2Quarantine, v1]);
let after;
assert.doesNotThrow(() => {
  after = JSON.stringify(evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId, root)).missingRedEvidence);
}, 'RED signal A: the LIVE enforce gate MUST NOT throw on a v2 quarantine record evaluated BEFORE any satisfying v1 record (no observedFailure)');
assert.equal(after, before, 'the v1 gate verdict is BYTE-IDENTICAL with a v2 record added (v2 records are ignored)');

// MID-ARRAY PLACEMENT: the v2 record is neither first nor short-circuited past.
// v1Unsatisfying is a GENUINE v1 record (no schemaVersion) that carries a
// non-empty observedFailure — so it does NOT throw on the pre-fix tree — but
// names an acceptanceTargetRef outside expectedTargets, so the v1 predicate
// returns FALSE for it and some() does NOT short-circuit. The v2 record that
// follows is therefore genuinely handed to the predicate from a non-leading
// position, and the satisfying v1 record at the tail keeps the verdict
// well-defined. Against the pre-fix tree (8727b2db83) this ordering throws a
// TypeError at record.observedFailure.trim() exactly as the v2-first case does.
const v1Unsatisfying = {
  id: 'RED-v1-unsat', trigger: 'unrelated', acceptanceTargetRef: 'M-not-a-declared-target',
  baselineHeadHash: 'base-head', baselineMaterialHash: 'base-mat',
  failingCommand: 'npm test', observedFailure: 'a different failure',
  greenRelation: { targetRef: 'M-not-a-declared-target', relation: 'same_acceptance', greenHeadHash: 'green-head', greenMaterialHash: 'green-mat' },
  createdAt: NOW,
};
writeRecords(store, storyId, [v1Unsatisfying, v2Quarantine, v1]);
let afterMid;
assert.doesNotThrow(() => {
  afterMid = JSON.stringify(evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId, root)).missingRedEvidence);
}, 'the LIVE enforce gate MUST NOT throw on a v2 quarantine record placed MID-ARRAY behind a non-satisfying v1 record (some() does not short-circuit, so the v2 record IS evaluated)');
assert.equal(afterMid, before, 'the v1 gate verdict is BYTE-IDENTICAL when the v2 record sits mid-array: it is skipped and the verdict still comes from the trailing satisfying v1 record');

// A MALFORMED HYBRID: a v2 record that DOES carry every v1 field, including a
// non-empty observedFailure and a well-formed greenRelation, so it would satisfy
// the v1 predicate field-by-field. The schemaVersion discriminant — not field
// presence — must govern the skip, otherwise a v2 record could satisfy the v1
// gate. Stored ALONE so nothing can short-circuit past it: if the discriminant
// did not govern, missingRedEvidence would NOT fire here.
const v2Hybrid = {
  ...v2Quarantine,
  id: 'QUA-abc123abc123-9',
  trigger: 'auth regression', failingCommand: 'npm test', observedFailure: 'assertion failed',
  baselineHeadHash: 'base-head', baselineMaterialHash: 'base-mat',
  greenRelation: { targetRef: 'M1', relation: 'same_acceptance', greenHeadHash: 'green-head', greenMaterialHash: 'green-mat' },
};
writeRecords(store, storyId, [v2Hybrid]);
const hybridOnly = evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId, root)).missingRedEvidence;
assert.ok(
  hybridOnly.length > 0,
  'a v2 record carrying a complete, valid v1 field set MUST NOT satisfy the v1 predicate — the schemaVersion discriminant governs the skip, not field presence',
);

// A v2-only store: missingRedEvidence fires (no v1 satisfier), still no crash.
writeRecords(store, storyId, [v2Quarantine]);
const v2Only = evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId, root)).missingRedEvidence;
assert.ok(v2Only.length > 0, 'a v2-only store has no v1 satisfier → missing_red_evidence fires (not a crash)');

console.log('red-w2c-gate-guard: OK (live enforce gate does not throw on a v2 record ordered BEFORE any satisfying v1 record, nor on one placed MID-ARRAY behind a non-satisfying v1 record; the v1 verdict is byte-identical in both placements; a v2 record with a complete valid v1 field set still does not satisfy the v1 predicate; v2-only store reports missing not crash)');
