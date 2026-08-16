# Plan: B-3e5d Fix concurrent DONE racer crash and retired channel-lane reference in field-regression-cli-smoke

## CHK-001: Root the per-story transition lock at the stable main repo root instead of the worktree path

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Modify: packages/main/src/handlers/transition-orchestrator.ts
- Test: packages/main/tests/red/red-B-new-concurrent-done-race.mjs

**Verify**:
- `node packages/main/dist/tasks/worktree-authority-smoke.js` prints `✓ worktree authority smoke passed`
- `node packages/main/tests/red/red-B-new-concurrent-done-race.mjs` exits non-zero (its own "defect still present" assertion now correctly fails, since the underlying smoke test passes)

**DoneWhen**:
- CORRECTED post-REVIEW (F-001, lattice-review-quality): the originally planned `transitionLockRoot` reroute was a no-op — `acquireStoryTransitionLock` already anchors its lock directory at the git-common-dir-derived shared root via `storyTransitionLockPath`/`resolveSharedLockRoot` (B-d877 R2 FIX B), regardless of which root string is passed in. Verified empirically: `storyTransitionLockPath(worktreePath, id)` and `storyTransitionLockPath(mainRepoRoot, id)` resolve to the identical directory. The reroute was reverted; `acquireStoryTransitionLock(ctx.root, args.storyId)` is called exactly as before this story. CHK-001 is now a no-op/non-issue confirmation, not an independent code change — the entire real fix for the concurrent-DONE-race crash is CHK-002 alone.
- Two concurrent `story_advance --phase=DONE` processes on the same story from the same worktree no longer race on a lock directory the winner's cleanup can delete out from under the loser (this was already true before this story, via the pre-existing git-common-dir anchoring)

## CHK-002: Translate the losing racer's post-wakeup StoryArtifactMissingError into a clean, expected message

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/transition-orchestrator.ts
- Test: packages/main/tests/red/red-B-new-concurrent-done-race.mjs

**Verify**:
- `node packages/main/dist/tasks/worktree-authority-smoke.js` prints `✓ worktree authority smoke passed` (specifically `assertConcurrentDoneSerializesWithoutPartialDone`)
- Loser stderr contains "a concurrent DONE transition ... already completed and removed it", never a raw `Error: File not found: .../index.json`

**DoneWhen**:
- `store.readStory(args.storyId)` is wrapped in a try/catch that recognizes `e?.name === 'StoryArtifactMissingError' && !existsSync(ctx.root)` and throws a clear explanatory error instead
- Any other `StoryArtifactMissingError` (root still present) rethrows unchanged

## CHK-003: Reject the retired lattice-review-channel lane in reviewer_list forceReviewer instead of exercising it as forceable

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Modify: packages/main/src/tasks/field-regression-cli-smoke.ts

**Verify**:
- `node packages/main/dist/tasks/field-regression-cli-smoke.js` prints `✓ field regression CLI smoke passed`
- `reviewer_list --forceReviewer=channel` case in `assertReviewerListForceReviewerLaneContract` asserts a non-zero exit and stderr matching `not supported by review_run_start`

**DoneWhen**:
- `channel` is removed from the forceable-lane assertion and a new case explicitly asserts it is rejected

## CHK-004: Route the pass-only finding_add CLI-surface assertion through an active review lane instead of the retired channel lane

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Modify: packages/main/src/tasks/field-regression-cli-smoke.ts

**Verify**:
- `node packages/main/dist/tasks/field-regression-cli-smoke.js` prints `✓ field regression CLI smoke passed`
- RP-004 review pass is recorded and attributed to `lattice-review-test-coverage`, not `lattice-review-channel`

**DoneWhen**:
- `assertPassOnlyFindingConvertsToReviewPassCliSurface`'s RP-004 case starts a real `review_run_start` for `lattice-review-test-coverage` and its `finding_add` desc text matches the pass-only wording heuristic

## CHK-005: Add standalone RED scripts proving both defects pre-fix, registered or exempted per the RED-harness registration guard

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-002, CHK-003, CHK-004
**Files**:
- Create: packages/main/tests/red/red-B-new-concurrent-done-race.mjs, packages/main/tests/red/red-B-new-retired-channel-lane.mjs
- Modify: packages/main/tests/red/red-b49d4-harness-registration.mjs

**Verify**:
- Both RED scripts use `spawnSync` with a real file-descriptor for stdio (not `execFileSync`'s pipe capture, which truncates large synchronous crash dumps at 8192 bytes on macOS)
- `red-b49d4-harness-registration.mjs`'s meta-guard passes with both new RED scripts registered in `REGISTRATION_EXCLUSIONS`

**DoneWhen**:
- Each RED script, run against the pre-fix dist build, failed with the expected defect signature; run against the post-fix dist build, its own "defect still present" assertion now itself fails (confirmed GREEN)

## CHK-006: Add readManifest to every pass-only finding_add call and restructure the DONE-ready story fixture to bind real reviewRunId evidence

**Owner**: main-agent
**DependsOn**: CHK-004
**Files**:
- Modify: packages/main/src/tasks/field-regression-cli-smoke.ts

**Verify**:
- `node packages/main/dist/tasks/field-regression-cli-smoke.js` prints `✓ field regression CLI smoke passed`

**DoneWhen**:
- All RP-001..RP-008 pass-only `finding_add` calls in `assertPassOnlyFindingConvertsToReviewPassCliSurface` supply `readManifest`
- `writeDoneReadyStory` is split into `writeDoneReadyStory` (writes phase=REVIEW, no hand-crafted `review-passes.json`) and `finishDoneReadyStory` (writes phase=TEST after real review evidence lands)

## CHK-007: Satisfy the full 3-lane review-assurance-floor quorum and record dev_memory_finish_decision before the DONE-ready fixture advances to DONE

**Owner**: main-agent
**DependsOn**: CHK-006
**Files**:
- Modify: packages/main/src/tasks/field-regression-cli-smoke.ts

**Verify**:
- `node packages/main/dist/tasks/field-regression-cli-smoke.js` prints `✓ field regression CLI smoke passed` (specifically `assertDoneMergeCleansMainUntrackedReviewPasses` reaching `story_advance --phase=DONE` without `review_lane_missing`)

**DoneWhen**:
- `assertDoneMergeCleansMainUntrackedReviewPasses` loops over `lattice-review-quality`, `lattice-review-concept`, and `lattice-review-test-coverage`, each with a real `review_run_start`-bound `review_pass_set`
- `dev_memory_finish_decision` is called before `story_advance --phase=DONE` in the fixture
