# Plan

## CHK-001

Goal: direct REVIEW story creation must not produce a Story whose phase is REVIEW but whose review metadata is unusable.

Implementation steps:
- Update the direct phase branch in packages/main/src/handlers/story-create.ts so args.phase === REVIEW persists currentReviewRound with the same ISO timestamp used for createdAt/startedAt.
- Keep non-REVIEW direct phase creation unchanged, avoiding synthetic review rounds for DEV/TEST/DONE backfill stories.
- Improve missing-currentReviewRound errors in review_run_start and review_loop_start so legacy half-initialized REVIEW stories explain the likely direct --phase=REVIEW source and point to repair/recreate guidance.
- Add a CLI smoke in packages/main/src/tasks/field-regression-cli-smoke.ts that creates a REVIEW story directly, asserts currentReviewRound exists, starts review_run_start, starts review_loop_start, and confirms a manually corrupt REVIEW story still fails closed with the clearer hint.

Verification:
- npm --prefix packages/main run build
- npm --prefix packages/main run test:field-regression-cli-smoke
- lattice validate --story=B-bc1f

Rollback:
- Revert the story-create metadata initialization and the smoke if it breaks direct phase compatibility; the pre-existing fail-closed review_run_start behavior remains the fallback while a stricter direct-phase policy is designed separately.
