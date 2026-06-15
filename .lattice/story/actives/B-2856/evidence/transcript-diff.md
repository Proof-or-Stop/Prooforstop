# B-2856 Transcript Diff (real-machine / user-perspective)

## Expected

In a wrapper-root project (metadataRoot is NOT a git repo; the real repo is a
configured gitRoot subdir), `lattice story_discard`, `lattice validate --channel`,
and `lattice validate --concept` should run git against the resolved gitRoot and
succeed, instead of failing with `fatal: not a git repository`. In a plain repo
(metadataRoot == gitRoot) behavior should be byte-identical (cwd == projectRoot).

## Actual

Real git child processes, exercised by the committed smoke against real temp
fixtures (`npm run test:gitroot-cwd-routing`):

```text
$ node packages/main/dist/tasks/gitroot-cwd-routing-smoke.js
✓ resolveGitCwd: wrapper→gitRoot, plain→projectRoot, unresolved/throws→fallback
✓ validate-channel: readers get gitRoot (wrapper) / projectRoot (plain); gate semantics unchanged
✓ validate-concept: diff + repo-wide grep get gitRoot (wrapper) / projectRoot (plain); semantics unchanged
✓ cluster-sync: git log main..HEAD runs against gitRoot (wrapper) / projectRoot (plain), no fatal
✓ worktree story_discard: branch -D / branchExists run against gitRoot (wrapper) / projectRoot (plain), no fatal
✓ gitroot-cwd-routing smoke passed (wrapper-root + plain-repo)   [29 assertions]

$ node bin/lattice.js validate --story=B-2856        # channel + concept gates
  ✓ ALL PASS   (ran with no "fatal: not a git repository")

$ node .lattice/story/actives/B-2856/evidence/verify-b-2856.mjs
  TOTAL 40 | PASS 40 | FAIL 0  (buildOk=true smokePass=true cwdOnly=true cmdTextChanged=0)
```

The wrapper-root fixture asserts the EXACT cwd of each rerouted git op equals the
gitRoot subdir (not the metadataRoot) — so a wrong-tree regression fails the
assertion. The plain-repo fixture asserts cwd == projectRoot (byte-identical).

## Diff

Expected and actual match. The original `fatal: not a git repository` failure
mode for wrapper-root layouts is gone; plain repos are unchanged. The change is
cwd-only (no git command text altered; `cmdTextChanged=0`).

## Scope note

Bug 1 (git cwd) only. Bugs 2/3/4 from the ClawCreek report (atomic bootstrap;
`.lattice` track/ignore data-loss; lint change-scope) are deferred to separate
stories. The out-of-scope bootstrap `git add` in worktree.ts is left on root.
