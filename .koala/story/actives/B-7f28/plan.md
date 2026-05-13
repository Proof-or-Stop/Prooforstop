# Plan: B-7f28 fromDraft bootstrap metadata split

## CHK-001

Goal: close the generic fromDraft metadata transaction so `story_create --fromDraft` no longer leaves main with untracked active story files or deleted draft files after automatic worktree creation.

Implementation direction:
- Keep ordinary INIT_CHECK scoped bootstrap behavior intact. Do not change the generic `dev_start` contract for non-fromDraft stories.
- Add a small CLI-level helper around the fromDraft success path in `packages/main/src/cli-engine.ts`. After `handlers.dev_start({ storyId })` succeeds, stage only the current story active directory and the source draft directory, commit that bounded metadata transaction on main, then merge main into the newly created story worktree/branch.
- Fail visibly if the bounded commit/merge cannot complete. Do not silently leave a dirty main mirror.
- Avoid hard-coded story ids, draft names, project names, or plasmid-specific paths. Resolve paths from `storyId`, `fromDraft`, and configured story storage/draft conventions.

Risks:
- Accidentally staging unrelated user edits. Mitigation: path-scoped git add only.
- Breaking existing INIT_CHECK branch isolation. Mitigation: only invoke helper in story_create fromDraft branch.
- Merge conflict when the story branch already changed the same metadata. Mitigation: helper runs immediately after bootstrap before DEV changes.

## CHK-002

Goal: make the plasmid failure shape impossible to regress unnoticed.

Implementation direction:
- Extend `packages/main/src/tasks/worktree-authority-smoke.ts` in `assertFromDraftCreatesWorktreeThroughCli`.
- After `story_create --fromDraft`, assert `git status --porcelain` in main is empty.
- Assert `git merge-base --is-ancestor main story/<storyId>` succeeds.
- Keep the existing assertions that the worktree is registered, output includes worktree information, and story metadata contains `worktree.path`.
- If useful, also assert the draft directory is gone and no untracked active mirror remains through the clean status assertion.

Risks:
- Smoke fixture may depend on git identity. It already configures identity in the temporary repo; preserve that.
- Test could pass while output still confusing. Existing output assertion plus clean status assertion covers the user-visible command path.

## CHK-003

Goal: verify the targeted workflow and enough surrounding bootstrap behavior to trust the change.

Verification commands:
- Run the targeted worktree authority smoke, or the package script that invokes it if available.
- Run the INIT_CHECK bootstrap regression script if it remains relevant to prove ordinary branch isolation behavior is unchanged.
- Run TypeScript/build checks used by the package if code edits affect typed sources.

Evidence to record:
- For CHK-001, record code-level evidence pointing at the bounded fromDraft helper and targeted git commands.
- For CHK-002, record smoke test command output showing clean main and branch contains main.
- For CHK-003, record final validation/test commands through `verification_evidence_add` or `checklist_update verificationEvidence`.
