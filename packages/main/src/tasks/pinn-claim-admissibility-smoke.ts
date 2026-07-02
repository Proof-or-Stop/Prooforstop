import assert from 'node:assert/strict';
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
assert.equal(complete.productionDone, false, 'complete check never claims productionDone');
assert.equal(complete.authorityDone, false, 'complete check never claims authorityDone');
assert.equal(complete.fullAuthorityDone, false, 'complete check never claims fullAuthorityDone');
assert.equal(complete.pdeCorrectnessClaim, false, 'complete check never claims PDE correctness');
assert.equal(complete.checkedAdapters.length, 9, 'C9 checks all adapter families');

assertBlocks('B1', 'missing_identity_field');
assertBlocks('B2', 'identity_mismatch');
assertBlocks('B3', 'missing_required_receipt');
assertBlocks('B4', 'receipt_exit_nonzero');
assertBlocks('B5', 'receipt_status_not_pass');
assertBlocks('B6', 'verifier_script_mismatch');
assertBlocks('B7', 'output_digest_missing');
assertBlocks('B8', 'stale_evidence');
assertBlocks('B9', 'claim_boundary_violation');
assertBlocks('B10', 'claim_boundary_violation');
assertBlocks('B11', 'missing_required_receipt');
assertBlocks('B12', 'missing_required_receipt');
assertBlocks('B13', 'identity_mismatch');
assertBlocks('B14', 'missing_required_receipt');
assertBlocks('B15', 'receipt_status_not_pass');

const lowLoss = buildCompletePinnEvidence('C9');
lowLoss.trainingLossLow = true;
lowLoss.receipts = lowLoss.receipts?.filter((receipt) => receipt.adapterId === 'spec-freeze' || receipt.adapterId === 'training');
const lowLossResult = evaluatePinnClaim(lowLoss);
assert.equal(lowLossResult.allowed, false, 'low training loss alone cannot satisfy result-strength claims');
assert.ok(hasReason(lowLossResult, 'training_loss_not_solution_evidence'), 'low-loss-only path has explicit reason');

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
  assert.doesNotMatch(text, /productionDone:\s*true/i, 'text must not claim production done');
  assert.doesNotMatch(text, /authorityDone:\s*true/i, 'text must not claim authority done');
  assert.doesNotMatch(text, /fullAuthorityDone:\s*true/i, 'text must not claim full authority done');
  assert.doesNotMatch(text, /pdeCorrectnessClaim:\s*true/i, 'text must not claim PDE correctness');
}

const handlers = createPinnClaimAdmissibilityHandlers({} as any);
const handlerCheck = handlers.pinn_claim_check({ injection: 'B10', format: 'json' }) as ReturnType<typeof evaluatePinnClaim>;
assert.equal(handlerCheck.allowed, false, 'handler exposes claim check result');
const handlerBenchmark = handlers.pinn_benchmark_run({ format: 'json' }) as ReturnType<typeof runPinnClaimBenchmark>;
assert.equal(handlerBenchmark.suiteStatus, 'PASS', 'handler exposes benchmark result');
const handlerReport = handlers.pinn_report_render({ format: 'text' }) as string;
assert.match(handlerReport, /artifactIndex:/, 'report command renders artifact index');
assert.throws(
  () => handlers.pinn_benchmark_run({ productionDone: true } as any),
  /refuses unsupported/,
  'commands reject productionDone overclaim flags',
);

console.log('pinn claim-admissibility smoke passed');
