import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDynamicFindingBlocking, dynamicFindingScorecard } from '../../dist/core/finding-applicability.js';
import { resolveDynamicFindingRollout } from '../../dist/core/finding-applicability-projection.js';
import { FINDING_EVIDENCE_FIXTURE_RUNTIME_POLICY as findingFixtureBudget } from '../../dist/core/runtime-fact-registry.js';

const root = resolve(import.meta.dirname, '../../../..');
const now = new Date('2029-01-01T00:00:00Z');
const route = { state: 'accepted', ownerStoryId: 'B-target', receiptState: 'fresh', receiptId: 'route-1', expiresAt: '2029-01-31T00:00:00Z' };
const integrity = { state: 'fresh', storyId: 'B-source', scopeDigest: 'scope', baseHash: 'base', headHash: 'head', acceptanceDigest: 'acceptance', runtimeReceiptDigest: 'runtime' };
const input = () => ({ finding: { status: 'open', evidenceState: 'verified', severity: 'low' },
  effectiveBlockingSeverities: ['critical', 'high', 'medium'], round: 3, mode: 'enforce', now,
  assessment: { verdict: 'applicable', proofStrength: 'strong', dispositionPlan: 'defer_with_proof', gateImpact: 'does_not_block', acceptedRoute: route, integrity },
  deferral: { state: 'valid', lineageState: 'current', ownerStoryId: 'B-target', routeReceiptId: 'route-1', expiresAt: route.expiresAt, assessmentDispositionPlan: 'defer_with_proof' } });
const cases = [];
const test = (id, fn) => { try { fn(); cases.push({ id, pass: true }); console.log(`${id} PASS`); }
  catch (e) { cases.push({ id, pass: false }); console.error(`${id} FAIL ${e.message}`); } };

test('DFEC-01-unqualified-enforce', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'dfec-rollout-'));
  try { writeFileSync(resolve(dir, 'proof-or-stop.config.json'), JSON.stringify({ dynamicFinding: { mode: 'enforce' } }));
    const mode = resolveDynamicFindingRollout(dir);
    assert.notEqual(mode.mode, 'enforce', 'a config string cannot qualify a repository for enforce');
    assert.ok(mode.refusalReasons?.length, 'the refused promotion must explain the missing evidence');
  } finally { rmSync(dir, { recursive: true }); }
});
test('DFEC-02-empty-safety-denominator', () => {
  const score = dynamicFindingScorecard([]);
  assert.equal(score.missedHighCritical, null, 'no independent adjudications means unknown, not zero safety misses');
  assert.equal(score.falseDeferrals, null, 'empty deferral evidence cannot claim zero risk');
});
test('DFEC-03-protected-surface-missing', () => assert.equal(isDynamicFindingBlocking(input()).blocking, true,
  'missing protected-surface and reproduction proof must not authorize low deferral'));
test('DFEC-04-protected-surface-risk', () => {
  const value = input(); value.assessment.protectedSurfaceEvaluation = [{ surface: 'data_integrity', state: 'known_risk', evidenceRefs: ['R-1'] }];
  assert.equal(isDynamicFindingBlocking(value).blocking, true, 'low severity cannot waive data-integrity risk');
});
test('DFEC-05-signed-label-is-not-proof', () => {
  const value = input(); value.finding.severity = 'high'; delete value.deferral;
  value.assessment = { ...value.assessment, verdict: 'out_of_scope', dispositionPlan: null };
  assert.equal(isDynamicFindingBlocking(value).blocking, true, 'fresh + strong labels without scope evidence are insufficient');
});
test('DFEC-06-status-cannot-erase-repair', () => {
  const value = input(); value.finding.status = 'dismissed'; value.mandatoryRepair = { state: 'required' };
  assert.equal(isDynamicFindingBlocking(value).blocking, true, 'status changes cannot erase a confirmed repair obligation');
});

for (const [id, path, marker, args = []] of [
  ['DFEC-07-evidence-gate-fixture', 'packages/main/dist/tasks/evidence-state-gate-smoke.js', 'evidenceState'],
  ['DFEC-08-reviewer-lane-fixture', 'packages/main/dist/tasks/reviewer-batch-smoke.js', 'reviewer'],
  ['DFEC-09-reviewed-document-binding', 'scripts/verify-story-aware-validation-plan.mjs', 'story-aware validation plan integrity PASS', ['--tamper-self-test']],
]) test(id, () => {
  assert.ok(existsSync(resolve(root, path)), `environment prerequisite missing: ${path}`);
  const run = spawnSync(process.execPath, [path, ...args], { cwd: root, encoding: 'utf8', timeout: findingFixtureBudget.controllerMs });
  assert.equal(run.signal, null, 'timeout or signal is not target RED');
  assert.equal(run.status, 0, `${path}: ${`${run.stdout}\n${run.stderr}`.slice(-3500)}`);
  assert.match(`${run.stdout}\n${run.stderr}`, new RegExp(marker));
});
const failed = cases.filter(row => !row.pass).length;
console.log(`DFEC_SUMMARY ${JSON.stringify({ total: cases.length, passed: cases.length - failed, failed, cases })}`);
console.log(`DYNAMIC_FINDING_EVIDENCE_CLOSURE ${failed ? 'FAIL' : 'PASS'}`);
process.exitCode = failed ? 1 : 0;
