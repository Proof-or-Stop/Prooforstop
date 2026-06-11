# B-c886 Engineering Baseline Unlock Contract Plan

## Purpose
Implement only the correctness alignment required by the audited Layer 2 Engineering Baseline unlock plan. The work must preserve fail-closed behavior and must not add a new capability layer, arbitrary optimization, or production-grade claim.

## Shared Constraints
- Do not optimize for the sake of optimization.
- Do not optimize arbitrarily.
- Only fix real correctness issues found between the audited plan and current machine contracts.
- Preserve consistency of logic across baseline runner, suite aggregation, claim evaluation, and smoke evidence.
- Two-host Claude/Codex audit evidence is advisory audit material, not formal proof by itself.

## CHK-001
Align the Engineering expected-block final-report contract.

Implementation:
- Add machine-readable expected-block evidence fields to baseline final reports only where the suite needs them.
- Treat valid EXPECTED_BLOCK safety refusals as expected baseline outcomes when the baseline definition allows EXPECTED_BLOCK.
- Reject EXPECTED_BLOCK reports that hide refusal semantics only in generic blockedReasons or omit required expected-block evidence.

Verification:
- Run `npm run build`.
- Run `npm --prefix packages/main run test:lattice-baseline-smoke`.
- Confirm smoke coverage shows accepted EXPECTED_BLOCK reports do not create suite-level blockers.

## CHK-002
Allow gated PASS for risky Engineering baselines only with proof.

Implementation:
- Keep ENG-DATA-MIGRATION-1 and ENG-AUTH-SECURITY-1 defaulting to EXPECTED_BLOCK.
- Permit PASS only when explicit gate evidence refs are present.
- Fail closed when gate evidence is missing, empty, stale, or fake.

Verification:
- Run `npm run build`.
- Run `npm --prefix packages/main run test:lattice-baseline-smoke`.
- Confirm risky PASS reports without gate evidence are rejected or block authorization.

## CHK-003
Harden Development lower-layer proof validation for Engineering claims.

Implementation:
- Ensure Engineering claim authorization depends on fresh, coherent, non-local Development suite proof.
- Preserve `target=engineering` mapping to `CLAIM-ENGINEERING-DEV`.
- Keep Loop, Production Safety, and higher claims locked unless their own lower-layer proofs exist.

Verification:
- Run `npm run build`.
- Run `npm --prefix packages/main run test:lattice-baseline-smoke`.
- Confirm stale, local-only, false-DONE, schema-mismatched, or incoherent Development proof blocks Engineering authorization.

## CHK-004
Expose focused smoke proof for the Engineering unlock contract.

Implementation:
- Extend the existing focused smoke task rather than introducing a new framework.
- Name the contract checks so output and failures map back to expected-block, gated PASS, stale lower-layer proof, and Engineering claim mapping.

Verification:
- Run `npm run build`.
- Run `npm --prefix packages/main run test:lattice-baseline-smoke`.
- Confirm the smoke exits 0 only when all required contract checks execute.

## CHK-005
Expose two-host audit verdicts for the implemented contract.

Implementation:
- Run Claude CLI and Codex CLI reviews against the current diff or current HEAD/material hash after implementation and smoke verification.
- Save verdict transcripts under `.omx/artifacts/` as audit-only evidence.
- Do not treat host verdicts as Authority proof or production-grade authorization.

Verification:
- Confirm both artifacts reference the current implementation state.
- Record checklist verificationEvidence with audit-only wording.
- If a host is unavailable, record that as unavailable/blocked audit evidence and do not count it as a two-host pass.

## Rollback
If implementation changes cause unrelated baseline/claim behavior to fail, revert only the scoped code changes for this story and leave previous documentation/audit artifacts intact for traceability.
