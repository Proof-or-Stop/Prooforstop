#!/usr/bin/env node
/**
 * Lab plan-intent-precheck: every bench run so far wrote intents item by item and
 * learned only at story_review that lanes were missing or a repository-wide must
 * lacked its external verifier basis, then reworked PLAN.
 */
import assert from 'node:assert/strict';
import { planIntentPrecheckWarnings } from '../core/plan-intent-precheck.js';

const focused = { desc: 'Focused test passes', type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story' } as const;
const onlyHappy = planIntentPrecheckWarnings({ id: 'CHK-001', verificationIntent: { happy: [focused] } } as any);
assert.ok(onlyHappy.some(w => /CHK-001 has no edge intent/.test(w)) && onlyHappy.some(w => /no adversarial intent/.test(w)),
  `missing lanes are not flagged at write time: ${JSON.stringify(onlyHappy)}`);
const repoMust = planIntentPrecheckWarnings({ id: 'CHK-005', verificationIntent: {
  happy: [{ ...focused, scope: 'repository', desc: 'go test ./... passes' }], edge: [focused], adversarial: [focused] } } as any);
assert.ok(repoMust.some(w => /CHK-005:happy:0 .*repository-wide.*external_verifier/.test(w)), `repository-wide must not flagged: ${JSON.stringify(repoMust)}`);
assert.deepEqual(planIntentPrecheckWarnings({ id: 'CHK-002', verificationIntent: { happy: [focused], edge: [focused], adversarial: [focused] } } as any), [],
  'a complete focused intent has no warnings');
console.log('plan-intent-precheck-smoke: PASS');
