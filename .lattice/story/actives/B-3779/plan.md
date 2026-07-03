# Plan: B-3779 Complete Quantum M4-M5 Benchmark Harness And Governance Report

## CHK-001: M4 deterministic benchmark harness

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/claim-admissibility/quantum.ts
- Modify: packages/main/src/handlers/quantum-claim-admissibility.ts
- Modify: packages/main/src/cli/command-catalog.ts
- Modify: packages/main/src/core/command-policy.ts
- Modify: packages/main/src/core/config.ts
- Modify: packages/main/src/registry.ts
- Modify: packages/main/src/tasks/command-catalog-smoke.ts
- Modify: packages/main/package.json
- Create: packages/main/src/tasks/quantum-claim-benchmark-smoke.ts

**Supported Cases A1-A4**:
- A1 complete scoped Q5 energy evidence -> expected decision `advance`.
- A2 weak Q5 evidence asked for ground-state strength -> expected decision `degrade`.
- A3 complete Q12 figure/table provenance evidence -> expected decision `advance`.
- A4 complete Q1 freeze evidence asked for convergence strength -> expected decision `degrade`.

**Failure Injections B1-B15**:
- B1 hamiltonian changed while old eigenvalue reused -> `stop` with identity mismatch.
- B2 potential changed while old wavefunction/evidence reused -> `stop` with identity mismatch.
- B3 boundary condition changed while old report reused -> `stop` with identity mismatch.
- B4 basis/grid changed while old convergence report reused -> `stop` with identity mismatch.
- B5 timestep changed while old unitarity report reused -> `stop` with identity mismatch.
- B6 wavefunction not normalized -> `stop` with receipt status failure.
- B7 energy residual above threshold -> `stop` with receipt status failure.
- B8 symmetry or invariant violated -> `stop` with receipt status failure.
- B9 reference comparison uses different units -> `stop` with metric/reference mismatch.
- B10 baseline uses different grid/basis resolution -> `stop` with identity mismatch.
- B11 solver config changed after checkpoint -> `stop` with identity mismatch.
- B12 verifier threshold silently changed -> `stop` with verifier script mismatch.
- B13 figure generated from stale run -> `stop` with stale evidence.
- B14 random seed/config missing for stochastic method -> `repair` with missing randomSeed.
- B15 manually edited table/plot -> `stop` with output digest mismatch.

**Verify**:
- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:quantum-claim-benchmark`
- `node packages/main/dist/cli.js --root /Users/jek/Documents/Work/proofbound/.worktrees/B-3779 quantum_claim_benchmark --json` prints `diagnosticOnly=true`, `gateEvidence=false`, `unsupportedAdvanceRate=0`, and all B1-B15 rows blocked or degraded as expected.

**DoneWhen**:
- Benchmark result includes exactly 4 supported cases and 15 failure-injection cases.
- Every row records expected decision, actual decision, pass/fail, and required reason coverage.
- Metrics include unsupportedAdvanceRate, staleAcceptanceRate, boundaryViolationRate, falseStopRate, and deterministic confidence intervals.
- The command remains read-only and cannot write lifecycle evidence or mutate Story state.

## CHK-002: M5 governance report output

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/claim-admissibility/quantum.ts
- Modify: packages/main/src/handlers/quantum-claim-admissibility.ts
- Modify: packages/main/src/cli/command-catalog.ts
- Modify: packages/main/src/core/command-policy.ts
- Modify: packages/main/src/core/config.ts
- Modify: packages/main/src/registry.ts
- Test: packages/main/src/tasks/quantum-claim-benchmark-smoke.ts

**Verify**:
- `npm --prefix packages/main run test:quantum-claim-benchmark`
- `node packages/main/dist/cli.js --root /Users/jek/Documents/Work/proofbound/.worktrees/B-3779 quantum_claim_report` prints a bounded governance report.
- `node packages/main/dist/cli.js --root /Users/jek/Documents/Work/proofbound/.worktrees/B-3779 quantum_claim_report --json` prints JSON with `diagnosticOnly=true`, `gateEvidence=false`, and all boundary booleans false.

**DoneWhen**:
- The report summarizes benchmark totals, rates, pass/fail status, limitations, and ready-to-quote boundary wording.
- The report explicitly states it is diagnostic-only, not gate evidence, and not production, Authority, hardware, theory, physical-validation, solver-improvement, or broad quantum-advantage proof.
- The report can render from a fresh local benchmark result without reading or writing external files.

**Promise**: `quantum_claim_report` renders a reviewer-readable summary that says Quantum local diagnostic M0-M5 are implemented and that M4-M5 remain non-gate, diagnostic proof of control behavior only.

## CHK-003: Docs and runtime status updated

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: docs/requirements/decisions/proof-or-stop-quantum-claim-admissibility-execution-plan.md
- Modify: docs/requirements/decisions/claim-admissibility-adapter-pack-framework.md
- Modify: packages/main/src/core/claim-admissibility/quantum.ts
- Modify: packages/main/src/tasks/quantum-claim-admissibility-smoke.ts
- Modify: packages/main/src/tasks/command-catalog-smoke.ts
- Test: packages/main/src/tasks/quantum-claim-admissibility-smoke.ts
- Test: packages/main/src/tasks/quantum-claim-benchmark-smoke.ts

**Verify**:
- `npm --prefix packages/main run test:quantum-claim-admissibility`
- `npm --prefix packages/main run test:quantum-claim-benchmark`
- `npm --prefix packages/main run test:command-catalog-smoke`
- `rg -n "M0-M5 implemented|A1|B1|quantum_claim_benchmark|quantum_claim_report|diagnostic-only|generic framework" docs/requirements/decisions/proof-or-stop-quantum-claim-admissibility-execution-plan.md docs/requirements/decisions/claim-admissibility-adapter-pack-framework.md`

**DoneWhen**:
- Quantum runtime status says local diagnostic M0-M5 are implemented.
- Docs define A1-A4 and B1-B15 benchmark scope and say benchmark/report outputs are diagnostic-only.
- Docs distinguish local Quantum M4-M5 completion from generic framework lifecycle gate-policy adapter completion.
- Docs retain explicit no-theory, no-hardware, no-solver-improvement, no-production, no-Authority, and no-second-proof-system boundaries.

**Promise**: The docs tell hosts exactly what changed, how to run the benchmark/report, and what claims remain out of scope.
