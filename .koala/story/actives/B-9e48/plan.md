# B-9e48 Plan

## Goal
Fix the Koala DONE path so running `story_advance --phase=DONE` from a nested directory inside a story worktree uses the canonical git worktree root for all merge, metadata commit, stray-file cleanup, worktree removal, and branch deletion steps. The SimCell B-e101 failure mode was that `process.cwd()` was `.worktrees/B-e101/PVSC`, so Koala committed DONE metadata and cleaned the child project directory instead of the story worktree root.

## Non-goals
- Do not change the Koala lifecycle, express-channel verificationIntent semantics, or reviewRound data model in this story.
- Do not repair SimCell B-e101 state as part of this code change.
- Do not loosen DONE gates or depend on prose output as evidence.

## CHK-001
### Implementation
- Add a small hardcoded helper in `packages/main/src/handlers/story-advance.ts` that resolves DONE worktree context from any cwd below the worktree:
  - `git rev-parse --show-toplevel` gives the canonical story worktree root.
  - `git rev-parse --path-format=absolute --git-common-dir` plus `dirname` gives the main repo root.
  - `git rev-parse --abbrev-ref HEAD` gives the story branch.
  - Only return context when branch starts with `story/` and worktree root differs from main repo root.
- Replace DONE pre-merge use of `process.cwd()` with the canonical worktree root for stray-file offender hints, merge-tree preflight, and conflict repair guidance.
- Replace DONE merge/cleanup use of `process.cwd()` with the canonical worktree root for story metadata `git add/commit`, `cleanStrayWorktreeFiles`, global koala link repair, `git worktree remove`, and residual directory cleanup.
- Add a destructive-operation guard so residual `rmSync` only targets a canonical worktree root known by git or under the configured story worktree directory shape, never the original nested cwd.
- Update the Worktree section in `CLAUDE.md` to document that DONE commands may be invoked from a subdirectory, but cleanup always resolves the git top-level story worktree root.

### Verification
- Unit/integration smoke proves the child directory is not removed directly and the main story metadata becomes DONE after merge.
- Manual code check confirms no DONE cleanup call passes the nested cwd to worktree removal, residual rm, or metadata commit.

## CHK-002
### Implementation
- Extend `packages/main/src/tasks/worktree-authority-smoke.ts` with a synthetic temp repo regression:
  - create main branch and a `story/B-nested-done` worktree at `.worktrees/B-nested-done`;
  - create a nested project directory inside the worktree;
  - write TEST-ready story metadata and required gate evidence through `StoryStore` or public CLI helpers;
  - run public CLI `story_advance DONE` from the nested directory;
  - assert output does not mention `.worktrees/B-nested-done/<child>` as the worktree removal target;
  - assert main branch story metadata is DONE with cleared worktree;
  - assert `story/B-nested-done` branch is deleted and git worktree registry is clean.
- Add or reuse npm script coverage so this smoke can be run from the normal verification path.

### Verification
- Run `npm run build`.
- Run the worktree authority smoke from built dist.
- Record these commands as `verificationEvidence` on the checklist before REVIEW/TEST.
