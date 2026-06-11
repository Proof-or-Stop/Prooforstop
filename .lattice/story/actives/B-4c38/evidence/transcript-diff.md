# B-4c38 User-Visible Transcript Diff

Expected:
- Concurrent `story_advance --phase=DONE` attempts serialize on one main-level lock.
- A held live lock fails before `phase=DONE` is written and tells the operator to retry.
- `koala doctor` reports recoverable partial-DONE stories with `koala done_recover --storyId=<id>`.
- `koala done_recover` completes merge, worktree removal, branch deletion, and refuses unsafe states.

Actual:
- `npm --prefix packages/main run test:worktree-authority-smoke`
  - Output: `✓ worktree authority smoke passed`
  - Covers live lock refusal before phase mutation, normal DONE cleanup, stale lock reclaim, and lock-before-autoSync ordering.
- `npm --prefix packages/main run test:worktree-repair-smoke`
  - Output: `✓ worktree repair smoke passed`
  - Covers partial-DONE detection, `done_recover` happy path, dirty main refusal, dirty story worktree refusal, merge conflict refusal, cleanup transcript, and the F-006 regression where main is DONE but the story branch is still TEST.
- `koala validate --story=B-4c38 --json`
  - Result: `status=pass`, `allPass=true`
  - Coverage: `17/18 covered`, `0 required missing`; the only missing item is a should-level reviewer meta-check.

Diff:
- No product-facing gap. The actual operator-visible behavior matches the expected recovery workflow.
- `koala doctor` currently reports pre-existing health-log/Codex adapter warnings in this worktree, but worktree scan is clean and those warnings are outside this story's DONE merge/recovery behavior.
