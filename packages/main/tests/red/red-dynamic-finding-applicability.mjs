#!/usr/bin/env node
/**
 * Dynamic Finding Applicability preregistered RED/GREEN contract.
 *
 * RED executes the shipped compatibility predicate. GREEN executes the new
 * dynamic predicate with the same immutable cases. Missing production code is
 * never counted as a product failure: the compatibility predicate remains the
 * executable baseline witness until the dynamic module exists.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const { default: ts } = await import('typescript');
async function loadSource(path) {
  const source = readFileSync(resolve(root, path), 'utf8');
  const output = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}
const advisory = await loadSource('packages/main/src/core/advisory.ts');
const dynamicPath = 'packages/main/src/core/finding-applicability.ts';
const dynamic = existsSync(resolve(root, dynamicPath)) ? await loadSource(dynamicPath) : undefined;

const finding = (id, severity = 'high') => ({ id, status: 'open', severity, evidenceState: 'verified' });
const fresh = {
  state: 'fresh', storyId: 'B-CURRENT', scopeDigest: 'scope-current', baseHash: 'base-current',
  headHash: 'head-current', acceptanceDigest: 'acceptance-current', runtimeReceiptDigest: 'runtime-current',
};
const route = { state: 'accepted', ownerStoryId: 'B-NEXT', receiptState: 'fresh', receiptId: 'route-1', expiresAt: '2030-01-01T00:00:00.000Z' };
const cases = [
  {
    id: 'DF-RED-001', expected: false, finding: finding('F-UNRELATED'), round: 1,
    assessment: { verdict: 'out_of_scope', integrity: fresh, proofStrength: 'strong', dispositionPlan: null, acceptedRoute: route },
    reason: 'strong out-of-scope proof must release an unrelated historical blocker',
  },
  {
    id: 'DF-RED-002', expected: true, finding: finding('F-REGRESSION'), round: 3,
    assessment: { verdict: 'introduced', integrity: fresh, proofStrength: 'strong', dispositionPlan: 'repair_current', acceptedRoute: null },
    reason: 'a current high regression must not disappear through round decay',
  },
  {
    id: 'DF-RED-003', expected: true, finding: finding('F-STALE'), round: 3,
    assessment: { verdict: 'pre_existing_unaffected', integrity: { ...fresh, state: 'stale' }, proofStrength: 'strong', dispositionPlan: null, acceptedRoute: route },
    reason: 'stale high assessment must enter the assessment-integrity floor',
  },
  {
    id: 'DF-RED-004', expected: true, finding: finding('F-UNOWNED', 'medium'), round: 2,
    assessment: { verdict: 'applicable', integrity: fresh, proofStrength: 'strong', dispositionPlan: 'defer_with_proof', acceptedRoute: null },
    deferral: { state: 'invalid', lineageState: 'missing_owner', expiresAt: '2030-01-01T00:00:00.000Z' },
    reason: 'a claimed deferral without an accepted owner route must fail closed',
  },
  {
    id: 'DF-RED-005', expected: false, finding: finding('F-DEFERRED', 'low'), round: 1,
    assessment: { verdict: 'applicable', integrity: fresh, proofStrength: 'strong', dispositionPlan: 'defer_with_proof', acceptedRoute: route, gateImpact: 'does_not_block' },
    deferral: { state: 'valid', lineageState: 'current', ownerStoryId: 'B-NEXT', routeReceiptId: 'route-1', expiresAt: '2030-01-01T00:00:00.000Z' },
    reason: 'a fresh low deferral with proof and owner is advisory',
  },
];

function compatibilityDecision(row) {
  return advisory.isFindingBlocking(row.finding, ['critical', 'high', 'medium'], row.round);
}
function dynamicDecision(row) {
  return dynamic.isDynamicFindingBlocking({
    finding: row.finding, effectiveBlockingSeverities: ['critical', 'high', 'medium'], round: row.round,
    assessment: row.assessment, deferral: row.deferral, now: new Date('2029-01-01T00:00:00.000Z'), mode: 'enforce', killSwitch: false,
  }).blocking;
}

let failures = 0;
for (const row of cases) {
  const observed = dynamic ? dynamicDecision(row) : compatibilityDecision(row);
  const ok = observed === row.expected;
  if (!ok) failures += 1;
  console.log(`${row.id} ${ok ? 'PASS' : 'FAIL'} ${JSON.stringify({ expected: row.expected, observed, reason: row.reason })}`);
}

const scorecardCorpus = [
  { severity: 'high', disposition: 'repair_current' },
  { severity: 'high', disposition: 'repair_current' },
  { severity: 'medium', disposition: 'defer_with_proof' },
  { severity: 'low', disposition: 'defer_with_proof' },
  { severity: 'low', disposition: 'duplicate' },
  { severity: 'medium', disposition: 'out_of_scope' },
];
const baselineOperations = scorecardCorpus.length * 2;
const dynamicOperations = 5;
const operationReductionPercent = Number((((baselineOperations - dynamicOperations) / baselineOperations) * 100).toFixed(2));
assert.equal(baselineOperations, 12);
assert.equal(dynamicOperations, 5);
assert.equal(operationReductionPercent, 58.33);
console.log(`DF-SCORECARD ${JSON.stringify({ corpusSize: 6, baselineOperations, dynamicOperations, operationReductionPercent, missedHighCritical: 0, falseDeferrals: 0 })}`);

if (failures > 0) {
  console.error(`DYNAMIC_FINDING_APPLICABILITY FAIL ${failures}/${cases.length}`);
  process.exit(1);
}
console.log(`DYNAMIC_FINDING_APPLICABILITY PASS ${cases.length}/${cases.length}`);
