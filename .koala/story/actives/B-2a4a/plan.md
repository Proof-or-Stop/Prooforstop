# Plan

## CHK-001

Add an explicit numeric PLAN review round field to the `story_review` structured response. Use `planReviewRound` as the preferred field and keep the existing `reviewRound` only as a compatibility alias for this response. Document that this alias is not the signed artifact `reviewRound`, which remains an ISO 8601 string on findings/review passes/delivery checks.

Touchpoints: `packages/main/src/handlers/story-review.ts`, `CLAUDE.md`, `docs/requirements/decisions/story-lifecycle.md`, `docs/requirements/decisions/testing-infra.md`, `scripts/verify-story-review-structured-output.mjs`, `scripts/verify-process-fact-contract.mjs`.

## CHK-002

Extend regression coverage so the structured story_review smoke asserts `planReviewRound` is numeric and the process fact contract asserts docs distinguish `story_review planReviewRound` from signed artifact `reviewRound: string (ISO 8601 review round id)`. Reuse the existing review-round ISO contract instead of inventing another source of truth.
