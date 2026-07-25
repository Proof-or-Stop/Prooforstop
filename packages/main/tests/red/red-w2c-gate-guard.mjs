#!/usr/bin/env node
/**
 * RED artifact A (W2c / B-506e, CHK-002 + CHK-003) — the LIVE enforce-gate
 * byte-identical v1 guard.
 *
 * Repro-first RED: written and committed BEFORE the guard in
 * redEvidenceRecordSatisfied (core/proofstory.ts) skips non-v1 records. Against
 * today's tree, injecting a v2 quarantine record (which carries NO
 * `observedFailure`) into a story's red-evidence.json and running the REAL
 * ProofStory diagnostics THROWS a TypeError at `record.observedFailure.trim()`
 * (the .some() over records reaches every record). That throw IS the RED signal.
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
  reason: 'flaky', approvedBy: 'lattice-implementer@sess-x', operationKey: 'sha256:key', createdAt: NOW,
};

const root = join(process.env.TMPDIR || '/tmp', `red-w2c-guard-${process.pid}`);
const storyId = 'B-guard';
const store = makeStore(root, storyId);

// Baseline: v1-only diagnostic.
writeRecords(store, storyId, [v1]);
const before = JSON.stringify(evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId, root)).missingRedEvidence);

// Inject the v2 quarantine record. TODAY this throws at observedFailure.trim().
writeRecords(store, storyId, [v1, v2Quarantine]);
let after;
assert.doesNotThrow(() => {
  after = JSON.stringify(evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId, root)).missingRedEvidence);
}, 'RED signal A: the LIVE enforce gate MUST NOT throw on a v2 quarantine record (no observedFailure)');
assert.equal(after, before, 'the v1 gate verdict is BYTE-IDENTICAL with a v2 record added (v2 records are ignored)');

// A v2-only store: missingRedEvidence fires (no v1 satisfier), still no crash.
writeRecords(store, storyId, [v2Quarantine]);
const v2Only = evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId, root)).missingRedEvidence;
assert.ok(v2Only.length > 0, 'a v2-only store has no v1 satisfier → missing_red_evidence fires (not a crash)');

console.log('red-w2c-gate-guard: OK (live enforce gate does not throw on a v2 record; v1 verdict byte-identical; v2-only store reports missing not crash)');
