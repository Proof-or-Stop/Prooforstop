# Plan: B-1a12 Fix INIT_CHECK worktree bootstrap resolving the current worktree instead of the main repo root (nested .worktrees) + clean last stale .koala doc ref

## CHK-001: Resolve the MAIN repo root (not the current worktree) in INIT_CHECK bootstrap, with a from-worktree regression

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/handlers/worktree.ts
- Create: scripts/verify-nested-worktree-bootstrap.mjs (regression smoke; model on scripts/verify-init-check-bootstrap.mjs)
- Modify: package.json (wire test:* into the chained root `test`)
- Test: scripts/verify-nested-worktree-bootstrap.mjs

**Approach (chosen decision = bootstrap-specific-resolver)**:
1. Add a NEW bootstrap-specific helper inside `createWorktreeHandlers` (or near `getRepoRoot`/`resolveBootstrapGitRoot`) e.g. `resolveMainRepoRoot(cwd = root): string`:
   - `commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding, stdio:['pipe','pipe','pipe'], timeout: 5000 }).trim()`
   - Resolve absolute against cwd EXACTLY like line ~538: `const abs = isAbsolute(commonDir) ? commonDir : join(cwd, commonDir)`
   - If `abs` ends in `.git` (handle `/.git` and `\\.git`), main root = `dirname(abs)`; else FALL THROUGH to `getRepoRoot()` (never worse than today).
   - On any throw, fall through to `getRepoRoot()` (preserve existing fallback semantics).
2. In `resolveBootstrapGitRoot` (line ~430), change ONLY the no-configured-gitRoot path (line 432) from `return getRepoRoot();` to `return resolveMainRepoRoot();`.
3. DO NOT modify `getRepoRoot()` itself.
4. DO NOT modify `resolveWorktreePath` (line ~452, the NON-bootstrap caller of getRepoRoot).
5. DO NOT modify the configured-gitRoot branch (resolveStorySignedWorkspace path) — just verify it already yields the main root (it resolves via signed-workspace metadata, not show-toplevel, so it is already correct; add an assertion in the smoke if cheap, otherwise reason about it in the closing self-check).
6. Keep `cwd` for the git call = the metadata `root` (same as getRepoRoot uses) so from-main behavior is byte-identical.

**Regression smoke (scripts/verify-nested-worktree-bootstrap.mjs)**:
- Build a temp MAIN git repo with the lattice metadata layout (mirror verify-init-check-bootstrap.mjs setup helpers).
- Create story B-old, advance it to INIT_CHECK so `<main>/.worktrees/B-old` exists.
- Create story B-new (INIT, init-check satisfied or use the same controlled path the existing smoke uses).
- Run the INIT_CHECK bootstrap for B-new with `cwd = <main>/.worktrees/B-old` (the existing worktree).
- ASSERT: the new worktree exists at `<main>/.worktrees/B-new` AND does NOT exist at `<main>/.worktrees/B-old/.worktrees/B-new` (no nesting).
- ALSO run the bootstrap for a second new story B-main from `cwd = <main>` and ASSERT it lands at `<main>/.worktrees/B-main` (byte-identical-from-main).
- The smoke MUST be RED against the pre-fix `--show-toplevel` resolver and GREEN after (capture in transcript-diff.md during TEST).

**package.json wiring**:
- Add `"test:nested-worktree-bootstrap": "node scripts/verify-nested-worktree-bootstrap.mjs"`.
- Chain it into the root `"test"` script string (so root `npm test` / the validate battery runs it). Insert before `test:e2e`.

**Verify**:
- `npm --prefix packages/main run build` exit 0 (no tsc errors).
- `npx tsc --noEmit -p packages/main` exit 0.
- `node scripts/verify-nested-worktree-bootstrap.mjs` passes on the fixed code.
- Manually demonstrate RED-on-old: temporarily revert the resolver call to `getRepoRoot()` and confirm the smoke FAILS with the nested path; restore the fix.
- `lattice validate --story=B-1a12` ALL PASS; root `npm test` runs the new smoke green.

**DoneWhen**:
- resolveBootstrapGitRoot no-gitRoot path resolves the MAIN repo root via --git-common-dir even from a worktree cwd.
- getRepoRoot and resolveWorktreePath are byte-identical (unchanged).
- configured-gitRoot branch still yields the main root.
- New regression smoke asserts non-nested + byte-identical-from-main, is wired into root npm test, and is green.

## CHK-002: Clean the last stale .koala/dev-memory reference in lattice-parallel-wave.md

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: docs/requirements/decisions/lattice-parallel-wave.md

**Approach**:
- At lines ~164/166, change `.koala/dev-memory` → `.lattice/dev-memory`.
- Only change LIVE runtime-path references; leave any historical-record / changelog mentions of `.koala` intact (verify by reading context around each match).
- After edit, grep the file for `koala/dev-memory` and confirm no live runtime-path reference remains.

**Verify**:
- `grep -n "koala/dev-memory" docs/requirements/decisions/lattice-parallel-wave.md` shows no live runtime-path reference (only historical-record context, if any).
- `grep -n "lattice/dev-memory" docs/requirements/decisions/lattice-parallel-wave.md` shows the updated lines.

**DoneWhen**:
- The file references `.lattice/dev-memory` at the previously-stale lines; the last stale runtime-path koala reference is gone.
