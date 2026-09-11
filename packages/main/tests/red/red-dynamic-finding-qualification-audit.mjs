import assert from 'node:assert/strict';
import { FINDING_QUALIFICATION_POLICY, FINDING_QUALIFICATION_METRICS, buildFindingQualificationScorecard } from '../../dist/core/finding-rollout-qualification.js';
import { applicabilityDigest } from '../../dist/core/finding-applicability.js';
const now = new Date('2029-02-01T00:00:00Z'); const digest = 'a'.repeat(64);
// Calculator fixtures only. These simulated observations are not operational
// evidence and are never submitted to the official qualification command.
const corpus = () => ({ policyDigest: applicabilityDigest(FINDING_QUALIFICATION_POLICY), featureState: 'warn',
  window: { start: '2029-01-01T00:00:00Z', end: now.toISOString() }, repositoryHeads: ['a'.repeat(40)],
  storyClasses: ['finding-heavy'], detectorVersions: ['test-v1'], retryPolicy: 'No retry', exclusions: [], latencyHardware: 'simulated',
  timingSeconds: { classifier: 1, triage: 1, repair: 1, convergence: 1 },
  prerequisites: Object.fromEntries(FINDING_QUALIFICATION_POLICY.requiredPrerequisites.map(name => [name, { passed: true, evidenceDigests: [digest] }])),
  measurements: Array.from({ length: 200 }, (_, i) => FINDING_QUALIFICATION_METRICS.map(([metric, comparison]) => ({ metric,
    caseId: `case-${i}`, storyId: `B-${i % 20}`, severity: i % 2 ? 'critical' : 'high',
    observedAt: new Date(Date.parse('2029-01-01T00:00:00Z') + i / 199 * 31 * 86400000).toISOString(),
    numerator: comparison === 'max' ? 0 : metric === 'workflow_operation_reduction' ? 0.5 : metric === 'review_convergence_reduction' ? 0.3 : 1,
    denominator: 1, evidenceDigests: [digest], independentlyAdjudicated: true, synthetic: false, latencySeconds: 1, latencyPopulationSize: 2273 }))).flat(),
  simpleStoryRegression: 0.1, timeoutRate: 0.01, latencyCorpusSize: 2273, candidateBaselineExplained: true });
let failed = 0; let passed = 0;
function check(name, run) { try { run(); passed++; console.log(`${name} PASS`); } catch (error) { failed++; console.error(`${name} FAIL ${error.message}`); } }
check('QUAL-single-critical-miss-cannot-hide-behind-average', () => {
  const input = corpus(); input.measurements.find(row => row.metric === 'nonblocking_precision' && row.severity === 'critical').numerator = 0;
  const row = buildFindingQualificationScorecard(input, now).rows.find(row => row.metric === 'nonblocking_precision');
  assert.equal(row.status, 'refuse');
});
check('QUAL-synthetic-cannot-dilute-operational-errors', () => {
  const input = corpus();
  const real = input.measurements.filter(row => row.metric === 'nonblocking_precision');
  real.forEach((row, i) => { row.severity = i % 3 === 0 ? 'low' : row.severity; if (i % 3 === 0) row.numerator = 0; });
  input.measurements.push(...Array.from({ length: 4000 }, (_, i) => ({ ...real[1], caseId: `synthetic-${i}`, numerator: 1, synthetic: true })));
  const row = buildFindingQualificationScorecard(input, now).rows.find(row => row.metric === 'nonblocking_precision');
  assert.equal(row.status, 'refuse'); assert.equal(row.denominator, 200);
});
console.log(`DYNAMIC_FINDING_QUALIFICATION_AUDIT ${failed ? 'FAIL' : 'PASS'} ${passed} passed ${failed} failed`);
process.exitCode = failed ? 1 : 0;
