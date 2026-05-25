# B-da5b Plan

## CHK-001

1. Make `cli-engine.ts` capture a durable main-repo activity fallback before command execution. `writeLog` should keep using the active command root while it exists, but if the captured root disappears after DONE cleanup, append the final activity record to the precomputed main root instead of calling `resolveRoot()` from a deleted cwd.
2. Strengthen `worktree-authority-smoke.ts` so the real `story_advance DONE` success path asserts both sides of the user-visible guarantee: `.worktrees/<storyId>` stays absent after the command returns, and main `.koala/activity.jsonl` contains the final `story_advance` record.
3. Add a short lifecycle doc note that terminal cleanup activity is recorded in the surviving main repo when a story worktree is removed.
4. Verify with `npm --prefix packages/main run build`, `npm --prefix packages/main run test:worktree-authority-smoke`, `koala doctor --format=json`, and `koala validate --story=B-da5b`.

## Out of Scope

- Changing DONE gate semantics or worktree deletion safety.
- Reworking doctor repair behavior.
- Reintroducing legacy `docs/story/activity.jsonl` writes.
