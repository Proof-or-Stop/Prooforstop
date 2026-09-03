#!/usr/bin/env node
/**
 * RED artifact (W2c / B-506e, CHK-002:adversarial:0 + CHK-003) — the schema
 * discriminant is EXHAUSTIVE and FAILS CLOSED on an unsupported per-record
 * schemaVersion; a non-v1/non-v2 record NEVER crashes the LIVE enforce gate.
 *
 * Repro-first RED: written BEFORE the exhaustive discrimination was wired.
 * Against the pre-fix tree a stored record whose schemaVersion is set but is
 * NEITHER the exact v2 literal NOR absent (a future `v3`, a typo, a corrupted
 * value) falls through `isRedEvidenceV2` into the v1 branch of
 * redEvidenceRecordSatisfied and throws a bare `TypeError` at
 * `record.observedFailure.trim()` inside the live dev/review/done enforce gate —
 * that TypeError IS the RED signal.
 *
 * After the fix:
 *   (1) READ PATH fails closed — store.readRedEvidence classifies every record
 *       and REJECTS an unsupported schemaVersion with a clear typed
 *       RedEvidenceSchemaError (never silently accepted into records[]);
 *   (2) the LIVE gate produces a verdict / a clear typed unsupported-schema
 *       diagnostic — NEVER a bare TypeError — on a store carrying a v3 record;
 *   (3) the gate predicate is defense-in-depth: even if a v3 record is injected
 *       DIRECTLY into the diagnostic input (bypassing the read fail-closed), the
 *       gate does not crash and its verdict is BYTE-IDENTICAL to the v1-only run
 *       (the v3 record is invisible to the v1 predicate);
 *   (4) a v1-only store stays BYTE-IDENTICAL end-to-end.
 *
 * ORDERING IS LOAD-BEARING in step 4. redEvidenceSatisfied iterates the records
 * with `Array.prototype.some()`, which SHORT-CIRCUITS on the first satisfying
 * record, so a v3 record appended AFTER a satisfying v1 record is never handed to
 * the predicate and asserting on that arrangement proves nothing (it does not
 * throw even on the pre-fix tree). NO such arrangement appears in step 4: it
 * injects the v3 record FIRST, then MID-ARRAY behind a v1 record that does NOT
 * satisfy the predicate (so some() cannot short-circuit before it), then as a
 * v3-only input that cannot be short-circuited past. Each arrangement fails
 * against a dist built from the pre-fix tree 8727b2db83.
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
const { RedEvidenceSchemaError, classifyRedRecordSchema, classifyRedRecordSchemaSafe } = await import(`${DIST}/core/red-evidence/record-v2.js`);

const NOW = '2026-07-25T00:00:00.000Z';

function makeStore(root, storyId) {
  const store = new StoryStore(root);
  store.writeStory(storyId, {
    storyId, name: 'w2c', title: 'W2c schema fail-closed',
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

// A record carrying an UNSUPPORTED schemaVersion (a future/corrupted version) and
// NO observedFailure — the exact fall-through crash trigger.
const v3 = {
  id: 'RED-v3-1', schemaVersion: 'proofstory.red_evidence.v3', operation: 'quarantine',
  seq: 2, priorRecordDigest: 'sha256:deadbeef', supersedes: 'RED-x',
  storyId: 'B-fc', acceptanceTargetRef: 'M1',
  recoversRecordId: 'RED-x', referencedRecordDigest: 'sha256:deadbeef', linkKind: 'quarantines',
  reason: 'flaky', approvedBy: 'proof-or-stop-implementer@sess-x', operationKey: 'sha256:key', createdAt: NOW,
};

const root = join(process.env.TMPDIR || '/tmp', `red-w2c-failclosed-${process.pid}`);
const storyId = 'B-fc';
const store = makeStore(root, storyId);

// ── 0. classifier is EXHAUSTIVE (unit) ──────────────────────────────────────
assert.equal(classifyRedRecordSchemaSafe({ id: 'x' }), 'v1', 'absent version → v1');
assert.equal(classifyRedRecordSchemaSafe({ schemaVersion: 'proofstory.red_evidence.v2' }), 'v2', 'exact literal → v2');
assert.equal(classifyRedRecordSchemaSafe(v3), 'unsupported', 'v3 → unsupported (not silently v1)');
assert.equal(classifyRedRecordSchemaSafe(null), 'unsupported', 'non-object → unsupported');
assert.throws(() => classifyRedRecordSchema(v3), (e) => e instanceof RedEvidenceSchemaError, 'classifyRedRecordSchema fails CLOSED on v3');

// ── 1. v1-only baseline verdict (well-defined, satisfied) ───────────────────
writeRecords(store, storyId, [v1]);
const before = JSON.stringify(evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId, root)).missingRedEvidence);

// ── 2. READ PATH fails closed on a v3 record: a clear typed error, NOT a TypeError ──
writeRecords(store, storyId, [v1, v3]);
let readErr;
try { store.readRedEvidence(storyId); } catch (e) { readErr = e; }
assert.ok(readErr, 'store.readRedEvidence MUST fail closed on an unsupported schemaVersion (not silently accept it)');
assert.ok(!(readErr instanceof TypeError), `read fail-closed MUST NOT be a bare TypeError (got ${readErr?.constructor?.name})`);
assert.ok(readErr instanceof RedEvidenceSchemaError, 'read fail-closed is a typed RedEvidenceSchemaError (§6.4)');
assert.match(readErr.message, /schemaVersion/, 'the diagnostic names the schemaVersion problem');

// ── 3. the LIVE enforce gate does not throw a bare TypeError on a v3 store ──
let gateErr;
try { evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId, root)); } catch (e) { gateErr = e; }
assert.ok(gateErr, 'the gate surfaces the fail-closed diagnostic on a v3 store');
assert.ok(!(gateErr instanceof TypeError), `the LIVE gate MUST NOT throw a bare TypeError on a v3 record (got ${gateErr?.constructor?.name})`);
assert.ok(gateErr instanceof RedEvidenceSchemaError, 'the gate surfaces the typed unsupported-schema diagnostic, never a TypeError');

// ── 4. gate predicate defense-in-depth: inject v3 DIRECTLY into the input
//       (bypassing the read fail-closed) → no crash, verdict BYTE-IDENTICAL.
//
// ORDERING IS LOAD-BEARING: redEvidenceSatisfied iterates with
// Array.prototype.some(), which SHORT-CIRCUITS on the first satisfying record.
// A v3 record appended AFTER the satisfying v1 record is never handed to the
// predicate, so asserting on that arrangement proves nothing (it does not throw
// even on the pre-fix tree). unshift() puts the v3 record FIRST, which is the
// arrangement that actually reaches the guard: against the pre-fix tree
// (8727b2db83, predicate opens with record.observedFailure.trim()) this throws a
// bare TypeError. ─────────────────────────────────────────────────────────────
writeRecords(store, storyId, [v1]);
const input = proofStoryDiagnosticInput(store, storyId, root); // v1-only, valid
input.redEvidence.records.unshift(v3); // inject a v3 record past the read gate, FIRST
let injected;
assert.doesNotThrow(() => {
  injected = JSON.stringify(evaluateProofStoryDiagnostics(input).missingRedEvidence);
}, 'the gate predicate MUST NOT crash on a non-v1 record evaluated BEFORE any satisfying v1 record (never reaches observedFailure.trim())');
assert.equal(injected, before, 'the v1 gate verdict is BYTE-IDENTICAL with a v3 record injected first (v3 is invisible to the v1 predicate)');

// MID-ARRAY PLACEMENT: the v3 record is neither first nor short-circuited past.
// v1Unsatisfying is a GENUINE v1 record (no schemaVersion) carrying a non-empty
// observedFailure — so it does NOT throw on the pre-fix tree — that names an
// acceptanceTargetRef outside expectedTargets, so the v1 predicate returns FALSE
// for it and some() does NOT short-circuit. The v3 record that follows is
// therefore genuinely handed to the predicate from a non-leading position, and
// the satisfying v1 record at the tail keeps the verdict well-defined. Against
// the pre-fix tree (8727b2db83) this ordering throws a bare TypeError at
// record.observedFailure.trim() exactly as the v3-first case does.
const v1Unsatisfying = {
  id: 'RED-v1-unsat', trigger: 'unrelated', acceptanceTargetRef: 'M-not-a-declared-target',
  baselineHeadHash: 'base-head', baselineMaterialHash: 'base-mat',
  failingCommand: 'npm test', observedFailure: 'a different failure',
  greenRelation: { targetRef: 'M-not-a-declared-target', relation: 'same_acceptance', greenHeadHash: 'green-head', greenMaterialHash: 'green-mat' },
  createdAt: NOW,
};
const inputMid = proofStoryDiagnosticInput(store, storyId, root);
inputMid.redEvidence.records = [v1Unsatisfying, v3, v1];
let injectedMid;
assert.doesNotThrow(() => {
  injectedMid = JSON.stringify(evaluateProofStoryDiagnostics(inputMid).missingRedEvidence);
}, 'the gate predicate MUST NOT crash on a v3 record placed MID-ARRAY behind a non-satisfying v1 record (some() does not short-circuit, so the v3 record IS evaluated)');
assert.equal(injectedMid, before, 'the v1 gate verdict is BYTE-IDENTICAL when the v3 record sits mid-array: it is skipped and the verdict still comes from the trailing satisfying v1 record');

// A v3-only input: the predicate must reach the v3 record with NO satisfying v1
// record anywhere, report missing_red_evidence, and still not crash. This case
// cannot be short-circuited past, so it holds even if the ordering above ever
// regresses.
const inputV3Only = proofStoryDiagnosticInput(store, storyId, root);
inputV3Only.redEvidence.records = [v3];
let v3Only;
assert.doesNotThrow(() => {
  v3Only = evaluateProofStoryDiagnostics(inputV3Only).missingRedEvidence;
}, 'the gate predicate MUST NOT crash on a v3-only input (no satisfying v1 record to short-circuit on)');
assert.ok(v3Only.length > 0, 'a v3-only input has no v1 satisfier → missing_red_evidence fires (not a crash)');

// ── 5. v1-only store stays byte-identical end-to-end ────────────────────────
writeRecords(store, storyId, [v1]);
const after = JSON.stringify(evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId, root)).missingRedEvidence);
assert.equal(after, before, 'a v1-only store verdict is unchanged by the exhaustive-discrimination fix');

console.log('red-w2c-schema-failclosed: OK (schema discriminant is exhaustive; store.readRedEvidence fails closed on a v3 record with a typed RedEvidenceSchemaError; the LIVE gate never throws a bare TypeError; the gate predicate skips a v3 record byte-identically; v1-only store unchanged)');
