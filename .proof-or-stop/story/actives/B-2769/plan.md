## CHK-001 Scope and policy lock

### Why
Pin the claim-admissibility boundary to avoid future drift and overclaim.

### Scope and constraints
- Implement only Proof-or-Stop claim-admissibility control for PINN research workflows.
- Exclude PDE correctness claims, scientific performance claims, wet-lab, or Authority/production-readiness claims.

### Deliverables
- Finalized scope boundary contract in story evidence.
- Baseline fairness contract used by benchmark.
- Plan-level non-goals and explicit exclusions.

### Success criteria
- Scope boundary and execution boundary artifacts are persisted for INIT_CHECK/DOC.
- All excluded items are documented and cannot be interpreted as in-scope.

## CHK-002 Claim/evidence schema

### Why
Create machine-readable claim/evidence identity for PINN lifecycle transitions.

### Deliverables
- PINN claim/evidence schema artifacts (JSON/TS) and loader/validator.
- Explicit identity fields (pdeSpecHash, domainHash, boundaryConditionHash, initialConditionHash, collocationPointHash, evaluationGridHash, trainingConfigHash, randomSeed, checkpointHash, codeHash, verifierScriptHash, environmentHash, outputDigest).

### Success criteria
- Missing/mismatched/stale identity fields fail transition checks.
- Validator can produce deterministic PASS/BLOCK reasons.

## CHK-003 Verifier adapter pack

### Why
Add deterministic adapters so evidence is reproducible and command-set bound.

### Deliverables
- Residual verifier adapter.
- BC/IC verifier adapter.
- Baseline reproducibility verifier adapter.
- Figure/table provenance verifier adapter.
- Standardized evidence JSON output per adapter.

### Success criteria
- Each adapter returns machine-readable output and fails closed on missing/bad input.
- Evidence includes command script hash, config hash and run-time metadata.

## CHK-004 Gate policy and transition engine

### Why
Fail-closed transitions prevent unsupported claims from escalating.

### Deliverables
- Gate state transitions: Spec → Training → Residual → BC/IC → Out-of-sample → Baseline → Reproducibility → Result.
- Transition predicates for each edge.
- explicit failure actions: advance / repair / degrade / stop.

### Success criteria
- No transition from required state can be completed without all required evidence.
- Gate logs include explicit BLOCK reason codes.

## CHK-005 Benchmark harness

### Why
Demonstrate control-regime effect (not PDE performance) with comparable experiments.

### Deliverables
- A1/A2/A3/A4 harness runner using fixed task set and fixed training/eval settings.
- B1-B15 failure injection definitions.
- Deterministic report format with unsupported-advance/stale-acceptance/violation metrics.

### Success criteria
- M1-M5 artifacts produce reproducible output rows.
- A4 report is compared against A1/A2/A3 with identical task settings.
- CI-friendly command script for harness run is documented.

## CHK-006 Reporting and governance integration

### Why
Keep claim boundaries and user-facing language consistent and safe.

### Deliverables
- Update or add decision doc(s) with final boundary paragraph.
- Add clear `claim controls` wording to governance docs and source-of-truth navigation.
- Add success-criteria reporting fields and report examples.

### Success criteria
- No document language implies PDE solving/correctness.
- Public-facing boundary statements are explicit and bounded.
