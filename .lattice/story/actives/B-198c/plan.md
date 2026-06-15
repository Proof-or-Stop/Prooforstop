# Plan: B-198c Early-validate storyDir resolves inside the resolved gitRoot

> **Scope note (user steer 2026-06-15 — 不要为了优化而优化):** this story is
> **purely additive**. It adds a small detection helper consumed ONLY by the new
> `doctor` check and the early advisory. The two existing late guards
> (`packages/main/src/handlers/worktree.ts:754`, `packages/main/src/cli-engine.ts:3367`)
> are **left untouched**. This **supersedes** CHK-001's original context aside about
> "have both existing guards call it" — we accept a small duplicated check rather than
> refactor stable working guard code. Approach = decision **Option A** (warn early,
> do NOT hard-fail; late guards remain the hard backstop).

## CHK-001: detection helper (used only by the new doctor + advisory)

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Create/extend: `packages/main/src/core/story-signed-workspace-resolution.ts` (or a sibling core module) — export e.g. `evaluateStoryDirInsideGitRoot({ store, storyId, metadataRoot }) => { ok, storyDirAbs, gitRootAbs, rel, reason? }`
- Do NOT modify: `packages/main/src/handlers/worktree.ts`, `packages/main/src/cli-engine.ts`

**Verify**:
- `lattice validate` green
- new logic test exercising ok / violation / symlink / no-gitRoot passes

**DoneWhen**:
- computes `rel = relative(realpath(gitRoot), realpath(storyAbs))`; `ok=false` when `rel` is empty / absolute / contains a `..` segment (same condition as the two guards)
- obtains the resolved gitRoot via `resolveStorySignedWorkspace`; when resolution is unresolved, returns a distinct non-violation result (e.g. `reason: 'gitroot-unresolved'`) and **never throws**
- pure: no console output; callers own presentation

## CHK-002: lattice doctor check

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: the `doctor` command handler under `packages/main/src/handlers/`

**Verify**:
- `lattice doctor` on a wrapper-root fixture prints the violation + remediation
- `lattice doctor` on a normal repo does not print it

**DoneWhen**:
- doctor calls the CHK-001 helper; on violation prints a distinct flagged check:
  `✗ storyDir resolves OUTSIDE the resolved gitRoot` + the storyDir and gitRoot abs paths + `→ configure storyDir so story metadata lives inside the gitRoot.`
- when gitRoot is unresolvable, doctor reports that condition separately and does not throw

## CHK-003: early advisory at story_create / session_brief

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: the `story_create` handler and the `session_brief` handler under `packages/main/src/handlers/`

**Verify**:
- `story_create` in a wrapper-root violation prints the one-line advisory to **stderr** and STILL creates the story (warn-only)
- `session_brief` shows the advisory
- normal case (metadataRoot == gitRoot): no advisory

**DoneWhen**:
- both surfaces call the CHK-001 helper and emit a one-line advisory with remediation on violation
- advisory is **warn-only** (Option A) — never blocks `story_create`
- advisory goes to **stderr** (consistent with the existing story_create advisory convention in CLAUDE.md)
- no advisory when metadataRoot == gitRoot or no gitRoot configured

## CHK-004: tests

**Owner**: koala-implementer
**DependsOn**: CHK-001, CHK-002, CHK-003
**Files**:
- Create: `packages/main/tests/storydir-inside-gitroot.test.ts` (helper + doctor + advisory coverage)

**Verify**:
- `lattice validate` green; new tests pass

**DoneWhen**:
- helper: ok (inside), violation (`..` sibling = the ClawCreek case), symlinked roots resolved via realpath, no-gitRoot
- doctor + advisory: violation prints, normal case silent, unresolvable-gitRoot does not throw
- **no guard-behavior tests** (the two late guards are untouched by this story)
