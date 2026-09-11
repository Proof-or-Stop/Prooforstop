import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyFindingWitness } from '../../dist/handlers/finding-applicability-proof.js';
import { FINDING_PROTECTED_SURFACES } from '../../dist/core/finding-applicability.js';
import { historyRecallSchema } from '../../dist/core/finding-history.js';

const root = resolve(import.meta.dirname, '../../../..');
const results = [];
const check = (name, fn) => { try { fn(); results.push(true); console.log(`${name} PASS`); }
  catch (error) { results.push(false); console.error(`${name} FAIL ${error.message}`); } };
const source = path => readFileSync(resolve(root, 'packages/main/src', path), 'utf8');

// This is a behavioral counterexample: a boolean is not a base execution receipt.
check('PAIR-head-only-cannot-prove-base', () => {
  const witness = { schemaVersion: 'proof-or-stop.finding-witness.v1', storyId: 'B-test', findingId: 'F-test',
    baseHash: 'base', headHash: 'head', scopeDigest: 'scope', acceptanceDigest: 'acceptance', evaluationScope: 'target_story',
    verdict: 'pre_existing_unaffected', reproduced: true, baseReproduced: true, introducedByCurrentStory: false,
    gateImpact: 'does_not_block', affectedPaths: ['old.ts'], checkedIntentRefs: ['CHK-1:happy:0'],
    protectedSurfaceEvaluation: FINDING_PROTECTED_SURFACES.map(surface => ({ surface, state: 'clear', evidenceRefs: ['CHK-1:happy:0'] })) };
  assert.throws(() => verifyFindingWitness(witness, { ...witness, finding: { id: 'F-test', files: ['old.ts'] },
    intentRefs: witness.checkedIntentRefs, changedPaths: ['other.ts'] }), /base.head.*pair|paired.*receipt/i);
});
check('RECALL-L4-expiry-has-typed-trigger', () => {
  assert.equal(historyRecallSchema.safeParse({ storyId: 'B-test', idempotencyKey: 'once',
    route: { storyId: 'B-target', recordId: 'route', recordHash: 'a'.repeat(64) },
    trigger: 'deferral_invalidated', deferral: { storyId: 'B-test', recordId: 'deferral', recordHash: 'b'.repeat(64) } }).success, true);
});
// Wiring guards accompany, but do not replace, the executable integration suites.
check('REATTEST-gate-consumes-verified-closure', () => {
  assert.match(source('core/finding-applicability-projection.ts'), /readMaterialDriftReattestation\(/);
  assert.match(source('handlers/finding-route.ts'), /readMaterialDriftReattestation\(/);
});
check('COLLECTORS-not-permanently-disabled', () => {
  assert.doesNotMatch(source('handlers/finding-qualification.ts'), /refusalReasons\.push\('qualification_source_collectors_incomplete/);
  assert.match(source('handlers/finding-qualification.ts'), /collectFindingQualificationEvents\(/);
});
const failed = results.filter(pass => !pass).length;
console.log(`DYNAMIC_FINDING_FOUR_GAPS ${failed ? 'FAIL' : 'PASS'} ${results.length - failed} passed ${failed} failed`);
process.exitCode = failed ? 1 : 0;
