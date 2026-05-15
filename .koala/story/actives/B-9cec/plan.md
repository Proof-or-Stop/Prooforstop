# B-9cec Plan

## Goal

Close the single high-priority convergence gap from docs/requirements/decisions/testing-infra.md:38 without broad validation refactors. The user-visible finish line is that `koala gap_analyze` no longer reports the no-entry warn/skip requirement as uncovered, and `npm --prefix packages/main run test:validation-protocol` still prints `✓ validation protocol smoke passed`.

## Constraints

- Keep the verifier entrypoint priority order: validate.ts/js/mts, configured validate.command(s), advisory fallback commands, then no-entry warn/skip.
- Preserve fail-closed behavior for configured validation command failures.
- Do not solve unrelated medium legacy fixture gaps in this story.
- Use Koala CLI for story artifacts and record verification evidence after running commands.

## CHK-001

Bind the no-validator warn/skip requirement to verifier implementation. Add a precise `@task B-9cec` policy annotation at the verifier implementation surface so the truth-source text from testing-infra.md:38 is mechanically traceable to code. Keep this as an annotation/back-link change; avoid runtime behavior changes unless tests expose a mismatch.

Validation for CHK-001: run gap analysis after build/test and confirm the high uncovered requirement is gone or no longer points at testing-infra.md:38. The annotation should not create a new function-level no-test gap.

## CHK-002

Cover the policy with focused smoke cases. Extend validation-protocol smoke so an isolated project with no validate file, no configured command, and no discovered fallback returns provider `koala-verifier-no-validation-entry`, status `warn`, and `allPass=true`. Add a configured failing command case asserting provider `koala-verifier-configured-commands`, status `fail`, `allPass=false`, and no fallback/advisory discovery wording.

Validation for CHK-002: run `npm --prefix packages/main run build` and `npm --prefix packages/main run test:validation-protocol`. If the smoke test fails, fix the verifier/test mismatch before recording evidence.

## Rollback

If the annotation or smoke additions create fresh convergence/test failures, revert only this story commit from the story branch and re-run `koala gap_analyze` to confirm the repository returns to the pre-story state.
