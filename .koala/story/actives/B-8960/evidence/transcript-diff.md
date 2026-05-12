# B-8960 Product Transcript Diff

## Expected

Users maintaining Koala can rely on hard-coded process/runtime gates instead of prompt-only memory:

- `npm run test:runtime-reviewer-contract` fails on stale story worktree CLI paths, including the split `worktreeRoot` plus `join(...packages/main/dist/cli.js)` regression shape.
- `npm run test:process-fact-contract` fails on prompt/template `reviewRound: number` drift, while allowing explicit `story_review.planReviewRound`.
- `npm run audit:silent-catches` passes for committed baseline debt and fails only when a new uncategorized catch appears, not when unrelated line numbers move.
- TEST validation reports all verification intents covered.

## Actual

Observed in the B-8960 worktree:

- `npm run test:runtime-reviewer-contract` -> `runtime reviewer contract verified`.
- `node scripts/verify-main-branch-runtime-health.mjs` -> `main branch runtime health verified`.
- `npm run test:process-fact-contract` -> `Process fact contract verified`.
- `npm run audit:silent-catches` -> `status: silent catch audit passed`, `version: 2`, `newUncategorized: 0`, `lineStableBaselineKey: passed`.
- Negative silent-catch test with a temporary `packages/main/src/__koala_silent_catch_regression_tmp.ts` -> `status: silent catch audit failed`, `newUncategorized: 1`, file/line/snippet reported; temporary file was deleted and the audit passed again.
- `npm test` -> `ALL PASS` for `story-lifecycle` and `gap-convergence`.
- `koala validate --story=B-8960` -> project validation passed and `Verification intent coverage: 15/15 covered`.

## Difference

No product-visible gap remains. One environment setup note: the story worktree had no `packages/main/node_modules`; `npm ci` cannot currently resolve unpublished `@koala-agent/lab`, so the validation run used a local symlink to the main checkout's existing `packages/main/node_modules` for this worktree. This did not modify tracked files.
