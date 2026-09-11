/** Deterministic laboratory corpus, never operational qualification evidence. */
import assert from 'node:assert/strict';
import { FINDING_QUALIFICATION_METRICS, FINDING_QUALIFICATION_POLICY, buildFindingQualificationScorecard,
  type FindingQualificationCorpus } from '../core/finding-rollout-qualification.js';
import { applicabilityDigest, FINDING_PROTECTED_SURFACES, isDynamicFindingBlocking } from '../core/finding-applicability.js';
import { verifyFindingWitness, FINDING_PROOF_POLICY, type FindingWitness } from '../handlers/finding-applicability-proof.js';
import { buildDynamicValidationPlan, assertSelectionIsSingletonUnionMonotonic, discoverValidationInventory,
  compileValidationCatalog, createValidationClosureCertificate, buildStoryChangeManifest } from '../core/story-aware-validation.js';

let count = 0;
function test(name: string, run: () => void) { run(); count++; console.log(`DFEC_CONTRACT ${name} PASS`); }
const now = new Date('2029-02-01T00:00:00Z');
const fakeDigest = 'a'.repeat(64);
const simulatedOperationalCorpus = (): FindingQualificationCorpus => ({
  policyDigest: applicabilityDigest(FINDING_QUALIFICATION_POLICY), featureState: 'warn', window: { start: '2029-01-01T00:00:00Z', end: now.toISOString() },
  repositoryHeads: ['a'.repeat(40)], storyClasses: ['finding-heavy', 'simple'], detectorVersions: ['fixture-v1'],
  retryPolicy: 'No retry', exclusions: [], latencyHardware: 'Deterministic simulation, not measured hardware',
  timingSeconds: { classifier: 1, triage: 1, repair: 100, convergence: 1 },
  prerequisites: Object.fromEntries(FINDING_QUALIFICATION_POLICY.requiredPrerequisites.map(name => [name, { passed: true, evidenceDigests: [fakeDigest] }])),
  measurements: Array.from({ length: 200 }, (_, index) => FINDING_QUALIFICATION_METRICS.map(([metric, comparison]) => ({
    metric, caseId: `simulated-${index}`, storyId: `B-SIMULATED-${index % 20}`, severity: index % 2 ? 'critical' as const : 'high' as const,
    observedAt: new Date(Date.parse('2029-01-01T00:00:00Z') + index / 199 * 31 * 86_400_000).toISOString(),
    numerator: comparison === 'max' ? 0 : metric === 'workflow_operation_reduction' ? 0.5 : metric === 'review_convergence_reduction' ? 0.3 : 1,
    denominator: 1, evidenceDigests: [fakeDigest], independentlyAdjudicated: true, synthetic: false, latencySeconds: 1, latencyPopulationSize: 2273,
  }))).flat(), simpleStoryRegression: 0.1, timeoutRate: 0.01, latencyCorpusSize: 2273, candidateBaselineExplained: true,
});
test('all 22 scorecard rows remain present without evidence', () => {
  const report = buildFindingQualificationScorecard(undefined, now);
  assert.equal(report.rows.length, 22); assert.equal(report.qualification.eligible, false);
  assert.ok(report.rows.every(row => row.observed === null && row.evidenceDigests.length === 0));
});
test('complete simulated boundary corpus qualifies only the pure calculator', () => {
  const report = buildFindingQualificationScorecard(simulatedOperationalCorpus(), now);
  assert.deepEqual(report.refusalReasons, []); assert.equal(report.qualification.eligible, true);
  const row = report.rows.find(row => row.metric === 'false_nonblocking_high_critical')!;
  assert.equal(row.observed, 0); assert.ok(row.strata.every(stratum => stratum.sampledN === 100 && stratum.zeroEventUpperBound! > 0));
});
test('every latency observation independently proves its measured population', () => {
  for (const population of [undefined, 1]) {
    const corpus = simulatedOperationalCorpus();
    corpus.measurements.find(row => row.metric === 'triage_latency')!.latencyPopulationSize = population;
    assert.equal(buildFindingQualificationScorecard(corpus, now).rows.find(row => row.metric === 'triage_latency')!.status, 'refuse');
  }
});
for (const [metric] of FINDING_QUALIFICATION_METRICS) test(`${metric} rejects rollback`, () => {
  const corpus = simulatedOperationalCorpus(); corpus.measurements.find(row => row.metric === metric)!.rollbackEvent = true;
  const report = buildFindingQualificationScorecard(corpus, now);
  assert.equal(report.qualification.eligible, false); assert.equal(report.rows.find(row => row.metric === metric)!.status, 'refuse');
});
for (const [metric] of FINDING_QUALIFICATION_METRICS) test(`${metric} cannot omit its denominator`, () => {
  const corpus = simulatedOperationalCorpus(); corpus.measurements = corpus.measurements.filter(row => row.metric !== metric);
  const report = buildFindingQualificationScorecard(corpus, now);
  assert.equal(report.qualification.eligible, false); assert.equal(report.rows.find(row => row.metric === metric)!.observed, null);
});
for (const [metric, comparison, threshold] of FINDING_QUALIFICATION_METRICS) test(`${metric} rejects below-threshold corpus`, () => {
  const corpus = simulatedOperationalCorpus();
  for (const row of corpus.measurements.filter(row => row.metric === metric)) {
    if (comparison === 'min') row.numerator = threshold! - 0.01;
    if (comparison === 'max') row.numerator = 0.01;
    if (comparison === 'latency') row.latencySeconds = 11;
  }
  if (comparison === 'descriptive') corpus.candidateBaselineExplained = false;
  assert.equal(buildFindingQualificationScorecard(corpus, now).qualification.eligible, false);
});
for (const mutation of ['synthetic', 'duplicate', 'future', 'no-independent-adjudication', 'window-only', 'no-prerequisite', 'metadata'] as const) test(`qualification ${mutation} refuses`, () => {
  const corpus = simulatedOperationalCorpus();
  if (mutation === 'synthetic') corpus.measurements.forEach(row => { row.synthetic = true; });
  if (mutation === 'duplicate') corpus.measurements.push(corpus.measurements[0]!);
  if (mutation === 'future') corpus.measurements[0]!.observedAt = '2099-01-01T00:00:00Z';
  if (mutation === 'no-independent-adjudication') corpus.measurements[0]!.independentlyAdjudicated = false;
  if (mutation === 'window-only') corpus.measurements.forEach(row => { row.observedAt = now.toISOString(); });
  if (mutation === 'no-prerequisite') corpus.prerequisites = {};
  if (mutation === 'metadata') corpus.latencyHardware = '';
  assert.equal(buildFindingQualificationScorecard(corpus, now).qualification.eligible, false);
});

const witness: FindingWitness = { schemaVersion: FINDING_PROOF_POLICY.witnessSchema, storyId: 'B-PROOF', findingId: 'F-1', baseHash: 'base', headHash: 'head',
  scopeDigest: 'scope', acceptanceDigest: 'acceptance', evaluationScope: 'target_story', verdict: 'out_of_scope', reproduced: true, baseReproduced: true,
  introducedByCurrentStory: false, gateImpact: 'does_not_block', affectedPaths: ['unrelated.ts'], checkedIntentRefs: ['CHK-001:happy:0'],
  protectedSurfaceEvaluation: FINDING_PROTECTED_SURFACES.map(surface => ({ surface, state: 'clear', evidenceRefs: ['CHK-001:happy:0'] })) };
const witnessContext = { storyId: 'B-PROOF', finding: { id: 'F-1', desc: 'Observed defect', severity: 'low' as const, category: 'edge' as const, status: 'open' as const },
  baseHash: 'base', headHash: 'head', scopeDigest: 'scope', acceptanceDigest: 'acceptance', evaluationScope: 'target_story' as const,
  intentRefs: ['CHK-001:happy:0'], changedPaths: ['current.ts'] };
test('complete executable witness matches source and inspected acceptance', () => verifyFindingWitness(witness, witnessContext));
for (const mutation of ['head', 'scope', 'intent', 'surface', 'changed-path', 'reproduction'] as const) test(`witness ${mutation} refuses`, () => {
  const value = structuredClone(witness);
  if (mutation === 'head') value.headHash = 'other';
  if (mutation === 'scope') value.evaluationScope = 'repository_release';
  if (mutation === 'intent') value.checkedIntentRefs = [];
  if (mutation === 'surface') value.protectedSurfaceEvaluation.pop();
  if (mutation === 'changed-path') value.affectedPaths = ['current.ts'];
  if (mutation === 'reproduction') { value.verdict = 'not_reproduced_under_current_witness'; value.reproduced = true; }
  assert.throws(() => verifyFindingWitness(value, witnessContext));
});
test('stored low deferral with raw material drift stays in first floor', () => {
  const result = isDynamicFindingBlocking({ finding: { status: 'open', severity: 'low', evidenceState: 'verified' }, effectiveBlockingSeverities: [], round: 3, mode: 'enforce', now,
    assessment: { verdict: 'applicable', integrity: { state: 're_attestation_required' }, proofStrength: 'strong', dispositionPlan: 'defer_with_proof', acceptedRoute: null },
    deferral: { state: 'valid', lineageState: 'current', expiresAt: '2030-01-01T00:00:00Z' } });
  assert.equal(result.blocking, true); assert.equal(result.floors[0], 'deferral_lineage');
});

const inventory = discoverValidationInventory('/tmp', [{ id: 'regression', label: 'regression', command: 'node', args: ['regression.js'], originalIndex: 0 }]);
const catalog = compileValidationCatalog(inventory, { inputRoots: ['src/current.ts'] });
const context = { storyId: 'B-VALIDATION', baseHead: 'base', head: 'head', inventory, catalog,
  changes: buildStoryChangeManifest({ storyId: 'B-VALIDATION', gitCwd: '.', baseHead: 'base', head: 'head', changedFiles: [] }),
  closures: new Map(catalog.map(entry => [entry.id, createValidationClosureCertificate({ commandId: entry.id, baseHead: 'base',
    inventoryDigest: inventory.digest, catalogDigest: 'catalog', staticPaths: ['src/current.ts'] })])) };
const findingConstraints = { schemaVersion: 'finding-validation-v1' as const, storyId: context.storyId, digest: fakeDigest,
  requiredCommands: [inventory.commands[0]!.command], affectedPaths: [], reassessFindingIds: [], scopeExpansionAuthorized: false as const };
test('Finding pins required verification without removing inventory', () => {
  const plan = buildDynamicValidationPlan({ ...context, findingConstraints });
  assert.equal(plan.findingConstraintDigest, fakeDigest); assert.equal(plan.rows.length, inventory.commands.length);
  assert.ok(plan.rows[0]!.reasons.includes('dynamic-finding-required'));
  assertSelectionIsSingletonUnionMonotonic({ ...context, findingConstraints }, plan);
  assert.throws(() => assertSelectionIsSingletonUnionMonotonic({ ...context, findingConstraints: { ...findingConstraints, digest: 'b'.repeat(64) } }, plan), /Finding|match/);
});
test('unknown command and unauthorized scope expansion refuse', () => {
  assert.throws(() => buildDynamicValidationPlan({ ...context, findingConstraints: { ...findingConstraints, requiredCommands: ['not-registered'] } }), /absent/);
  assert.throws(() => buildDynamicValidationPlan({ ...context, findingConstraints: { ...findingConstraints, scopeExpansionAuthorized: true } as never }), /scope/);
  assert.throws(() => buildDynamicValidationPlan({ ...context, findingConstraints: { ...findingConstraints, authority: 'shadow_only' } }), /shadow/);
});
test('expired or invalid Finding evidence requests complete fallback', () => {
  const plan = buildDynamicValidationPlan({ ...context, findingConstraints: { ...findingConstraints, reassessFindingIds: ['F-expired'] } });
  assert.equal(plan.fullEscalated, true); assert.ok(plan.escalationReasons.includes('finding-reassessment-required:F-expired'));
});
console.log(`DYNAMIC_FINDING_EVIDENCE_CONTRACT PASS ${count}`);
