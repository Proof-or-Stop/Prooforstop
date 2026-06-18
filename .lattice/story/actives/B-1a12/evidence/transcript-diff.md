# B-1a12 Real-Machine Transcript + Diff

Story: Fix INIT_CHECK worktree bootstrap resolving the current worktree instead of the main repo root (nested .worktrees) + clean last stale .koala doc ref.

## PLAN outcome (expected)

Running `lattice story_advance INIT_CHECK` for a NEW story while cwd/root is inside an existing
worktree creates the new worktree directly under the MAIN repo root at `<main>/.worktrees/B-new`
(NOT nested at `<main>/.worktrees/B-old/.worktrees/B-new`). Running from the main repo root is
byte-identical to before. The new regression smoke is RED against the pre-fix `--show-toplevel`
resolver and GREEN after; it runs in `lattice validate` / root `npm test`. And
`docs/requirements/decisions/lattice-parallel-wave.md` shows `.lattice/dev-memory` with no stale
`.koala/dev-memory` runtime-path reference remaining.

## Actual (observed on this machine)

### Regression smoke red → green (the core proof)

The smoke `scripts/verify-nested-worktree-bootstrap.mjs` pins the worktree handler's metadata
`root` to a linked worktree via `--root <oldWorktree>` — the faithful reproduction of the
from-worktree-cwd condition (the B-a4e3-style incident where root resolved to a worktree). It then
bootstraps a NEW story and asserts the new worktree is NOT nested, plus a from-main byte-identical
assertion.

**RED (pre-fix resolver — `resolveBootstrapGitRoot` no-gitRoot path reverted to `getRepoRoot()`):**

```
$ # temporarily: if (!configuredGitRoot) return getRepoRoot();  + rebuild
$ node scripts/verify-nested-worktree-bootstrap.mjs
Error: from-worktree-root bootstrap must create the new worktree under the MAIN repo at
  /var/.../lattice-nested-worktree-TFeWsV/.worktrees/B-4263
  (nested at /var/.../lattice-nested-worktree-TFeWsV/.worktrees/B-977d/.worktrees/B-4263? true)
RED_EXIT=1
```

The new worktree was created NESTED at `<main>/.worktrees/B-977d/.worktrees/B-4263` — the exact bug.

**GREEN (fix in place — `resolveMainRepoRoot()` via `git rev-parse --git-common-dir`):**

```
$ node scripts/verify-nested-worktree-bootstrap.mjs
nested-worktree bootstrap verified:
  from-worktree-root -> /var/.../lattice-nested-worktree-crhq9L/.worktrees/B-e4fb
    (not /var/.../lattice-nested-worktree-crhq9L/.worktrees/B-2867/.worktrees/B-e4fb)
  from-main -> /var/.../lattice-nested-worktree-crhq9L/.worktrees/B-1655
GREEN_EXIT=0
```

The new worktree lands at `<main>/.worktrees/B-e4fb` (NOT nested); from-main lands at
`<main>/.worktrees/B-1655` (byte-identical-from-main path shape). Source restored + rebuilt;
`git status` clean afterwards.

### Real-world self-avoidance evidence

This story's OWN INIT_CHECK bootstrap was run from the MAIN repo root and produced the worktree at
`/Users/jek/Documents/Work/Orchestrate/.worktrees/B-1a12` — NOT nested (verified: no
`.worktrees/<other>/.worktrees/B-1a12` exists). That is the from-main path which is byte-identical.

### Smoke in the validate battery

Root `npm test` ran the full battery to `✓ ALL PASS` (NPM_TEST_EXIT=0), including the new
`test:nested-worktree-bootstrap` step which printed the non-nested + from-main result inline
(battery log line ~558-561). package.json chains `npm run test:nested-worktree-bootstrap` before
`npm run test:e2e` in the root `test` script.

### Doc cleanup

```
$ grep -n koala/dev-memory docs/requirements/decisions/lattice-parallel-wave.md   # 0 matches
$ grep -n lattice/dev-memory docs/requirements/decisions/lattice-parallel-wave.md # shows .lattice/dev-memory
$ grep -n "KOALA_GLOBAL_MEMORY_DIR\|legacy fallback" ...                          # 0 matches
```

The Dev-memory Boundary prose was further corrected (REVIEW F-001) to factually match
`dev-memory.ts`: single canonical project store (no read-only legacy fallback — removed in B-a4e3),
global override env var `LATTICE_GLOBAL_MEMORY_DIR` (not `KOALA_GLOBAL_MEMORY_DIR`), default
`~/.lattice/dev-memory/experience.jsonl`.

## Diff: expected vs actual

No diff. Actual matches the PLAN outcome exactly: non-nested from-worktree, byte-identical
from-main, RED→GREEN regression in the battery, and the doc reference cleaned (and made factually
correct).

## User-value 5-question self-check

1. Does the user see the promised outcome? Yes — from a worktree cwd, the new worktree lands under
   `<main>/.worktrees/`, not nested.
2. Edge cases? from-main (byte-identical), configured-gitRoot/wrapper-root (unchanged, resolves
   main root via signed-workspace metadata), git-throw / non-`.git` common dir (falls through to
   `getRepoRoot()` — never worse than today).
3. Real-machine run done? Yes — smoke run directly (RED reverted-build + GREEN restored-build) and
   inside the full root `npm test`.
4. Honest about gaps? No unresolved TODOs. getRepoRoot non-bootstrap caller (resolveWorktreePath)
   confirmed unchanged.
5. Would a fresh user accept it? Yes — the nested-bootstrap failure mode is eliminated and guarded
   by a battery regression.
