# B-ac25 Implementation Plan

## Execution Boundary

Do:
- Add an opt-in `doneRequiredCommands` policy surface.
- Add a separate `done-required-evidence.json` artifact.
- Add `done_required_validate` as the explicit command that runs required DONE validation.
- Add a `done-required-validation` DONE oracle row.
- Configure this self-host repository to require package build before root full-suite validation.
- Add process-fact and smoke coverage.

Do not:
- Do not append root `npm test` to ordinary `validate.commands`.
- Do not force external projects into blocking full-suite validation by default.
- Do not change `.githooks/pre-push`, `release_approve_push`, Authority receipt, Layer4, or customerKeyRef behavior.
- Do not implement emergency override behavior in this story.

STOP if:
- Required evidence cannot be bound to current head/material/story/policy identity.
- External projects would become blocking without explicit policy.
- The implementation path collapses routine validate and DONE-required validate into one claim.
- Review cannot satisfy 3 rounds x 2 hosts over final material.

## CHK-001

Add config normalization for a top-level `doneRequiredCommands` array. Reuse the existing validation command shape where possible: label, command, args, cwd, env, shell, optional, timeoutMs. Keep ordinary `validate.commands` untouched. Missing `doneRequiredCommands` means no required policy and should be advisory downstream. Malformed opted-in required entries must fail closed with a precise error.

Implementation notes:
- Put reusable policy parsing in a new core module, likely `core/done-required-validation.ts`.
- Avoid changing the semantics of `configuredValidationCommands`.
- Command-set identity should be canonical and stable enough for freshness checks.

## CHK-002

Implement `done_required_validate` as a story-scoped command that executes the required policy and writes `done-required-evidence.json`. Use existing validation execution primitives where possible so timeout/output behavior stays consistent. Evidence should record status, timestamps, headHash, materialHash, storyFilesHash, policyHash, commandSetHash, and per-command receipts with bounded output and outputDigest.

Implementation notes:
- Overall PASS only when all required commands pass and self-host build proof is satisfied.
- FAIL artifacts should still be written when execution fails after policy resolution.
- For self-host, root `npm test` requires a preceding same-material `packages/main` build receipt or equivalent proof.

## CHK-003

Add a `done-required-validation` row to `buildDoneChecklist`. Required policy behavior: missing artifact, FAIL artifact, stale head/material/story files, stale policy/command-set, or missing build proof blocks DONE. No policy behavior: advisory/non-blocking row that says no DONE-required policy is configured and no full-suite claim is made.

Implementation notes:
- Keep the existing `test-evidence` row intact.
- Use the same metadataRoot/gitCwd split discipline as existing freshness checks.
- Provide a direct hint: run `lattice done_required_validate --storyId=<id>`.

## CHK-004

Register the new gate fact in process-fact registry, levels, command policy, and contract verifier. The command and artifact are L4 local gate evidence consumed by DONE. They must not claim Authority completion, productionDone, fullAuthorityDone, release approval, or remote receipt semantics.

Implementation notes:
- Add artifact registration for `done-required-evidence.json`.
- Add command registration for `done_required_validate`.
- Add verifier assertions that fail if the command/artifact/row disappears.

## CHK-006

Add a dedicated smoke test task for DONE-required validation. The smoke should use temporary projects/fake commands to stay fast, and should test the exact gap: ordinary validation can pass while DONE-required evidence is missing/failing/stale and DONE remains blocked under required policy.

Required cases:
- Required policy PASS writes PASS artifact and row passes.
- Required policy command FAIL writes FAIL artifact and row blocks.
- Missing artifact under required policy blocks.
- Stale material or changed command-set/policy blocks.
- Missing/stale build receipt blocks self-host full assurance.
- No policy renders advisory/non-blocking.

## CHK-007

Update lifecycle/testing docs to state the new claim boundary. The docs should explain that `lattice validate` proves routine TEST readiness, while `done_required_validate` proves DONE-required full-suite readiness only when a project opts in. External projects are advisory by default. The docs must not imply release/pre-push/Authority production behavior changed.

Implementation notes:
- Keep this item focused on user-visible claim boundaries.
- Avoid over-documenting internal code structure.

## CHK-008

Configure this repository's `lattice.config.json` with self-host `doneRequiredCommands`: package build before root `npm test`, or an equivalent same-material build proof. Do not change ordinary `validate.commands` and do not change pre-push/release behavior.

Implementation notes:
- Use a timeout that reflects root test cost.
- This means this story itself will need to run `done_required_validate` before DONE once the gate is active.
