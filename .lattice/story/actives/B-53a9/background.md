## Trigger Event
On 2026-06-20, full `npm test` is RED on local main at `test:docs-drift-wrapper-root` with `TypeError: store.readReviewRuns is not a function` (review-run.ts:868 collectReviewerEvidenceState, reached via review-preflight.ts reviewerEvidenceAdvisoryGate). Reproduced on clean main. Root cause: merged story B-5a9a (commit 19a543165) added a `store.readReviewRuns` call into the review-preflight gate path, but did not update the stub StoryStore in docs-drift-wrapper-root-smoke.ts to implement it.

## Key Insights
docs-drift-wrapper-root-smoke.ts makeStubStore (line ~159) returns a hand-rolled partial StoryStore cast `as unknown as StoryStore`; it implements readStory/readChecklist/readDecision/readProcessEvents/etc. but NOT readReviewRuns. When the docs-drift preflight runs reviewerEvidenceAdvisoryGate -> collectReviewerEvidenceState -> store.readReviewRuns(storyId).runs, the missing method throws. B-5a9a self-DONEd because the Lattice DONE gate runs only the configured validate.commands subset (which excludes this smoke), leaving the full `npm test` chain RED. Audited the sibling stub stores: review-incremental-context-smoke ALREADY implements readReviewRuns (passes); review-convergence-smoke and authority-enforce-matrix-smoke do not exercise the preflight gate (pass). So only docs-drift-wrapper-root-smoke needs the method.

## Solution Tradeoffs
Add `readReviewRuns: () => ({ runs: [] })` to the docs-drift-wrapper-root-smoke stub store (the fixture has no review runs), mirroring review-incremental-context-smoke. This is a test-fixture completeness fix, not a production change — the production gate is correct; the stub was incomplete. Keep the fix minimal (one stub method); do NOT change the production preflight gate or review-run.ts. Verification is that full `npm test` returns to green.

## Conversational Texture
A genuine cross-session 2-host review of B-5a9a surfaced a separate soundness gap (HOLE 1, fixed in B-edf1); while validating B-edf1 the full `npm test` chain was found RED from this independent B-5a9a stub-store regression. The operator chose to fix it as a dedicated quick story before finishing B-edf1.
