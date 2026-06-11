# B-ad12 Transcript Diff

## Expected

- `review_run_start` creates a signed reviewer run id bound to story, lane, review round, prompt hash, git HEAD, material hash, and start time.
- Current REVIEW evidence from `finding_add` and `review_pass_set` must include a valid `reviewRunId`; missing, stale, wrong-lane, wrong-round, tampered, or legacy-retrofitted evidence must fail mechanically.
- Reviewer prompts, dispatch guidance, anti-stall hints, and process-fact contract checks all point reviewers to `review_run_start` first and then reuse the returned id.
- Forced reviewers cannot create an unsatisfiable REVIEW gate by naming lanes unsupported by `review_run_start`.

## Actual

- `npm --prefix packages/main run build`: TypeScript build passed after merging current `main`.
- `node scripts/verify-process-fact-contract.mjs`: process fact registry and prompt drift contract passed, including review-run artifact and reviewRunId command examples.
- `npm --prefix packages/main run test:flow-stability-smoke`: passed, including rejection of reviewRunId-retrofitted legacy signatures and invalid run-bound reviewer evidence.
- `npm --prefix packages/main run test:field-regression-cli-smoke`: passed, including `review_run_start` CLI surface and forced reviewer lane validation.
- `npm --prefix packages/main run test:review-pass-discard-smoke`: passed, including pass-only normalization and review pass behavior.
- `npm run test:runtime-reviewer-contract`: passed, proving runtime reviewer contract now starts fresh review runs and threads the returned `reviewRunId` into `review_pass_set`.
- `node bin/koala-codex.js verify_codex`: local Codex adapter checks passed, with only the expected advisory that global `koala` resolves to the main checkout rather than this story worktree.
- `node packages/main/dist/cli.js validate --story=B-ad12`: passed project validation and reported `13/13` verification intents covered.

## Diff

No product-visible mismatch. The only non-blocking difference is expected for a worktree story: `verify_codex` warns that global fallback points at the main checkout, so current-story gate/status commands use the worktree-local CLI until DONE merges back to main.
