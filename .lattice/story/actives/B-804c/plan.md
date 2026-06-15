# Plan: B-804c Make story_advance INIT_CHECK atomic with worktree bootstrap, or add a recovery path

Forward fix = Option A (defer phase write until bootstrap succeeds). Recovery = expose the
existing idempotent `dev_start` as a public CLI command. No xstate machine edges added.

## CHK-001: Make the INIT_CHECK phase write atomic with worktree bootstrap

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/cli-engine.ts (INIT_CHECK story_advance block, ~lines 4016-4063)
- Modify: packages/main/src/handlers/worktree.ts (dev_start: accept phase INIT for the bootstrap entry; extend scope-anti-expansion guard to also fire for INIT)

**Verify**:
- `lattice validate --lint` green (tsc passes)
- New smoke (CHK-003) asserts: on injected bootstrap failure, story_get shows phase INIT (not INIT_CHECK)
- `lattice validate` green; existing worktree/init-check smokes still pass

**DoneWhen**:
- In the cli-engine INIT_CHECK block, `dev_start` runs FIRST against the still-INIT story; `handlers.story_advance` (phase persistence) is called ONLY after bootstrap returns success.
- On bootstrap failure: no phase advance; the command reports failure and the story stays at its prior phase (INIT). User sees a failure message, not "advanced to INIT_CHECK" + warning.
- B-5246 retry path preserved: if currentPhase===INIT_CHECK already (legacy victim), skip the advance and only (re)run dev_start; never attempt INIT_CHECK->INIT_CHECK.
- B-f60c metadata-mirror commit (commitInitCheckMetadataAndMergeMain) still runs AFTER successful dev_start; final order = dev_start -> advance phase -> commit metadata mirror.
- dev_start accepts phase INIT for the bootstrap entry, and its scope-anti-expansion guard fires for phase INIT as well as INIT_CHECK so the freeze gate is not bypassed.

## CHK-002: Add a supported recovery path for stories already stuck without a worktree

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/cli-engine.ts (add `dev_start` to MAIN_TOOLS with schema + longHelp)
- Modify: packages/main/src/core/command-policy.ts (add `dev_start` entry: ownershipClass=storyScopedMutating, allowedPhases INIT/INIT_CHECK/PLAN/DEV, destructiveRisk metadata-write)
- Modify: packages/main/src/core/config.ts (DEFAULT_PHASE_TOOLS: add `dev_start` to INIT_CHECK and PLAN allowlists)

**Verify**:
- `lattice dev_start --help` prints help (command registered)
- New smoke (CHK-003): a story stuck in INIT_CHECK with no worktree on disk → `lattice dev_start {storyId}` recreates the worktree and prints its Path
- Smoke asserts dev_start refused in REVIEW/TEST/DONE and refused for an unfrozen INIT story

**DoneWhen**:
- `lattice dev_start {storyId}` is a real CLI command routing to the existing idempotent `handlers.dev_start`.
- For a story stuck in INIT_CHECK with no worktree, it recreates the worktree and prints its path (instead of being unrecoverable).
- Idempotent: when worktree already exists it returns the existing path without error.
- command-policy + phaseTools both permit it only in the intended phases; owner-lease gate applies (storyScopedMutating).

## CHK-003: Add regression tests for non-atomic advance and recovery

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Create: packages/main/src/tasks/init-check-atomicity-smoke.ts
- Modify: packages/main/package.json (register `test:init-check-atomicity-smoke` npm script)
- Modify: package.json (register the aggregate `test:init-check-atomicity-smoke` passthrough if siblings do)

**Verify**:
- `npm --prefix packages/main run build` then `node packages/main/dist/tasks/init-check-atomicity-smoke.js` exits 0
- `lattice validate` green

**DoneWhen**:
- (a) Forced/injected bootstrap failure leaves the phase unchanged (story_get shows INIT, no partial advance). Uses an injectable failure seam (e.g. a bootstrap pre-condition that fails: story metadata not inside the resolved git root, or a stubbed dev_start), not a flaky real git failure.
- (b) The recovery path: a story seeded into INIT_CHECK with no worktree on disk is re-bootstrapped by `lattice dev_start` which recreates the worktree and prints its path.
- (c) Guard assertions: dev_start refused in terminal/REVIEW phases; unfrozen INIT story refused.
- Test mirrors the existing worktree-repair-smoke.ts seam (self-contained node script, execFileSync of dist/cli.js, mkdtemp repo).
