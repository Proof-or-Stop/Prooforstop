#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  QUANTUM_FAILURE_INJECTIONS,
  QUANTUM_RUNTIME_STATUS,
  QUANTUM_SUPPORTED_BENCHMARK_CASES,
  buildInjectedQuantumEvidence,
  buildQuantumClaimReport,
  evaluateQuantumClaimGatePolicy,
  renderQuantumBenchmarkText,
  renderQuantumClaimReportText,
  runQuantumClaimBenchmark,
  type QuantumClaimBenchmarkResult,
  type QuantumClaimGovernanceReport,
  type QuantumFailureInjectionResult,
} from '../core/claim-admissibility/quantum.js';
import { createQuantumClaimAdmissibilityHandlers } from '../handlers/quantum-claim-admissibility.js';

function hasReason(reasons: readonly string[], code: string): boolean {
  return reasons.some((reason) => reason === code || reason.startsWith(`${code}:`));
}

function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

const benchmark = runQuantumClaimBenchmark();
assert.equal(benchmark.schemaVersion, 'lattice.quantum_claim_benchmark.v1', 'benchmark schema version is stable');
assert.equal(benchmark.runtimeStatus, QUANTUM_RUNTIME_STATUS, 'benchmark reports M0-M5 runtime status');
assert.equal(benchmark.suiteStatus, 'PASS', 'benchmark suite passes');
assert.equal(benchmark.supportedCaseTotal, 4, 'benchmark includes A1-A4 supported cases');
assert.equal(benchmark.failureInjectionTotal, 15, 'benchmark includes B1-B15 failure injections');
assert.equal(benchmark.supportedCases.length, QUANTUM_SUPPORTED_BENCHMARK_CASES.length, 'supported case corpus length matches result');
assert.equal(benchmark.failureInjections.length, QUANTUM_FAILURE_INJECTIONS.length, 'failure injection corpus length matches result');

const supportedById = byId(benchmark.supportedCases);
assert.equal(supportedById.get('A1')?.actualDecision, 'advance', 'A1 complete Q5 energy advances');
assert.equal(supportedById.get('A2')?.actualDecision, 'degrade', 'A2 weak Q5 ground-state overclaim degrades');
assert.equal(hasReason(supportedById.get('A2')?.reasons ?? [], 'weak_evidence_overclaim'), true, 'A2 carries weak-evidence overclaim reason');
assert.equal(supportedById.get('A3')?.actualDecision, 'advance', 'A3 complete Q12 provenance advances');
assert.equal(supportedById.get('A4')?.actualDecision, 'degrade', 'A4 Q1 convergence overclaim degrades');
assert.equal(hasReason(supportedById.get('A4')?.reasons ?? [], 'weak_evidence_overclaim'), true, 'A4 carries weak-evidence overclaim reason');
assert.equal(benchmark.supportedCases.every((item) => item.passed), true, 'all supported cases meet exact expected decisions');

const failureById = byId(benchmark.failureInjections) as Map<string, QuantumFailureInjectionResult>;
const expectedFailures: Record<string, { decision: string; reason: string }> = {
  B1: { decision: 'stop', reason: 'stale_evidence' },
  B2: { decision: 'repair', reason: 'missing_required_receipt' },
  B3: { decision: 'stop', reason: 'identity_mismatch' },
  B4: { decision: 'stop', reason: 'receipt_status_not_pass' },
  B5: { decision: 'stop', reason: 'receipt_exit_nonzero' },
  B6: { decision: 'repair', reason: 'missing_core_identity_field' },
  B7: { decision: 'repair', reason: 'missing_basis_or_grid_identity' },
  B8: { decision: 'repair', reason: 'output_digest_missing' },
  B9: { decision: 'stop', reason: 'output_digest_mismatch' },
  B10: { decision: 'stop', reason: 'verifier_script_mismatch' },
  B11: { decision: 'stop', reason: 'duplicate_receipt' },
  B12: { decision: 'stop', reason: 'claim_boundary_violation' },
  B13: { decision: 'escalate', reason: 'unsupported_schema_version' },
  B14: { decision: 'stop', reason: 'unbound_plot_table' },
  B15: { decision: 'stop', reason: 'unknown_claim' },
};
for (const [id, expected] of Object.entries(expectedFailures)) {
  const result = failureById.get(id);
  assert.ok(result, `${id} result is present`);
  assert.equal(result?.actualDecision, expected.decision, `${id} has exact expected decision`);
  assert.equal(result?.advanced, false, `${id} must not advance`);
  assert.equal(result?.reasonCategories.includes(expected.reason as any), true, `${id} includes expected reason category ${expected.reason}`);
  assert.equal(result?.passed, true, `${id} passes exact failure expectation`);

  const direct = evaluateQuantumClaimGatePolicy(buildInjectedQuantumEvidence(id));
  assert.notEqual(direct.decision, 'advance', `${id} direct injected evidence must not advance`);
  assert.equal(hasReason(direct.reasons, expected.reason), true, `${id} direct injected evidence includes ${expected.reason}`);
}

assert.equal(benchmark.metrics.unsupportedAdvanceRate.count, 0, 'no unsupported failure injection advances');
assert.equal(benchmark.metrics.unsupportedAdvanceRate.total, 15, 'unsupported advance rate denominator is B1-B15');
assert.equal(benchmark.metrics.unsupportedAdvanceRate.rate, 0, 'unsupported advance rate is zero');
assert.equal(benchmark.metrics.staleAcceptanceRate.rate, 0, 'stale acceptance rate is zero');
assert.equal(benchmark.metrics.boundaryViolationRate.rate, 0, 'boundary violation advance rate is zero');
assert.equal(benchmark.metrics.falseStopRate.rate, 0, 'supported-case false stop rate is zero');
assert.equal(benchmark.metrics.unsupportedAdvanceRate.wilson95.low, 0, 'deterministic Wilson interval lower bound is stable');
assert.ok(benchmark.metrics.unsupportedAdvanceRate.wilson95.high > 0, 'deterministic Wilson interval upper bound is present');
assert.equal(benchmark.metrics.diagnosticOnly, true, 'benchmark is diagnostic only');
assert.equal(benchmark.metrics.gateEvidence, false, 'benchmark is not gate evidence');
assert.equal(benchmark.metrics.writesLifecycleEvidence, false, 'benchmark writes no lifecycle evidence');
assert.equal(benchmark.metrics.mutatesLifecycle, false, 'benchmark mutates no lifecycle state');
assert.equal(benchmark.claims.quantumTheoryClaim, false, 'benchmark does not claim quantum theory validation');
assert.equal(benchmark.claims.hardwareValidationClaim, false, 'benchmark does not claim hardware validation');
assert.equal(benchmark.claims.solverImprovementClaim, false, 'benchmark does not claim solver improvement');
assert.equal(benchmark.claims.productionClaim, false, 'benchmark does not claim production readiness');
assert.equal(benchmark.claims.authorityClaim, false, 'benchmark does not claim Authority');

const benchmarkText = renderQuantumBenchmarkText(benchmark);
assert.match(benchmarkText, /local diagnostic M0-M5 implemented/, 'benchmark text reports M0-M5 status');
assert.match(benchmarkText, /unsupportedAdvanceRate: 0\.000/, 'benchmark text reports unsupported advance rate');
assert.match(benchmarkText, /gateEvidence: false/, 'benchmark text reports non-evidence boundary');
assert.match(benchmarkText, /B15: class=fail-closed/, 'benchmark text lists B15');

const report = buildQuantumClaimReport(benchmark);
assert.equal(report.schemaVersion, 'lattice.quantum_claim_report.v1', 'report schema version is stable');
assert.equal(report.suiteStatus, 'PASS', 'report preserves benchmark PASS status');
assert.equal(report.diagnosticOnly, true, 'report is diagnostic only');
assert.equal(report.gateEvidence, false, 'report is not gate evidence');
assert.equal(report.writesLifecycleEvidence, false, 'report writes no lifecycle evidence');
assert.equal(report.mutatesLifecycle, false, 'report mutates no lifecycle state');
assert.equal(report.benchmarkSummary.supportedCasesPassed, 4, 'report summarizes supported cases');
assert.equal(report.benchmarkSummary.failureInjectionsBlocked, 15, 'report summarizes blocked injections');
assert.equal(report.benchmarkSummary.unsupportedAdvanceRate, 0, 'report summarizes unsupported advance rate');
assert.equal(report.claims.quantumTheoryClaim, false, 'report does not claim quantum theory validation');
assert.equal(report.claims.hardwareValidationClaim, false, 'report does not claim hardware validation');
assert.equal(report.claims.solverImprovementClaim, false, 'report does not claim solver improvement');
assert.equal(report.claims.productionClaim, false, 'report does not claim production readiness');
assert.equal(report.claims.authorityClaim, false, 'report does not claim Authority');
assert.ok(
  report.limitations.some((limitation) => limitation.includes('Generic claim-admissibility framework gate-adapter and lifecycle integration remain future work')),
  'report limitations keep generic lifecycle integration out of scope',
);
const reportText = renderQuantumClaimReportText(report);
assert.match(reportText, /Quantum claim governance report/, 'report text has governance heading');
assert.match(reportText, /failureInjectionsBlocked: 15\/15/, 'report text summarizes B1-B15 blocking');
assert.match(reportText, /productionClaim: false/, 'report text keeps production claim false');
assert.match(reportText, /authorityClaim: false/, 'report text keeps Authority claim false');

const handlers = createQuantumClaimAdmissibilityHandlers({} as any);
const handlerBenchmark = handlers.quantum_claim_benchmark({ format: 'json' }) as QuantumClaimBenchmarkResult;
assert.equal(handlerBenchmark.suiteStatus, 'PASS', 'handler benchmark JSON passes');
const handlerBenchmarkText = handlers.quantum_claim_benchmark({}) as string;
assert.match(handlerBenchmarkText, /Quantum claim benchmark/, 'handler benchmark text renders');
const handlerReport = handlers.quantum_claim_report({ format: 'json' }) as QuantumClaimGovernanceReport;
assert.equal(handlerReport.benchmarkSummary.failureInjectionsBlocked, 15, 'handler report JSON summarizes B1-B15');
const handlerReportText = handlers.quantum_claim_report({}) as string;
assert.match(handlerReportText, /Quantum claim governance report/, 'handler report text renders');

for (const command of ['quantum_claim_check', 'quantum_claim_benchmark', 'quantum_claim_report'] as const) {
  assert.throws(
    () => handlers[command]({ productionClaim: true } as any),
    /refuses unsupported/,
    `${command} rejects production overclaim flag`,
  );
  assert.throws(
    () => handlers[command]({ authorityClaim: true } as any),
    /refuses unsupported/,
    `${command} rejects Authority overclaim flag`,
  );
  assert.throws(
    () => handlers[command]({ runCommands: true } as any),
    /refuses unsupported/,
    `${command} rejects execution side-effect flag`,
  );
}

console.log('quantum claim benchmark smoke passed');
