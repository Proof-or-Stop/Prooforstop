#!/usr/bin/env node
/**
 * RED artifact (W2c / B-506e, CHK-003:happy:0 + CHK-003:edge:1) — the v1 gate
 * verdict DID NOT MOVE.
 *
 * CHK-003:happy:0 asks for the FULL diagnostic output of the v1 red-evidence
 * path to be captured BEFORE and AFTER the non-v1 skip guard and compared
 * byte-for-byte. Until this file existed, that claim was carried only by prose:
 * no committed artifact computed the digest it cited. This test IS the claim.
 *
 * What it actually asserts:
 *   1. FIVE explicit v1-only scenarios (empty store / satisfying record /
 *      blank-observedFailure record / foreign acceptance-target record / mixed
 *      store) are each run through the REAL production gate diagnostics
 *      (evaluateProofStoryDiagnostics over proofStoryDiagnosticInput — the same
 *      pair the live dev/review/done enforce gates call).
 *   2. Each scenario's v1 semantics are asserted by NAME (does or does not raise
 *      missing_red_evidence), so the digest below is anchored to observable
 *      behaviour and cannot be re-pinned silently to a different verdict.
 *   3. The FULL ProofStoryDiagnosticReport of every scenario is canonicalized
 *      (recursive key sort, undefined dropped) and ONE sha256 is taken over the
 *      concatenation of all five, then asserted against V1_VERDICT_DIGEST.
 *
 * Scope of the digest, stated honestly: it covers the entire diagnostic report
 * object for these five fixtures, not just missingRedEvidence. It is therefore
 * also sensitive to unrelated changes in trigger wording or other gap families;
 * that sensitivity is deliberate (CHK-003:happy:0 says "FULL diagnostic
 * output"), and a legitimate change elsewhere must re-pin it consciously.
 *
 * The report is environment-independent by construction: it embeds no path, no
 * timestamp and no git state (the store root is a throwaway temp dir outside any
 * repo, so currentEvidenceBinding / materialClassification resolve to undefined).
 *
 * REPLAY AGAINST THE PRE-FIX TREE (this is the actual "no v1 verdict moved"
 * proof; run it whenever the digest is re-pinned):
 *
 *   mkdir -p /tmp/prefix && git archive 8727b2db83 | tar -x -C /tmp/prefix
 *   ln -sfn "$PWD/node_modules" /tmp/prefix/node_modules
 *   ln -sfn "$PWD/packages/main/node_modules" /tmp/prefix/packages/main/node_modules
 *   npm --prefix /tmp/prefix/packages/main run build
 *   cp packages/main/tests/red/red-w2c-v1-verdict-invariance.mjs \
 *      /tmp/prefix/packages/main/tests/red/
 *   node /tmp/prefix/packages/main/tests/red/red-w2c-v1-verdict-invariance.mjs
 *
 * 8727b2db83 is the last commit of this story BEFORE the guard landed in
 * redEvidenceRecordSatisfied (its predicate still opens with
 * `record.observedFailure.trim()`), and it must print the SAME digest: every
 * record in all five scenarios is v1, so the guard is a no-op on all of them.
 * These fixtures import only store.js / proofstory.js / handlers/phase-gates.js,
 * all of which exist unchanged in that tree, so the file runs there verbatim.
 */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..'); // packages/main
const DIST = join(pkgRoot, 'dist');

const { StoryStore } = await import(`${DIST}/core/store.js`);
const { evaluateProofStoryDiagnostics, computeMilestoneLedgerHash } = await import(`${DIST}/core/proofstory.js`);
const { proofStoryDiagnosticInput } = await import(`${DIST}/handlers/phase-gates.js`);

const NOW = '2026-07-25T00:00:00.000Z';
const storyId = 'B-inv';

// Pinned by running this file; re-pin ONLY together with a fresh pre-fix replay
// (see the header) so the byte-identity claim stays true.
const V1_VERDICT_DIGEST = '2d584cc157e83ebb2f8396735f04d46946f0ba90d18a55d9fb2f263d706a11ec';

function makeStore(root) {
  const store = new StoryStore(root);
  store.writeStory(storyId, {
    storyId, name: 'w2c', title: 'W2c v1 verdict invariance',
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

function writeRecords(store, records) {
  store.writeRedEvidence(storyId, {
    schemaVersion: 'proofstory.red_evidence.v1', storyId, records, createdAt: NOW, updatedAt: NOW,
  });
}

// Recursive canonical form: object keys sorted, undefined dropped, arrays kept
// in order. Local to the test on purpose — the digest must not be able to drift
// because a production serializer changed.
function canon(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}`;
}

// ── the five v1-only fixtures ───────────────────────────────────────────────
const satisfying = {
  id: 'RED-v1', trigger: 'auth regression', acceptanceTargetRef: 'M1',
  baselineHeadHash: 'base-head', baselineMaterialHash: 'base-mat',
  failingCommand: 'npm test', observedFailure: 'assertion failed',
  greenRelation: { targetRef: 'M1', relation: 'same_acceptance', greenHeadHash: 'green-head', greenMaterialHash: 'green-mat' },
  createdAt: NOW,
};

// Same record, but observedFailure is whitespace only: the v1 predicate rejects
// it at `record.observedFailure.trim().length === 0` (CHK-003:edge:1).
const blankObservedFailure = { ...satisfying, id: 'RED-v1-blank', observedFailure: '   ' };

// Same record, but the acceptance target is not in the expected-target set.
const foreignTarget = {
  ...satisfying,
  id: 'RED-v1-foreign',
  acceptanceTargetRef: 'M-not-in-ledger',
  greenRelation: { ...satisfying.greenRelation, targetRef: 'M-not-in-ledger' },
};

const SCENARIOS = [
  { name: '1-empty-store', records: [], satisfied: false },
  { name: '2-satisfying-record', records: [satisfying], satisfied: true },
  { name: '3-blank-observed-failure', records: [blankObservedFailure], satisfied: false },
  { name: '4-foreign-acceptance-target', records: [foreignTarget], satisfied: false },
  { name: '5-mixed-store', records: [blankObservedFailure, foreignTarget, satisfying], satisfied: true },
];

const root = join(process.env.TMPDIR || '/tmp', `red-w2c-invariance-${process.pid}`);
const store = makeStore(root);

const parts = [];
for (const scenario of SCENARIOS) {
  writeRecords(store, scenario.records);
  const report = evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId, root));

  // Anchor the digest to named, observable v1 semantics.
  assert.ok(
    report.triggerReasons.some((reason) => reason.code === 'red_evidence_required'),
    `${scenario.name}: the red-evidence trigger must be live, otherwise the scenario proves nothing`,
  );
  assert.equal(
    report.missingRedEvidence.length === 0,
    scenario.satisfied,
    `${scenario.name}: expected the v1 predicate to be ${scenario.satisfied ? 'SATISFIED' : 'UNSATISFIED'} (missingRedEvidence=${JSON.stringify(report.missingRedEvidence.map((row) => row.code))})`,
  );
  parts.push(`${scenario.name}\n${canon(report)}\n`);
}

const digest = createHash('sha256').update(parts.join(''), 'utf8').digest('hex');
console.log(`red-w2c-v1-verdict-invariance: five-scenario FULL-diagnostic sha256 = ${digest}`);
assert.equal(
  digest, V1_VERDICT_DIGEST,
  'the v1 gate verdict moved: the FULL diagnostic over the five v1-only scenarios no longer hashes to the pinned digest',
);

console.log('red-w2c-v1-verdict-invariance: OK (5 v1-only scenarios; per-scenario v1 semantics asserted by name; one sha256 over the concatenated FULL diagnostics equals the pinned digest)');
