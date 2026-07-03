# B-5118 Plan

Story: Quantum M2: add verifier adapter pack for claim-admissibility receipts

## Scope

Implement only Quantum Milestone 2:

- typed quantum verifier adapter descriptors;
- deterministic adapter-output to `QuantumVerifierReceipt` normalization;
- quantum pack `verifierAdapters` exposure through the read-only pack registry;
- focused smoke coverage and status wording: M0-M2 implemented, M3-M5 pending.

## Non-goals

- No lifecycle gate policy or transition engine changes.
- No benchmark harness or failure-injection runner.
- No reporting/governance integration.
- No quantum hardware, laboratory, physical-validation, solver-improvement,
  production, external completion, or Authority claim.
- No second proof manager, ledger, storage root, or gate stack.

## Implementation Steps

1. Add quantum verifier adapter descriptor types and constants in
   `packages/main/src/core/claim-admissibility/quantum.ts`.
2. Add a deterministic normalizer that converts supported adapter output into a
   receipt or a fail-closed normalization result.
3. Add a quantum ClaimAdmissibilityPack descriptor with `verifierAdapters` and
   register it beside the code-runtime pack without duplicate ids or aliases.
4. Extend `quantum-claim-admissibility-smoke.ts` to prove adapter listing,
   normalization pass, unknown/unsupported adapter failure, mismatch blocking,
   registry exposure, and non-overclaiming status.
5. Update the quantum execution plan status to say M0-M2 implemented and M3-M5
   pending.

## Evidence Plan

- Red baseline: focused smoke currently has no M2 verifier adapter assertions and
  runtime status still says M2-M5 pending.
- Focused green: `npm --prefix packages/main run test:quantum-claim-admissibility`.
- Compatibility green: `npm --prefix packages/main run test:claim-admissibility-pack-framework`.
- Build green: `npm --prefix packages/main run build`.
- Full Lattice validation before TEST/DONE: `lattice validate --story=B-5118 --json`.

## Risk Controls

- If adding quantum pack imports creates a cycle, split literal descriptors so
  `pack-framework.ts` does not import an object that imports pack-framework back.
- If adapter output is missing, unsupported, stale, or mismatched, return a
  non-admissible normalization result and keep `evaluateQuantumClaim` as the
  final admissibility evaluator.
- If wording implies theory/hardware/production/Authority validation, block it
  in smoke and keep boundary booleans false.
