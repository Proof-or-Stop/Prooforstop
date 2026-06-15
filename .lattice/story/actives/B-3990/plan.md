# Plan: B-3990 Resolve gitRoot for bare CLI gates (no --story) on wrapper-root projects

> **Scope.** Change the verifier.ts no-`--story` gitCwd fallback (around line 604) from
> `projectRoot` to the project-level resolver `evaluateStoryDirConfigInsideGitRoot(...).gitRootAbs ?? projectRoot`.
> cwd-only; byte-identical for plain repos. Reuse the EXPORTED resolver — do NOT modify it,
> and do NOT touch the `--story` `resolveGitCwd` path (B-2856, works). Mirrors B-2856's
> cwd-only pattern. No gate-semantics or git-command-text change.

## CHK-001: verifier.ts no-story gitCwd fallback

**Owner**: lattice-implementer  **DependsOn**: none
**Files**:
- Modify: `packages/main/src/handlers/verifier.ts` — the gitCwd resolution block (~line 604, `args.story ? resolveGitCwd(...) : projectRoot`). Change the no-story branch to `evaluateStoryDirConfigInsideGitRoot({ metadataRoot: projectRoot }).gitRootAbs ?? projectRoot`. Apply to the shared no-story gitCwd so it also covers the bare channel/lint gates if they read the same value.
- Import `evaluateStoryDirConfigInsideGitRoot` from `../core/story-signed-workspace-resolution.js`.

**Verify**:
- bare `lattice validate --concept` (no --story) on a wrapper-root fixture no longer prints `warning: Not a git repository` / `git diff failed`
- plain repo unchanged

**DoneWhen**:
- the no-story branch resolves gitCwd via the project-level resolver; gate pass/fail semantics + git command text unchanged; plain-repo (null gitRoot) falls back to projectRoot.

## CHK-002: test

**Owner**: lattice-implementer  **DependsOn**: CHK-001
**Files**:
- Create/extend a test (follow the existing `tasks/` style) with a wrapper-root fixture (gitRoot != metadataRoot) asserting: the no-story gitCwd resolves to the gitRoot; a plain repo resolves to projectRoot; a null gitRoot falls back to projectRoot. Function level (not via the global `lattice` binary).

**Verify**: `lattice validate` green.
**DoneWhen**: all three scenarios covered and passing.
