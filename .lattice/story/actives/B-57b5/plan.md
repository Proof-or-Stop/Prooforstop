# B-57b5 Plan

## CHK-001 - Extract lifecycle dispatch and runCli orchestration helpers

Goal: move lifecycle-specific command branches out of the body of `runCli` without changing the generic CLI ordering. The shared run wrapper remains responsible for reviewer-readonly checks, preCommand hooks, story owner lease enforcement, handler execution, activity/process-event logging, hint decoration, postCommand hooks, and error hooks.

Implementation steps:

1. Add `packages/main/src/cli/lifecycle-dispatch.ts` with typed helper functions for `story_create` and `story_advance INIT_CHECK` branches.
2. Pass dependencies into the helper instead of importing the handler registry directly: parsed command data, root, store, handlers, git readiness, and a `run` callback that preserves current wrapper semantics.
3. Keep `cli-engine.ts` as the top-level argument parser / validator / wrapper owner, replacing only the large special-branch bodies with calls to the helper.
4. Preserve all user-visible text currently emitted for story creation, from-draft bootstrap, dry-run INIT_CHECK bootstrap, INIT_CHECK aborts, and next-step hints.

Verification:

- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:command-catalog-smoke`
- `npm --prefix packages/main run test:command-ownership-contract`
- focused lifecycle smoke that asserts story_create/INIT_CHECK text and no bypass of generic wrapper paths.

Stop conditions:

- Any lifecycle helper calls a handler outside the shared `run` wrapper.
- Any visible story_create or INIT_CHECK recovery text changes without an explicit assertion update.
- Any owner/reviewer/hook/order smoke regresses.

## CHK-002 - Extract INIT_CHECK metadata sync and recover helpers

Goal: move `commitInitCheckMetadataAndMergeMain` plus its bounded metadata reconciliation helpers into `packages/main/src/cli/init-check-metadata-sync.ts`, and move the `recover_evidence` special stdout/error behavior into `packages/main/src/cli/recover-evidence-dispatch.ts`.

Implementation steps:

1. Move `resolveInitCheckGitMainRoot`, `commitInitCheckMetadataAndMergeMain`, `mergeBaseBranchIntoStoryWorktreeResolvingMetadata`, and `runGitNoThrow` together so the bounded staging and conflict resolution invariants stay in one module.
2. Keep `commitInitCheckMetadataAndMergeMain` re-exported from `cli-engine.ts` for existing tests/imports.
3. Move only the `recover_evidence` CLI dispatch behavior into a helper: call handler, print structured refused/fail result first, then throw the existing one-line error so exit code remains non-zero.
4. Leave recover_evidence business logic in its handler and leave Authority receipt semantics untouched.

Verification:

- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/init-check-reconcile-conflict-smoke.js`
- `node packages/main/dist/tasks/worktree-authority-smoke.js`
- `node packages/main/dist/tasks/verification-freshness-smoke.js`
- `npm --prefix packages/main run test:main-write-lock-coverage`

Stop conditions:

- INIT_CHECK metadata commit can stage out-of-bounds paths.
- Metadata conflict resolution can leave merge markers or silently resolve non-metadata conflicts.
- `recover_evidence` no longer prints JSON diagnostics before non-zero failure.

## CHK-003 - Verify lifecycle and merge-main safety after extraction

Goal: prove the extraction is behavior-preserving for lifecycle, merge-main, ownership, process-fact, and JSON-output contracts.

Implementation steps:

1. Add `packages/main/src/tasks/lifecycle-dispatch-smoke.ts` and a package script if needed.
2. Run existing regression tasks that cover INIT_CHECK, main write locks, command ownership, process facts, lifecycle registry, and command help/catalog behavior.
3. Record verificationEvidence against all nine verificationIntent refs only after code and metadata are committed.

Required commands:

- `npm --prefix packages/main run build`
- `node scripts/verify-process-fact-contract.mjs`
- `npm --prefix packages/main run test:lifecycle-registry-contract`
- `npm --prefix packages/main run test:command-catalog-smoke`
- `npm --prefix packages/main run test:command-ownership-contract`
- `npm --prefix packages/main run test:main-write-lock-coverage`
- `node packages/main/dist/tasks/init-check-reconcile-conflict-smoke.js`
- `node packages/main/dist/tasks/worktree-authority-smoke.js`
- `node packages/main/dist/tasks/verification-freshness-smoke.js`
- focused lifecycle-dispatch smoke script
- `node bin/lattice.js scope_contract_check '{"storyId":"B-57b5","json":true}'`

Stop conditions:

- Any lifecycle/Authority/process-fact test requires policy behavior changes to pass.
- Any local verdict or transcript is interpreted as Authority Server production completion.
- Validation evidence becomes stale after implementation changes.
