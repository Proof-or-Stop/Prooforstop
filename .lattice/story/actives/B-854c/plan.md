# Plan: B-854c Protect tracked story metadata from .gitignore data-loss

Chosen model: **OptAB-combination** (decision.json).
- **A (force + guard)**: bootstrap force-adds metadata (`git add -f`) so it is committed/tracked; a `git check-ignore` guard on the actual metadata leaf surfaces (loud warning + repair pointer) when the project default would still leave it ignored/untracked.
- **B (scaffold/validate)**: a new `lattice doctor` invariant check + `--repair` that writes/validates the managed ignore-volatile/track-metadata allowlist (reusing the existing `runtime-artifact-registry` allowlist + `managed-assets` scaffolding) so new projects are safe by default.

Shared core helper (`core/story-metadata-protection.ts`) holds the pure predicate so bootstrap (A), doctor (B), and tests all consume ONE truth source.

## CHK-001: Choose and document the metadata protection model (decision)

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Already done in PLAN: `.lattice/story/actives/B-854c/decision.json` (chosen=OptAB-combination, 4 preMortem), `understanding.json`.

**Verify**:
- `lattice story_get '{"storyId":"B-854c"}'` reflects the decision; PLAN gate passes (>=3 preMortem).

**DoneWhen**:
- decision_set recorded with chosen=OptAB-combination and rationale that makes bootstrap git-add + protection stance mutually consistent.
- >=3 preMortem (4 recorded).

## CHK-002: Make worktree bootstrap robust to an ignored story metadata path

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Create: `packages/main/src/core/story-metadata-protection.ts` (pure predicate + check-ignore helpers; NO direct process spawn in the predicate — inject a `checkIgnore` runner like validate-lint's CommandRunner pattern).
- Modify: `packages/main/src/handlers/worktree.ts` — ONLY the `createScopedStoryBootstrapCommit` `git add` line (~316): change `['add','--',storyRel]` to `['add','-f','--',storyRel]`, and after the scoped commit, run the check-ignore guard on the metadata leaf; if it reports the leaf would be ignored/cleaned, append a loud warning (pointing at `lattice doctor --repair`) to the dev_start return string. Do NOT touch `resolveBootstrapGitRoot` / gitRoot cwd lines (B-2856) or the story.worktree write-ordering lines (B-804c).
- Test: `packages/main/tests/story-metadata-protection.test.ts` (predicate units) + bootstrap integration coverage in CHK-004.

**Verify**:
- `lattice validate` green.
- Integration: temp git repo with broad `.lattice/` ignore → `dev_start` succeeds (no "paths are ignored" error) and warning present; with non-ignoring `.gitignore` → succeeds, no warning; with negation allowlist → succeeds, no warning (no false positive).

**DoneWhen**:
- Bootstrap uses `git add -f` so it never hard-fails with "The following paths are ignored …".
- check-ignore guard fires ONLY on the broad-ignore (would-be-cleaned) leaf, not on the negation-allowlist or non-ignoring cases.
- Warning text points the operator at the repair command; the change is surgical (only the git-add/guard lines).

## CHK-003: Add a doctor check + scaffolding for the track/ignore invariant

**Owner**: lattice-implementer
**DependsOn**: CHK-002 (consumes the shared predicate)
**Files**:
- Modify: `packages/main/src/handlers/doctor.ts` — add a new scan section "story metadata protection" using the shared predicate; in `--repair` mode, write the managed allowlist via the existing `managed-assets` runtime-ignore merge (reuse `mergeRuntimeGitignore` / `listRuntimeArtifactIgnorePatterns`; do NOT hand-roll a second allowlist). Add to both text and `--json` output.
- Modify (if needed, minimal): `packages/main/src/core/managed-assets.ts` — export the runtime-ignore merge if not already callable from doctor (prefer reuse over new code).
- Test: doctor predicate + repair coverage in CHK-004.

**Verify**:
- `lattice doctor` on a broad-ignore-untracked fixture prints the data-loss warning + repair pointer; `--json` marks invariant unsafe.
- `lattice doctor --repair` writes the allowlist (idempotent); re-scan reports safe; second `--repair` is a no-op.
- On a safe project (tracked, OR negation allowlist) doctor reports OK, no false positive.

**DoneWhen**:
- Doctor flags the neither-tracked-nor-protected state with a clear remediation.
- `--repair` installs the managed allowlist and clears the unsafe state idempotently.
- No false positive on safe projects (Orchestrate-style allowlist or tracked metadata).

## CHK-004: Add regression tests for the data-loss invariant

**Owner**: lattice-implementer
**DependsOn**: CHK-002, CHK-003
**Files**:
- Create/extend: `packages/main/tests/story-metadata-protection.test.ts` and/or bootstrap/doctor integration tests using `.gitignore` fixtures.
- Wire into the validate suite if a new test file needs registration.

**Verify**:
- `lattice validate` runs the new tests green.

**DoneWhen**:
- Coverage: metadata tracked/protected after bootstrap under BOTH ignoring and non-ignoring `.gitignore`.
- Coverage: doctor predicate detects the unsafe state and clears after repair.
- Coverage: bootstrap never silently leaves metadata in the neither-tracked-nor-protected state (force-add yields tracked leaf, or loud warning).
- Predicate tests construct fixtures bypassing the happy path (broad-ignore, negation-allowlist, tracked) to assert the predicate is correct at every consumer.
