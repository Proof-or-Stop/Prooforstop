# Plan — Fix docs-drift-wrapper-root-smoke stub store missing readReviewRuns

Full `npm test` is RED on main at `test:docs-drift-wrapper-root` with
`TypeError: store.readReviewRuns is not a function` — a regression from merged
B-5a9a, which added a `store.readReviewRuns` call to the review-preflight gate path
without updating this smoke's stub StoryStore. Test-fixture completeness fix only.

## CHK-001

In `packages/main/src/tasks/docs-drift-wrapper-root-smoke.ts` `makeStubStore`
(~182-191), add `readReviewRuns: () => ({ runs: [] })` to the returned stub object
(the fixture has no review runs), mirroring the shape in
`review-incremental-context-smoke.ts` (~line 119). This lets
`collectReviewerEvidenceState` (review-run.ts:868) read `.runs` without throwing
when the docs-drift preflight runs `reviewerEvidenceAdvisoryGate`. Do NOT change the
production review-preflight gate or review-run.ts. Add ONLY the one method; leave
every other stub field byte-identical.

User sees: `node packages/main/dist/tasks/docs-drift-wrapper-root-smoke.js` runs the
docs-drift preflight without TypeError and exits 0.

## CHK-002

Verify full `npm test` returns to green: the `test:docs-drift-wrapper-root` step
passes and the whole chain runs to ALL PASS, exit 0. This is the regression-resolution
verification (no new test file — the existing docs-drift-wrapper-root smoke is the
coverage; it now runs its preflight path without throwing).

User sees: `npm test` exits 0 (ALL PASS), with test:docs-drift-wrapper-root passing
instead of throwing `TypeError: store.readReviewRuns is not a function`.

## Verification approach

One DEV commit (the single stub method); build tsc-clean; run the docs-drift
wrapper-root smoke standalone; run full `npm test` green; ONE review round (claude 3
lanes + codex host-2); `recover_evidence`; TEST → DONE (DONE auto-bumps version +
auto-rebuilds dist — do NOT do those manually).
