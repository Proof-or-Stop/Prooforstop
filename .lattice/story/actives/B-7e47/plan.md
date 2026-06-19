# Plan: B-7e47 Authority DONE material overlap audit

## Goal

Fix the Lattice CLI correctness gap where DONE/enforce Authority gate requests omit `decision.materialOverlapAudit`, causing staging DONE preflight to fail with `materialOverlapAudit.present=false`.

## Constraints

- Keep the contract on `POST /v1/gates/evaluate`.
- Do not add `/v1/checks` or `/v1/commands` material-overlap submission paths.
- Include the audit before signing the envelope.
- Preserve non-empty `actualFileOverlaps`; do not normalize real overlaps away.
- Keep receipt verification and lifecycle gate consumption semantics unchanged.

## CHK-001

Add material-overlap audit to Authority gate request contracts.

Files:

- Modify: `packages/main/src/core/authority-contracts.ts`
- Modify if needed: `packages/main/src/core/planned-steps-executor.ts`
- Test: existing Authority contract or smoke tests discovered in DEV

Steps:

1. Add `MaterialOverlapAuditContract` with `changedFiles: string[]` and `actualFileOverlaps: string[]`.
2. Add optional `materialOverlapAudit` to `GateEvaluateRequestContract`.
3. Add the matching zod schema to `GateEvaluateRequestContractSchema`.
4. Add the field to `AuthorityGateInput` only if it is needed to carry the value through the planned-steps path.

Verify:

- Schema accepts a valid audit object.
- Schema rejects malformed field types if tests cover schema validation.

## CHK-002

Include material-overlap audit in signed DONE gate envelopes.

Files:

- Modify: `packages/main/src/core/authority-client.ts`
- Test: existing Authority client tests or a targeted smoke/unit test

Steps:

1. Update `buildGateEvaluateEnvelope(...)` so `decision.materialOverlapAudit` is included before `signHexEnvelope(...)`.
2. Include the field only when present on the request; do not invent a pass value for callers that did not provide one unless the caller path explicitly owns the no-overlap smoke default.
3. Preserve non-empty `actualFileOverlaps` exactly.

Verify:

- A request with `actualFileOverlaps: []` produces a signed decision containing the empty audit.
- A request with `actualFileOverlaps: [\"x\"]` still contains `[\"x\"]` in the decision.

## CHK-003

Update live Python E2E smoke DONE preflight.

Files:

- Modify: `packages/main/src/tasks/authority-live-python-e2e-smoke.ts`
- Generated build output: `packages/main/dist/tasks/authority-live-python-e2e-smoke.js`

Steps:

1. Add the minimal no-overlap audit to `signedGateRequest(...)` for the DONE preflight path.
2. Keep the audit inside `decision` before signing.
3. Do not read or print secret material while running the smoke.

Verify:

- The constructed smoke request contains `decision.materialOverlapAudit.changedFiles=[]` and `decision.materialOverlapAudit.actualFileOverlaps=[]`.
- Staging DONE preflight no longer fails with `present=false` when live credentials are available.

## CHK-004

Add regression coverage and rebuild CLI.

Files:

- Modify/create targeted tests under the existing test layout discovered in DEV.
- Generated build output under `packages/main/dist`.
- Modify `package.json` / `package-lock.json` only if version discipline requires it after behavior change.

Steps:

1. Add or extend tests covering contract schema acceptance.
2. Add or extend tests covering signed envelope inclusion and non-empty overlap preservation.
3. Add or extend tests covering the live smoke request shape without contacting staging.
4. Run `npm --prefix packages/main run build`.

Verify:

- Targeted tests pass.
- Build succeeds and dist reflects source changes.

## CHK-005

Run targeted validation and record evidence.

Files:

- No additional source changes expected unless validation exposes a real correctness issue.

Steps:

1. Run targeted unit/smoke tests for the modified files.
2. Run build.
3. Attempt the staging live smoke only if the existing environment has safe credentials available; do not inspect local senior secret files just to force the run.
4. Record evidence for each checklist item through Lattice verificationEvidence.

Verify:

- Terminal evidence shows the targeted tests/build result.
- If live smoke runs, it reaches the DONE preflight with `materialOverlapAudit.present=true` and no longer reports the missing-audit reason.
- If live smoke cannot run due credentials/environment, classify the blocker explicitly without claiming production DONE.
