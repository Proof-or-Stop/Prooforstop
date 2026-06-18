# Plan: B-e791 gitRoot-aware INIT guidance + dev_start nesting-check cwd

> **Scope.** Make the session.ts git-readiness guidance gitRoot-aware and run the
> worktree.ts dev_start nesting check in the resolved gitRoot. Reuse the existing
> `configuredGitRootStatus` / signed-workspace resolution (no second resolver).
> Plain non-git projects (no configured gitRoot) stay byte-identical.
> **Exclude:** lattice doctor (B-1637), bootstrap behavior, gate semantics, git command text.

## CHK-001: session.ts git-readiness guidance gitRoot-aware

**Owner**: lattice-implementer  **DependsOn**: none
**Files**:
- Modify `packages/main/src/handlers/session.ts` — the INIT/INIT_CHECK next-step strings (~549/554) and the non-git advisories (~694/889/921) that branch on `gitReady` (= `isGitRepository(ctx.root)`, ~672). When a configured gitRoot resolves (use the existing `configuredGitRootStatus` from ~918), do NOT tell the user to git init the metadata root — guide them to proceed to INIT_CHECK. Plain non-git projects with no configured gitRoot keep the existing message.

**Verify**: on a wrapper-root fixture, `session_brief`/`next` says ready-for-INIT_CHECK (not git init); plain no-gitRoot keeps the git-init message.
**DoneWhen**: guidance is gitRoot-aware; plain byte-identical; reuses existing resolution (no second resolver).

## CHK-002: dev_start nesting-check runs in the resolved gitRoot

**Owner**: lattice-implementer  **DependsOn**: none
**Files**:
- Modify `packages/main/src/handlers/worktree.ts` (~795) — the nesting check `git rev-parse --abbrev-ref HEAD` currently runs with no cwd (process.cwd() = metadataRoot). Run it in the resolved gitRoot (`resolveBootstrapGitRoot` result) or skip cleanly when the metadataRoot isn't a git repo, so no spurious `fatal: not a git repository` is printed. Preserve the nesting **rejection** behavior.

**Verify**: `story_advance INIT_CHECK` on a wrapper-root fixture prints no `fatal: not a git repository`; a real `worktree-*` branch is still rejected.
**DoneWhen**: no spurious fatal on wrapper-root; nesting rejection unchanged.

## CHK-003: tests

**Owner**: lattice-implementer  **DependsOn**: CHK-001, CHK-002
**Files**:
- Create a function-level test (follow the existing `packages/main/src/tasks/` style; wire any script into package.json) with a wrapper-root fixture asserting: (a) the guidance helper returns ready-for-INIT_CHECK when a gitRoot resolves and keeps the git-init message for a plain no-gitRoot project; (b) the nesting check produces no `fatal: not a git repository` on a wrapper-root metadataRoot and still rejects a real `worktree-*` branch. Do not shell to the global `lattice` binary.

**Verify**: `lattice validate` green.
**DoneWhen**: all cases covered and passing.
