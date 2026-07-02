# Plan: B-7b4e Quantum M0-M1 Claim Admissibility

## CHK-001 Register the Quantum plan as the story source of truth

Goal: carry the Quantum execution plan into the story worktree and keep its delivery status explicit. This story only completes the first runtime slice: M0-M1 schema, identity binding, and deterministic rejection.

Steps:

1. Add `docs/requirements/decisions/proof-or-stop-quantum-claim-admissibility-execution-plan.md` to this worktree if it is missing from the baseline.
2. Preserve the plan boundary: no quantum theory validation, no hardware or wet-lab validation, no solver improvement claim, no broad scientific correctness claim, no production or Authority claim.
3. Keep the delivery status axis clear: M2 verifier adapters, M3 gate engine, M4 benchmark harness, and M5 reporting/governance remain future implementation stories.

Verification:

- Read the document status and boundary sections.
- Ensure text never states that full Quantum runtime, benchmark execution, or scientific validation is complete.

## CHK-002 Implement Quantum claim and evidence schema primitives

Goal: add a small, typed runtime module for Quantum claim/evidence receipts. The module should model Q1-Q12 claim IDs, core identity fields, conditional identity fields, claim-specific requirements, and result reason codes.

Steps:

1. Create `packages/main/src/core/claim-admissibility/quantum.ts`.
2. Define schema/verifier versions, claim IDs, core identity fields, conditional identity fields, and claim requirement metadata.
3. Implement a validation entrypoint that accepts a claim, active claim state, and evidence receipt, then returns an allowed flag, next action, reason codes, scoped allowed claim text, and boundary booleans that remain false for scientific/hardware/solver/production claims.
4. Require core identity fields for all evidence and conditional fields only when the claim type needs them.

Verification:

- Valid Hamiltonian-bound evidence passes.
- Deterministic static evidence is not forced to include seed or timestep unless the claim requires it.
- Unknown claim IDs or missing core fields fail with stable reason codes.

## CHK-003 Implement deterministic stale/missing/mismatched binding checks

Goal: fail closed when evidence identity does not match the active Quantum claim state.

Steps:

1. Compare every applicable identity field between active claim state and evidence identity.
2. Report stable reason codes for missing active identity, missing evidence identity, mismatch, stale evidence, failed receipt status, and duplicate/malformed evidence.
3. Add explicit handling for unbound solver output and unbound plot/table provenance.
4. Add weak-evidence behavior so a single solver run can support a scoped result under configuration X but not a stronger ground-state/convergence/advantage claim.

Verification:

- Hamiltonian mismatch blocks.
- Grid mismatch blocks where grid is applicable.
- verifierScriptHash mismatch blocks.
- Unbound solver output blocks.
- Unbound plot/table blocks.
- Weak single-run energy evidence is degraded or stopped rather than upgraded.

## CHK-004 Add focused smoke coverage for the M0-M1 Quantum slice

Goal: add a single local smoke command proving the narrow runtime slice behaves as intended.

Steps:

1. Create `packages/main/src/tasks/quantum-claim-admissibility-smoke.ts`.
2. Add `test:quantum-claim-admissibility` to `packages/main/package.json`.
3. Cover passing fixtures, missing-field fixtures, mismatch fixtures, unbound solver output, unbound plot/table provenance, deterministic optional-field behavior, and weak-evidence non-upgrade behavior.
4. Run build/typecheck as needed and run the smoke from built dist.

Verification:

- `npm --prefix packages/main run build` succeeds.
- `npm --prefix packages/main run test:quantum-claim-admissibility` prints `quantum claim-admissibility smoke passed`.
- The smoke contains negative controls for the adversarial verification intents.

## Rollback / stop policy

If schema scope starts to require M2 verifier adapters, M3 lifecycle gates, or M4 benchmark execution, stop and split a new story. If tests require broad command-surface registration, keep it out unless the user explicitly expands scope. If the implementation needs to claim scientific correctness, hardware validation, solver improvement, production completion, or Authority completion, stop because that contradicts the frozen scope.
