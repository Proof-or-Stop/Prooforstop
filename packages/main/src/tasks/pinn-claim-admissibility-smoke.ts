import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PINN_FAILURE_INJECTIONS,
  buildCompletePinnEvidence,
  buildInjectedPinnEvidence,
  evaluatePinnClaim,
  renderPinnBenchmarkText,
  renderPinnReportText,
  runPinnClaimBenchmark,
} from '../core/pinn-claim-admissibility.js';
import { createPinnClaimAdmissibilityHandlers } from '../handlers/pinn-claim-admissibility.js';

function hasReason(result: ReturnType<typeof evaluatePinnClaim>, code: string): boolean {
  return result.reasons.some((reason) => reason === code || reason.startsWith(`${code}:`));
}

function assertBlocks(injectionId: string, reasonCode: string): void {
  const result = evaluatePinnClaim(buildInjectedPinnEvidence(injectionId));
  assert.equal(result.allowed, false, `${injectionId} must be blocked`);
  assert.ok(hasReason(result, reasonCode), `${injectionId} must include ${reasonCode}; got ${result.reasons.join(', ')}`);
}

const complete = evaluatePinnClaim(buildCompletePinnEvidence('C9'));
assert.equal(complete.allowed, true, 'complete C9 evidence advances');
assert.equal(complete.nextAction, 'advance', 'complete C9 advances');
assert.equal(complete.deploymentReadyClaim, false, 'complete check never claims deployment readiness');
assert.equal(complete.externalCompletionClaim, false, 'complete check never claims external completion');
assert.equal(complete.terminalCompletionClaim, false, 'complete check never claims terminal completion');
assert.equal(complete.pdeCorrectnessClaim, false, 'complete check never claims PDE correctness');
assert.equal(complete.checkedAdapters.length, 9, 'C9 checks all adapter families');

assert.deepEqual(
  PINN_FAILURE_INJECTIONS.map((injection) => `${injection.id}:${injection.title}`),
  [
    'B1:spec changed while residual reused',
    'B2:BC changed while BC report reused',
    'B3:checkpoint mismatch',
    'B4:collocation points changed',
    'B5:grid narrowed to easy region',
    'B6:baseline comparison benchmark mismatch',
    'B7:stale figure provenance',
    'B8:seed/config missing',
    'B9:low training loss but high out-of-sample residual',
    'B10:verifier threshold silently changed',
    'B11:BC report missing',
    'B12:IC report missing',
    'B13:code changed after checkpoint',
    'B14:metric changed',
    'B15:manually edited figures/tables',
  ],
  'B1-B15 corpus matches the governing plan',
);

assertBlocks('B1', 'identity_mismatch');
assertBlocks('B2', 'identity_mismatch');
assertBlocks('B3', 'identity_mismatch');
assertBlocks('B4', 'identity_mismatch');
assertBlocks('B5', 'identity_mismatch');
assertBlocks('B6', 'identity_mismatch');
assertBlocks('B7', 'stale_evidence');
assertBlocks('B8', 'missing_identity_field');
assertBlocks('B9', 'receipt_status_not_pass');
assertBlocks('B10', 'verifier_threshold_mismatch');
assertBlocks('B11', 'missing_required_receipt');
assertBlocks('B12', 'missing_required_receipt');
assertBlocks('B13', 'identity_mismatch');
assertBlocks('B14', 'metric_mismatch');
assertBlocks('B15', 'identity_mismatch');

const duplicateResidual = buildCompletePinnEvidence('C9');
const cleanResidual = duplicateResidual.receipts?.find((receipt) => receipt.adapterId === 'residual');
assert.ok(cleanResidual, 'fixture has residual receipt');
duplicateResidual.receipts = [
  ...(duplicateResidual.receipts ?? []).filter((receipt) => receipt.adapterId !== 'residual'),
  { ...cleanResidual, status: 'fail', stale: true, note: 'stale residual reused before clean duplicate' },
  { ...cleanResidual, note: 'clean duplicate must not erase ambiguity' },
];
const duplicateResult = evaluatePinnClaim(duplicateResidual);
assert.equal(duplicateResult.allowed, false, 'duplicate adapter receipts fail closed');
assert.ok(hasReason(duplicateResult, 'duplicate_receipt'), 'duplicate adapter receipts have explicit reason');

const malformedReceipts = buildCompletePinnEvidence('C9') as unknown as Record<string, unknown>;
malformedReceipts.receipts = { adapterId: 'spec-freeze' };
const malformedReceiptsResult = evaluatePinnClaim(malformedReceipts as any);
assert.equal(malformedReceiptsResult.allowed, false, 'non-array receipts fail closed');
assert.equal(malformedReceiptsResult.nextAction, 'stop', 'non-array receipts stop deterministically');
assert.ok(hasReason(malformedReceiptsResult, 'malformed_receipts'), 'non-array receipts have explicit reason');

const missingReceiptIdentity = buildCompletePinnEvidence('C9');
const missingIdentityReceipt = missingReceiptIdentity.receipts?.find((receipt) => receipt.adapterId === 'residual');
assert.ok(missingIdentityReceipt, 'fixture has residual receipt for malformed identity regression');
(missingIdentityReceipt as any).identity = null;
const missingReceiptIdentityResult = evaluatePinnClaim(missingReceiptIdentity);
assert.equal(missingReceiptIdentityResult.allowed, false, 'receipt identity missing/not object fails closed');
assert.equal(missingReceiptIdentityResult.nextAction, 'stop', 'receipt identity malformed stops deterministically');
assert.ok(hasReason(missingReceiptIdentityResult, 'malformed_receipt_identity'), 'receipt identity malformed has explicit reason');

const lowLoss = buildCompletePinnEvidence('C9');
lowLoss.trainingLossLow = true;
lowLoss.receipts = lowLoss.receipts?.filter((receipt) => receipt.adapterId === 'spec-freeze' || receipt.adapterId === 'training');
const lowLossResult = evaluatePinnClaim(lowLoss);
assert.equal(lowLossResult.allowed, false, 'low training loss alone cannot satisfy result-strength claims');
assert.ok(hasReason(lowLossResult, 'training_loss_not_solution_evidence'), 'low-loss-only path has explicit reason');

const terminalNarrative = buildCompletePinnEvidence('C9');
terminalNarrative.narrativeClaim = 'terminalCompletionClaim: true';
const terminalNarrativeResult = evaluatePinnClaim(terminalNarrative);
assert.equal(terminalNarrativeResult.allowed, false, 'terminal completion field narrative is blocked');
assert.ok(hasReason(terminalNarrativeResult, 'claim_boundary_violation'), 'terminal completion field narrative has boundary reason');

const legacyNarrative = buildCompletePinnEvidence('C9');
const legacyDoneField = ['production', 'Done'].join('');
legacyNarrative.narrativeClaim = `${legacyDoneField}: true`;
const legacyNarrativeResult = evaluatePinnClaim(legacyNarrative);
assert.equal(legacyNarrativeResult.allowed, false, 'legacy completion field narrative is blocked');
assert.ok(hasReason(legacyNarrativeResult, 'claim_boundary_violation'), 'legacy completion field narrative has boundary reason');

for (const narrativeClaim of [
  'PDE correctness proved',
  'PDE correctness verified',
  'PDE correctness guaranteed',
  'PDE correctness validated',
]) {
  const passivePdeNarrative = buildCompletePinnEvidence('C9');
  passivePdeNarrative.narrativeClaim = narrativeClaim;
  const passivePdeNarrativeResult = evaluatePinnClaim(passivePdeNarrative);
  assert.equal(passivePdeNarrativeResult.allowed, false, `passive PDE narrative is blocked: ${narrativeClaim}`);
  assert.ok(hasReason(passivePdeNarrativeResult, 'claim_boundary_violation'), `passive PDE narrative has boundary reason: ${narrativeClaim}`);
}

for (const narrativeClaim of [
  'Production readiness is proved for this PINN result.',
  'ready for production',
  'production-ready',
]) {
  const productionReadinessNarrative = buildCompletePinnEvidence('C9');
  productionReadinessNarrative.narrativeClaim = narrativeClaim;
  const productionReadinessNarrativeResult = evaluatePinnClaim(productionReadinessNarrative);
  assert.equal(productionReadinessNarrativeResult.allowed, false, `production-readiness narrative is blocked: ${narrativeClaim}`);
  assert.ok(hasReason(productionReadinessNarrativeResult, 'claim_boundary_violation'), `production-readiness narrative has boundary reason: ${narrativeClaim}`);
}

const numericTerminalClaim = buildCompletePinnEvidence('C9');
(numericTerminalClaim as unknown as Record<string, unknown>).terminalCompletionClaim = 1;
const numericTerminalClaimResult = evaluatePinnClaim(numericTerminalClaim);
assert.equal(numericTerminalClaimResult.allowed, false, 'numeric terminal completion field is blocked');
assert.ok(hasReason(numericTerminalClaimResult, 'claim_boundary_violation'), 'numeric terminal completion field has boundary reason');

const numericLegacyClaim = buildCompletePinnEvidence('C9');
(numericLegacyClaim as unknown as Record<string, unknown>)[legacyDoneField] = 1;
const numericLegacyClaimResult = evaluatePinnClaim(numericLegacyClaim);
assert.equal(numericLegacyClaimResult.allowed, false, 'numeric legacy completion field is blocked');
assert.ok(hasReason(numericLegacyClaimResult, 'claim_boundary_violation'), 'numeric legacy completion field has boundary reason');

const directProductionReadyClaim = buildCompletePinnEvidence('C9');
(directProductionReadyClaim as unknown as Record<string, unknown>).productionReadyClaim = 'true';
const directProductionReadyClaimResult = evaluatePinnClaim(directProductionReadyClaim);
assert.equal(directProductionReadyClaimResult.allowed, false, 'direct production readiness field is blocked');
assert.ok(hasReason(directProductionReadyClaimResult, 'claim_boundary_violation'), 'direct production readiness field has boundary reason');

for (const narrativeClaim of [
  '"terminalCompletionClaim": true',
  "'terminalCompletionClaim': true",
  'terminalCompletionClaim = yes',
  `${legacyDoneField}: on`,
  `"${legacyDoneField}": true`,
]) {
  const quotedNarrative = buildCompletePinnEvidence('C9');
  quotedNarrative.narrativeClaim = narrativeClaim;
  const quotedNarrativeResult = evaluatePinnClaim(quotedNarrative);
  assert.equal(quotedNarrativeResult.allowed, false, `quoted/assignment narrative is blocked: ${narrativeClaim}`);
  assert.ok(hasReason(quotedNarrativeResult, 'claim_boundary_violation'), `quoted/assignment narrative has boundary reason: ${narrativeClaim}`);
}

const benchmark = runPinnClaimBenchmark();
assert.equal(benchmark.suiteStatus, 'PASS', 'benchmark suite passes');
assert.equal(benchmark.totalInjections, 15, 'benchmark has B1-B15 injections');
assert.equal(benchmark.a4.rejectedInjectionCount, 15, 'A4 rejects every B1-B15 injection');
for (const injection of PINN_FAILURE_INJECTIONS) {
  assert.ok(benchmark.a4.rejectedInjectionIds.includes(injection.id), `A4 rejects ${injection.id}`);
}
const weakerArms = benchmark.arms.filter((arm) => arm.armId !== 'A4');
assert.ok(weakerArms.some((arm) => arm.unsupportedAcceptanceCount > 0), 'weaker arms expose unsupported acceptance');
assert.ok(weakerArms.some((arm) => arm.staleAcceptanceCount > 0), 'weaker arms expose stale acceptance');
assert.ok(benchmark.a4.rejectionWilson95.low > 0.7, 'A4 Wilson lower bound is reported');
assert.ok(benchmark.a4.meanWallTimeMs > 0, 'benchmark reports wall-time overhead');
assert.ok(benchmark.a4.meanInterventionCount > 0, 'benchmark reports intervention overhead');

const benchmarkText = renderPinnBenchmarkText(benchmark);
const reportText = renderPinnReportText(benchmark);
for (const text of [benchmarkText, reportText]) {
  assert.doesNotMatch(text, /deploymentReadyClaim:\s*true/i, 'text must not claim deployment readiness');
  assert.doesNotMatch(text, /externalCompletionClaim:\s*true/i, 'text must not claim external completion');
  assert.doesNotMatch(text, /terminalCompletionClaim:\s*true/i, 'text must not claim terminal completion');
  assert.doesNotMatch(text, /pdeCorrectnessClaim:\s*true/i, 'text must not claim PDE correctness');
}

const handlers = createPinnClaimAdmissibilityHandlers({} as any);
const handlerCheck = handlers.pinn_claim_check({ injection: 'B10', format: 'json' }) as ReturnType<typeof evaluatePinnClaim>;
assert.equal(handlerCheck.allowed, false, 'handler exposes claim check result');
const handlerMalformedReceipts = handlers.pinn_claim_check({
  evidenceJson: JSON.stringify({ ...buildCompletePinnEvidence('C9'), receipts: { adapterId: 'spec-freeze' } }),
  format: 'json',
}) as ReturnType<typeof evaluatePinnClaim>;
assert.equal(handlerMalformedReceipts.allowed, false, 'handler evidenceJson non-array receipts fail closed');
assert.equal(handlerMalformedReceipts.nextAction, 'stop', 'handler evidenceJson non-array receipts stop deterministically');
assert.ok(hasReason(handlerMalformedReceipts, 'malformed_receipts'), 'handler evidenceJson non-array receipts have explicit reason');
const handlerMissingIdentityEvidence = buildCompletePinnEvidence('C9');
handlerMissingIdentityEvidence.receipts = handlerMissingIdentityEvidence.receipts?.map((receipt) => (
  receipt.adapterId === 'residual' ? { ...receipt, identity: null as any } : receipt
));
const handlerMissingReceiptIdentity = handlers.pinn_claim_check({
  evidenceJson: JSON.stringify(handlerMissingIdentityEvidence),
  format: 'json',
}) as ReturnType<typeof evaluatePinnClaim>;
assert.equal(handlerMissingReceiptIdentity.allowed, false, 'handler evidenceJson malformed receipt identity fails closed');
assert.equal(handlerMissingReceiptIdentity.nextAction, 'stop', 'handler evidenceJson malformed receipt identity stops deterministically');
assert.ok(hasReason(handlerMissingReceiptIdentity, 'malformed_receipt_identity'), 'handler evidenceJson malformed receipt identity has explicit reason');
const handlerBenchmark = handlers.pinn_benchmark_run({ format: 'json' }) as ReturnType<typeof runPinnClaimBenchmark>;
assert.equal(handlerBenchmark.suiteStatus, 'PASS', 'handler exposes benchmark result');
const handlerReport = handlers.pinn_report_render({ format: 'text' }) as string;
assert.match(handlerReport, /artifactIndex:/, 'report command renders artifact index');
const retiredCompletionClaimFields = [
  ['production', 'Done'].join(''),
  ['authority', 'Done'].join(''),
  ['full', 'Authority', 'Done'].join(''),
];
const sanitizedReport = handlers.pinn_report_render({
  benchmarkJson: JSON.stringify({
    ...benchmark,
    deploymentReadyClaim: 'false',
    externalCompletionClaim: 'no',
    terminalCompletionClaim: 'off',
    pdeCorrectnessClaim: 0,
    unexpectedCallerField: 'must be removed',
    injections: [
      {
        ...benchmark.injections[0],
        unexpectedCallerField: 'must be removed',
      },
      ...benchmark.injections.slice(1),
    ],
    arms: [
      {
        ...benchmark.arms[0],
        unexpectedCallerField: 'must be removed',
      },
      ...benchmark.arms.slice(1),
    ],
    a4: {
      ...benchmark.a4,
      unexpectedCallerField: 'must be removed',
    },
    artifactIndex: [
      {
        ...benchmark.artifactIndex[0],
        unexpectedCallerField: 'must be removed',
      },
      ...benchmark.artifactIndex.slice(1),
    ],
    [legacyDoneField]: 'false',
  }),
  format: 'json',
}) as ReturnType<typeof runPinnClaimBenchmark> & Record<string, unknown>;
assert.deepEqual(sanitizedReport.claims, {
  deploymentReadyClaim: false,
  externalCompletionClaim: false,
  terminalCompletionClaim: false,
  pdeCorrectnessClaim: false,
}, 'report JSON sanitizes claim fields');
assert.equal(sanitizedReport.deploymentReadyClaim, undefined, 'report JSON omits caller top-level deployment claim');
assert.equal(sanitizedReport.terminalCompletionClaim, undefined, 'report JSON omits caller top-level terminal claim');
assert.equal(sanitizedReport[legacyDoneField], undefined, 'report JSON omits caller top-level legacy claim');
assert.equal(sanitizedReport.unexpectedCallerField, undefined, 'report JSON omits arbitrary caller fields');
assert.equal((sanitizedReport.injections[0] as any).unexpectedCallerField, undefined, 'report JSON omits arbitrary injection fields');
assert.equal((sanitizedReport.arms[0] as any).unexpectedCallerField, undefined, 'report JSON omits arbitrary arm fields');
assert.equal((sanitizedReport.a4 as any).unexpectedCallerField, undefined, 'report JSON omits arbitrary A4 fields');
assert.equal((sanitizedReport.artifactIndex[0] as any).unexpectedCallerField, undefined, 'report JSON omits arbitrary artifact fields');
assert.throws(
  () => handlers.pinn_report_render({
    benchmarkJson: JSON.stringify({
      ...benchmark,
      deploymentReadyClaim: 'true',
      claims: {
        deploymentReadyClaim: true,
        externalCompletionClaim: true,
        terminalCompletionClaim: true,
        pdeCorrectnessClaim: true,
        ...Object.fromEntries(retiredCompletionClaimFields.map((field) => [field, true])),
      },
      boundary: 'external completion',
    }),
    format: 'json',
  }),
  /refuses benchmark report overclaims/,
  'report command rejects malicious supplied benchmark overclaims',
);
assert.throws(
  () => handlers.pinn_report_render({
    benchmarkJson: JSON.stringify({
      ...benchmark,
      suiteStatus: 'deploymentReadyClaim: true',
      artifactIndex: [
        {
          id: 'terminalCompletionClaim: true',
          kind: 'pinn-report',
          digest: 'sha256:report',
        },
      ],
    }),
    format: 'text',
  }),
  /refuses benchmark report overclaims/,
  'report text command rejects nested supplied benchmark overclaim strings',
);
assert.throws(
  () => handlers.pinn_report_render({
    benchmarkJson: JSON.stringify({
      ...benchmark,
      artifactIndex: [
        {
          ...benchmark.artifactIndex[0],
          digest: '"terminalCompletionClaim": true',
        },
        ...benchmark.artifactIndex.slice(1),
      ],
    }),
    format: 'text',
  }),
  /refuses benchmark report overclaims/,
  'report text command rejects quoted supplied benchmark artifact overclaim strings',
);
assert.throws(
  () => handlers.pinn_report_render({
    benchmarkJson: JSON.stringify({
      ...benchmark,
      suiteStatus: `'${legacyDoneField}': true`,
    }),
    format: 'json',
  }),
  /refuses benchmark report overclaims/,
  'report JSON command rejects quoted supplied benchmark status overclaim strings',
);
assert.throws(
  () => handlers.pinn_report_render({
    benchmarkJson: JSON.stringify({
      ...benchmark,
      injections: [
        {
          ...benchmark.injections[0],
          deploymentReadyClaim: 'true',
        },
        ...benchmark.injections.slice(1),
      ],
    }),
    format: 'json',
  }),
  /refuses benchmark report overclaims/,
  'report JSON command rejects nested supplied benchmark claim fields',
);
const reportTempDir = mkdtempSync(join(tmpdir(), 'pinn-report-'));
try {
  const maliciousBenchmarkPath = join(reportTempDir, 'benchmark.json');
  const productionReadinessBenchmarkPath = join(reportTempDir, 'production-readiness-benchmark.json');
  writeFileSync(maliciousBenchmarkPath, JSON.stringify({
    ...benchmark,
    artifactIndex: [
      {
        ...benchmark.artifactIndex[0],
        digest: 'PDE correctness is proved by supplied report',
      },
      ...benchmark.artifactIndex.slice(1),
    ],
  }));
  assert.throws(
    () => handlers.pinn_report_render({ benchmarkPath: maliciousBenchmarkPath, format: 'text' }),
    /refuses benchmark report overclaims/,
    'report path command rejects nested supplied benchmark narrative overclaims',
  );
  writeFileSync(productionReadinessBenchmarkPath, JSON.stringify({
    ...benchmark,
    artifactIndex: [
      {
        ...benchmark.artifactIndex[0],
        digest: 'Production readiness is proved by supplied report.',
      },
      ...benchmark.artifactIndex.slice(1),
    ],
  }));
  assert.throws(
    () => handlers.pinn_report_render({ benchmarkPath: productionReadinessBenchmarkPath, format: 'text' }),
    /refuses benchmark report overclaims/,
    'report path command rejects nested supplied benchmark production-readiness overclaims',
  );
} finally {
  rmSync(reportTempDir, { recursive: true, force: true });
}
assert.throws(
  () => handlers.pinn_benchmark_run({ deploymentReadyClaim: true } as any),
  /refuses unsupported/,
  'commands reject deployment readiness overclaim flags',
);

console.log('pinn claim-admissibility smoke passed');
