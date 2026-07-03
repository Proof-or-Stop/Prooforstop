# B-3779 User-Value Transcript Diff

Date: 2026-07-03
Story: B-3779 - Complete Quantum M4-M5 benchmark harness and governance report

## Expected Outcome

From the story plan and checklist, a user-facing run of the Quantum claim-admissibility slice should show:

- Quantum local diagnostic M0-M5 is implemented.
- The governance report is diagnostic-only and not gate evidence.
- A1-A4 supported cases pass as expected.
- B1-B15 documented quantum-domain failure injections do not advance unsupported claims.
- No Authority, production, hardware, laboratory, quantum-theory, external-solver, solver-improvement, or broad scientific correctness claim is emitted.

## Commands Run

```bash
node packages/main/dist/cli.js --root "$PWD" quantum_claim_report
node packages/main/dist/cli.js --root "$PWD" quantum_claim_report --json
node packages/main/dist/cli.js --root "$PWD" quantum_claim_benchmark --json
```

## Actual Output Summary

`quantum_claim_report` printed:

```text
Quantum claim governance report (lattice.quantum_claim_report.v1)
Quantum claim-admissibility runtime status: local diagnostic M0-M5 implemented.
suiteStatus: PASS
diagnosticOnly: true
gateEvidence: false
writesLifecycleEvidence: false
mutatesLifecycle: false
supportedCasesPassed: 4/4
failureInjectionsBlocked: 15/15
unsupportedAdvanceRate: 0.000
staleAcceptanceRate: 0.000
boundaryViolationRate: 0.000
falseStopRate: 0.000
quantumTheoryClaim: false
physicalValidationClaim: false
hardwareValidationClaim: false
solverImprovementClaim: false
productionClaim: false
authorityClaim: false
```

`quantum_claim_report --json` reported:

- `schemaVersion`: `lattice.quantum_claim_report.v1`
- `suiteStatus`: `PASS`
- `diagnosticOnly`: `true`
- `gateEvidence`: `false`
- `writesLifecycleEvidence`: `false`
- `mutatesLifecycle`: `false`
- `benchmarkSummary.supportedCasesPassed`: `4`
- `benchmarkSummary.supportedCaseTotal`: `4`
- `benchmarkSummary.failureInjectionsBlocked`: `15`
- `benchmarkSummary.failureInjectionTotal`: `15`
- all boundary claim booleans false.

`quantum_claim_benchmark --json` reported:

- `schemaVersion`: `lattice.quantum_claim_benchmark.v1`
- `suiteStatus`: `PASS`
- `supportedCaseTotal`: `4`
- `failureInjectionTotal`: `15`
- A1-A4 all `passed: true`
- B1-B15 all `passed: true`
- B1-B15 all had `advanced: false`
- `metrics.unsupportedAdvanceRate.count`: `0`
- `metrics.unsupportedAdvanceRate.total`: `15`
- `metrics.unsupportedAdvanceRate.rate`: `0`

## B1-B15 Domain Injection Coverage

The runtime benchmark output covered the documented domain scenarios:

- B1: Hamiltonian changed while old Q5 eigenvalue is reused.
- B2: Potential changed while old Q5 wavefunction/evidence is reused.
- B3: Boundary condition changed while old Q5 report is reused.
- B4: Basis/grid changed while old Q9 convergence report is reused.
- B5: Timestep changed while old Q7 unitarity report is reused.
- B6: Normalization failure for unnormalized Q6 wavefunction.
- B7: Energy residual above threshold in Q5 receipt.
- B8: Symmetry/invariant violated in Q8 receipt.
- B9: Reference comparison metric/reference units mismatch in Q10 receipt.
- B10: Baseline grid/basis resolution mismatch in Q10 receipt.
- B11: Solver config changed after checkpoint in Q4 solver run.
- B12: Verifier threshold silently changed in Q5 energy receipt.
- B13: Stale figure generated from old Q12 run.
- B14: Random seed missing for stochastic Q5 method.
- B15: Manually edited table/plot changes Q12 output digest.

## Diff Notes

- Expected M0-M5 local diagnostic status: matched actual output.
- Expected diagnostic-only, non-gate report: matched actual output.
- Expected A1-A4 supported cases to pass: matched actual output.
- Expected B1-B15 failure injections to stop/repair/degrade without advancing unsupported claims: matched actual output.
- Expected no overclaim booleans: matched actual output.
- Unexpected output: none.

## Acceptance Result

PASS. The real-machine CLI transcript matches the story's expected user value for the local Quantum claim-admissibility benchmark/report slice.
