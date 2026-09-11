import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { generateEd25519KeyPair } from '../core/authority-signing.js';
import {
  REQUIRED_ASSESSMENT_INVALID, deferralExpiry, dynamicFindingScorecard,
  isDynamicFindingBlocking, signApplicabilityAssessment, verifyApplicabilityAssessment,
  verifyAssessmentFreshness, type FindingApplicabilityAssessment,
} from '../core/finding-applicability.js';
import { StoryStore } from '../core/store.js';
import { withMkdirLock, captureMkdirLockFence } from '../core/mkdir-lock.js';
import { appendFindingLedger, findingLedgerSignerFromWorkspace } from '../handlers/finding-ledger.js';
import { createFindingApplicabilityHandlers } from '../handlers/finding-applicability.js';
import { readDynamicFindingDecision } from '../core/finding-applicability-projection.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
const now = new Date('2029-01-01T00:00:00.000Z');
const route = { state: 'accepted' as const, ownerStoryId: 'B-NEXT', receiptState: 'fresh' as const, receiptId: 'route-1', expiresAt: '2030-01-01T00:00:00.000Z' };
const integrity = { state: 'fresh' as const, storyId: 'B-CURRENT', scopeDigest: 'scope', baseHash: 'base', headHash: 'head', acceptanceDigest: 'acceptance', runtimeReceiptDigest: 'runtime' };
const finding = (severity = 'high') => ({ status: 'open', severity, evidenceState: 'verified' });
const decide = (overrides: Record<string, unknown> = {}) => isDynamicFindingBlocking({
  finding: finding(), effectiveBlockingSeverities: ['critical', 'high', 'medium'], round: 1,
  assessment: { verdict: 'applicable', integrity, proofStrength: 'strong', dispositionPlan: 'repair_current', acceptedRoute: null },
  mode: 'enforce', now, ...overrides,
});

test('strong out-of-scope proof releases unrelated blocker', () => assert.equal(decide({ assessment: { verdict: 'out_of_scope', integrity, proofStrength: 'strong', dispositionPlan: null, acceptedRoute: route } }).blocking, false));
test('current high regression ignores round decay', () => assert.equal(decide({ round: 3, assessment: { verdict: 'introduced', integrity, proofStrength: 'strong', dispositionPlan: 'repair_current', acceptedRoute: null } }).blocking, true));
for (const state of REQUIRED_ASSESSMENT_INVALID) {
  test(`high ${state} assessment fails closed`, () => assert.deepEqual(decide({ round: 3, assessment: state === 'missing' ? null : { verdict: 'out_of_scope', integrity: { ...integrity, state }, proofStrength: 'strong', dispositionPlan: null, acceptedRoute: route } }).floors.includes('assessment_integrity'), true));
}
test('invalid deferral lineage is first floor', () => {
  const result = decide({ finding: finding('medium'), assessment: { verdict: 'applicable', integrity, proofStrength: 'strong', dispositionPlan: 'defer_with_proof', acceptedRoute: route }, deferral: { state: 'invalid', lineageState: 'missing_owner', expiresAt: route.expiresAt } });
  assert.equal(result.blocking, true); assert.deepEqual(result.floors, ['deferral_lineage', 'mandatory_repair']);
});
test('strong non-applicable supersession releases lineage but not downstream repair', () => {
  const result = decide({ finding: finding('medium'), assessment: { verdict: 'out_of_scope', integrity, proofStrength: 'strong', dispositionPlan: null, acceptedRoute: route }, deferral: { state: 'expired', lineageState: 'expired', ownerStoryId: 'B-NEXT', routeReceiptId: 'route-1', expiresAt: '2028-01-01T00:00:00.000Z' } });
  assert.equal(result.blocking, true); assert.deepEqual(result.floors, ['mandatory_repair']);
});
test('valid low deferral is advisory', () => assert.equal(decide({ finding: finding('low'), assessment: { verdict: 'applicable', integrity, proofStrength: 'strong', dispositionPlan: 'defer_with_proof', acceptedRoute: route, gateImpact: 'does_not_block' }, deferral: { state: 'valid', lineageState: 'current', ownerStoryId: 'B-NEXT', routeReceiptId: 'route-1', expiresAt: route.expiresAt, assessmentDispositionPlan: 'defer_with_proof' } }).blocking, false));
test('introduced regression cannot be deferred', () => assert.equal(decide({ finding: finding('low'), assessment: { verdict: 'introduced', integrity, proofStrength: 'strong', dispositionPlan: 'defer_with_proof', acceptedRoute: route, gateImpact: 'does_not_block' }, deferral: { state: 'valid', lineageState: 'current', ownerStoryId: 'B-NEXT', routeReceiptId: 'route-1', expiresAt: route.expiresAt, assessmentDispositionPlan: 'defer_with_proof' } }).blocking, true));
test('gate-blocking applicable finding cannot be deferred', () => assert.equal(decide({ finding: finding('low'), assessment: { verdict: 'applicable', integrity, proofStrength: 'strong', dispositionPlan: 'defer_with_proof', acceptedRoute: route, gateImpact: 'blocks' }, deferral: { state: 'valid', lineageState: 'current', ownerStoryId: 'B-NEXT', routeReceiptId: 'route-1', expiresAt: route.expiresAt, assessmentDispositionPlan: 'defer_with_proof' } }).blocking, true));
test('high cannot use valid deferral to bypass repair', () => assert.equal(decide({ assessment: { verdict: 'applicable', integrity, proofStrength: 'strong', dispositionPlan: 'defer_with_proof', acceptedRoute: route }, deferral: { state: 'valid', lineageState: 'current', expiresAt: route.expiresAt } }).blocking, true));
test('expired deferral fails closed', () => assert.equal(decide({ finding: finding('low'), assessment: { verdict: 'applicable', integrity, proofStrength: 'strong', dispositionPlan: 'defer_with_proof', acceptedRoute: route }, deferral: { state: 'valid', lineageState: 'current', expiresAt: '2028-01-01T00:00:00.000Z' } }).blocking, true));
test('mandatory repair requires explicit closure', () => assert.equal(decide({ mandatoryRepair: { state: 'required' }, assessment: { verdict: 'pre_existing_unaffected', integrity, proofStrength: 'strong', dispositionPlan: null, acceptedRoute: route } }).blocking, true));
test('mandatory repair closure releases independent floor', () => assert.equal(decide({ mandatoryRepair: { state: 'closure_proven' }, assessment: { verdict: 'pre_existing_unaffected', integrity, proofStrength: 'strong', dispositionPlan: null, acceptedRoute: route } }).blocking, false));
test('not-reproduced witness cannot release high floor', () => assert.equal(decide({ assessment: { verdict: 'not_reproduced_under_current_witness', integrity, proofStrength: 'strong', dispositionPlan: null, acceptedRoute: route } }).blocking, true));
test('not-reproduced witness cannot release medium after route expiry', () => assert.equal(decide({ finding: finding('medium'), assessment: { verdict: 'not_reproduced_under_current_witness', integrity, proofStrength: 'strong', dispositionPlan: null, acceptedRoute: { ...route, receiptState: 'stale' } } }).blocking, true));
test('fresh signed disproven truth transition releases', () => assert.equal(decide({ assessment: { verdict: 'disproven', integrity, proofStrength: 'strong', dispositionPlan: null, acceptedRoute: null } }).blocking, false));
test('unknown high verdict fails closed', () => assert.equal(decide({ round: 3, assessment: { verdict: 'unknown', integrity, proofStrength: 'strong', dispositionPlan: null, acceptedRoute: null } }).blocking, true));
test('observe keeps legacy round decay', () => assert.equal(decide({ round: 3, mode: 'observe' }).blocking, false));
test('warn keeps gate result and exposes dynamic result', () => { const result = decide({ round: 3, mode: 'warn' }); assert.equal(result.blocking, false); assert.equal(result.dynamicBlocking, true); });
test('kill switch restores legacy predicate', () => assert.equal(decide({ round: 3, killSwitch: true }).blocking, false));
test('observe mode avoids dynamic ledger and Git freshness reads', () => {
  const scratch = mkdtempSync(resolve(tmpdir(), 'dynamic-finding-observe-'));
  try {
    writeFileSync(resolve(scratch, 'proof-or-stop.config.json'), JSON.stringify({ dynamicFinding: { mode: 'observe' } }));
    const decision = readDynamicFindingDecision({ store: new StoryStore(scratch), projectRoot: scratch, storyId: 'B-NO-STORY',
      finding: { id: 'B-NO-STORY:F-001', desc: 'legacy blocker', category: 'edge', status: 'open', severity: 'high', evidenceState: 'verified' },
      effectiveBlockingSeverities: ['high'], round: 1 });
    assert.equal(decision.reason, 'observe_legacy');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
test('closed finding never blocks', () => assert.equal(decide({ finding: { ...finding(), status: 'resolved' } }).blocking, false));
test('suspected finding never blocks', () => assert.equal(decide({ finding: { ...finding(), evidenceState: 'suspected' } }).blocking, false));

test('medium expiry is seven days', () => assert.equal(deferralExpiry('medium', now).toISOString(), '2029-01-08T00:00:00.000Z'));
test('low expiry is thirty days', () => assert.equal(deferralExpiry('low', now).toISOString(), '2029-01-31T00:00:00.000Z'));
test('medium renewal is refused', () => assert.throws(() => deferralExpiry('medium', now, 1), /RENEWAL_EXHAUSTED/));
test('low renewal stays inside hard 30-day cap', () => assert.equal(deferralExpiry('low', now, 1).toISOString(), '2029-01-31T00:00:00.000Z'));
test('high deferral expiry is refused', () => assert.throws(() => deferralExpiry('high', now), /INELIGIBLE_SEVERITY/));

const pair = generateEd25519KeyPair();
const unsigned: FindingApplicabilityAssessment = { schemaVersion: 1, assessmentId: 'A-1', findingId: 'F-1', verdict: 'out_of_scope', integrity, proofStrength: 'strong', dispositionPlan: null, acceptedRoute: route, keyId: 'K-1' };
const signed = signApplicabilityAssessment(unsigned, pair.privateKey);
test('assessment signature verifies', () => assert.equal(verifyApplicabilityAssessment(signed, pair.publicKey), true));
test('assessment tamper is rejected', () => assert.equal(verifyApplicabilityAssessment({ ...signed, verdict: 'applicable' }, pair.publicKey), false));
test('assessment wrong key is rejected', () => assert.equal(verifyApplicabilityAssessment(signed, generateEd25519KeyPair().publicKey), false));
test('freshness accepts exact current tuple', () => assert.equal(verifyAssessmentFreshness(signed, { storyId: 'B-CURRENT', scopeDigest: 'scope', baseHash: 'base', headHash: 'head', acceptanceDigest: 'acceptance', runtimeReceiptDigest: 'runtime' }, now), 'fresh'));
test('freshness rejects head drift', () => assert.equal(verifyAssessmentFreshness(signed, { storyId: 'B-CURRENT', scopeDigest: 'scope', baseHash: 'base', headHash: 'changed', acceptanceDigest: 'acceptance', runtimeReceiptDigest: 'runtime' }, now), 'mismatched'));
test('freshness rejects unsigned record', () => assert.equal(verifyAssessmentFreshness(unsigned, { storyId: 'B-CURRENT', scopeDigest: 'scope', baseHash: 'base', headHash: 'head', acceptanceDigest: 'acceptance', runtimeReceiptDigest: 'runtime' }, now), 'unsigned'));

test('scorecard reproduces preregistered 58.33 percent reduction', () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({ findingId: `F-${index}`, severity: 'high', assessmentVerdict: 'applicable' as const,
    dispositionPlan: 'repair_current' as const, gateImpact: 'blocks' as const, decision: decide() }));
  assert.deepEqual(dynamicFindingScorecard(rows, 12, 5), { total: 6, legacyBlocking: 6, dynamicBlocking: 6, changed: 0, operationReductionPercent: 58.33, missedHighCritical: 0, falseDeferrals: 0 });
});
test('scorecard derives safety misses from rows instead of assuming zero', () => {
  const unsafeDecision = { ...decide(), dynamicBlocking: false };
  const rows = [{ findingId: 'F-unsafe', severity: 'high', assessmentVerdict: 'applicable' as const,
    dispositionPlan: 'defer_with_proof' as const, gateImpact: 'blocks' as const, decision: unsafeDecision }];
  assert.equal(dynamicFindingScorecard(rows).missedHighCritical, 1);
  assert.equal(dynamicFindingScorecard(rows).falseDeferrals, 1);
});

test('handler atomically persists, replays and projects one signed assessment', () => {
  const scratch = mkdtempSync(resolve(tmpdir(), 'dynamic-finding-smoke-'));
  try {
    writeFileSync(resolve(scratch, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', storyPrefix: 'B', flows: { defaults: {}, patterns: [] }, dynamicFinding: { mode: 'enforce' } }));
    execFileSync('git', ['init', '-b', 'main'], { cwd: scratch, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Dynamic Finding Smoke'], { cwd: scratch });
    execFileSync('git', ['config', 'user.email', 'dynamic@example.invalid'], { cwd: scratch });
    writeFileSync(resolve(scratch, 'material.txt'), 'baseline\n');
    execFileSync('git', ['add', 'material.txt', 'proof-or-stop.config.json'], { cwd: scratch });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: scratch, stdio: 'ignore' });
    const store = new StoryStore(scratch);
    const storyId = 'B-DYNAMIC';
    store.writeStory(storyId, { storyId, name: 'dynamic', title: 'dynamic', description: 'dynamic', type: 'feature', phase: 'DEV', priority: 'high', createdAt: now.toISOString(), startedAt: now.toISOString(), endedAt: null, events: [] });
    store.writeChecklist(storyId, { items: [] });
    const sourceFinding = { id: 'B-DYNAMIC:F-001', desc: 'Current regression', severity: 'high' as const, category: 'edge' as const, status: 'open' as const, evidenceState: 'verified' as const };
    const secondFinding = { id: 'B-DYNAMIC:F-002', desc: 'Second current regression', severity: 'high' as const, category: 'edge' as const, status: 'open' as const, evidenceState: 'verified' as const };
    const lockDir = store.runtimeLockDirPath(storyId, 'finding', 'findings');
    withMkdirLock(lockDir, () => {
      const fence = captureMkdirLockFence(lockDir); const signer = findingLedgerSignerFromWorkspace(scratch);
      appendFindingLedger({ storyId, store, operation: 'append_finding', idempotencyKey: 'seed',
        records: [
          { recordType: 'finding', payload: sourceFinding, uniqueBindingKey: sourceFinding.id },
          { recordType: 'finding', payload: secondFinding, uniqueBindingKey: secondFinding.id },
        ],
        writerSessionId: 'smoke', writerLeaseId: 'smoke', writerFenceToken: fence.writerFenceToken, fence, signer });
    }, { label: 'dynamic finding smoke seed', requireHolderToken: true });
    const handlers = createFindingApplicabilityHandlers({ store, root: scratch, scanRoot: scratch });
    const request = { storyId, findingId: sourceFinding.id, idempotencyKey: 'assessment-1', verdict: 'introduced' as const, proofStrength: 'strong' as const, dispositionPlan: 'repair_current' as const, gateImpact: 'blocks' as const };
    const first = handlers.finding_applicability_assess(request);
    const replay = handlers.finding_applicability_assess(structuredClone(request));
    assert.equal(first.assessment.assessmentId, replay.assessment.assessmentId);
    assert.equal(handlers.finding_triage({ storyId }).rows[0]?.decision.reason, 'mandatory_repair_floor');
    assert.throws(() => handlers.finding_applicability_assess({ ...request, verdict: 'unknown' }), /IDEMPOTENCY_CONFLICT/);
    const batchRequest = { storyId, idempotencyKey: 'batch-1', items: [sourceFinding.id, secondFinding.id].map(findingId => ({
      findingId, verdict: 'introduced' as const, proofStrength: 'strong' as const,
      dispositionPlan: 'repair_current' as const, gateImpact: 'blocks' as const,
    })) };
    const batch = handlers.finding_applicability_batch(batchRequest);
    const batchReplay = handlers.finding_applicability_batch(structuredClone(batchRequest));
    assert.equal(batch.assessments.length, 2);
    assert.equal(batch.manifest.manifestId, batchReplay.manifest.manifestId);
    assert.equal(store.readFindingLedger(storyId).receipts.filter(row => row.idempotencyKey === 'dynamic-batch:batch-1').length, 1);
    writeFileSync(resolve(scratch, 'material.txt'), 'changed\n');
    execFileSync('git', ['add', 'material.txt'], { cwd: scratch });
    execFileSync('git', ['commit', '-m', 'material drift'], { cwd: scratch, stdio: 'ignore' });
    assert.equal(handlers.finding_triage({ storyId }).rows[0]?.decision.reason, 'assessment_integrity_floor');
    const refreshed = handlers.finding_applicability_assess({ ...request, idempotencyKey: 'assessment-2' });
    assert.ok('reattestation' in refreshed);
    assert.equal(handlers.finding_triage({ storyId }).rows[0]?.decision.reason, 'mandatory_repair_floor');
    const flattened = Object.fromEntries(Object.entries(handlers)) as { finding_rollout_scorecard: typeof handlers.finding_rollout_scorecard };
    const { finding_rollout_scorecard: detachedRolloutScorecard } = flattened;
    const rollout = detachedRolloutScorecard({ storyId }) as ReturnType<typeof handlers.finding_rollout_scorecard>;
    assert.equal(rollout.scorecard.missedHighCritical, 0);
    assert.equal(rollout.scorecard.falseDeferrals, 0);
    assert.equal(rollout.rows.length, 2);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

const root = resolve(import.meta.dirname, '../../../..');
const source = (path: string) => readFileSync(resolve(root, path), 'utf8');
test('machine gate consumes shared projection', () => assert.match(source('packages/main/src/core/machine.ts'), /readDynamicFindingDecision/));
test('guard diagnostic consumes shared projection', () => assert.match(source('packages/main/src/core/guard-utils.ts'), /readDynamicFindingDecision/));
test('reviewer batch consumes shared projection', () => assert.match(source('packages/main/src/handlers/reviewer-batch.ts'), /readDynamicFindingDecision/));
test('all Dynamic Finding commands are registered', () => {
  const registry = source('packages/main/src/registry.ts'); const catalog = source('packages/main/src/cli/command-catalog.ts');
  for (const command of ['finding_applicability_assess', 'finding_applicability_batch', 'finding_deferral_record', 'finding_mandatory_repair_close', 'finding_triage', 'finding_rollout_scorecard']) {
    assert.match(catalog, new RegExp(`name: '${command}'`)); assert.match(registry + source('packages/main/src/handlers/finding-applicability.ts'), new RegExp(command));
  }
});
test('process-fact contract declares L4 gate consumer', () => assert.match(source('packages/main/src/core/process-fact-levels.ts'), /runtime:dynamic_finding_applicability_gate[^\n]+level: 'L4'/));
test('rollout has observe warn enforce and kill switch', () => { const config = source('packages/main/src/core/config.ts'); assert.match(config, /'observe' \| 'warn' \| 'enforce'/); assert.match(config, /killSwitch/); });

if (process.exitCode) {
  console.error(`DYNAMIC_FINDING_GREEN FAIL ${passed}`);
  process.exit(process.exitCode);
}
console.log(`DYNAMIC_FINDING_GREEN PASS ${passed}`);
