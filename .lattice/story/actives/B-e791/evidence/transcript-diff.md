# B-e791 real-machine transcript ↔ PLAN-outcome diff

Run with the worktree's freshly-built CLI (`node .worktrees/B-e791/packages/main/dist/cli.js`).

## Expected (understanding.outcome)
> On a wrapper-root project (configured gitRoot resolves), session/next guidance no longer tells the user to `git init` the metadata root; `story_advance INIT_CHECK` prints no `fatal: not a git repository`. Plain non-git projects keep the git-init guidance.

## CHK-001 — guidance (BEFORE vs AFTER)

**BEFORE** (gitReady=isGitRepository(ctx.root) only): on a wrapper-root project the `next`/INIT guidance returned
`...the current project is not a git repository ... first run git init && git add . && git commit -m "init"`.

**AFTER** (B-e791 fixed CLI, wrapper-root fixture: metadataRoot not a git repo, `gitRoot=app` resolves):
```
$ node dist/cli.js next ...
Note: Metadata root is not a git repo; configured gitRoot supplies the signed workspace for git-backed operations.
```
Marker check: **no `git init` instruction** — the guidance is gitRoot-aware. Plain non-git projects with no configured gitRoot keep the byte-identical git-init message (asserted by the smoke via full-string equality).

## CHK-002 — nesting-check quiet (function-level differential)

The dev_start nesting probe (`git rev-parse --abbrev-ref HEAD`) now uses `stdio:['pipe','pipe','pipe']`. The smoke `gitroot-init-guidance-quiet-nesting-smoke.ts` includes a **leak-control differential**: it proves the pre-fix default `execSync` DOES leak `fatal: not a git repository` to stderr on a wrapper-root non-git cwd, while the fixed piped form does NOT — and that a real `worktree-*` branch is still rejected (nesting behavior preserved), and `main` is not rejected (negative control). 7/7 checks pass; `lattice validate` GREEN.

## Diff notes
- **Match.** Wrapper-root users no longer get the misleading "git init the metadata root" guidance, and the spurious `fatal` line no longer leaks; bootstrap behavior, gate semantics, and the nesting rejection are unchanged; plain repos are byte-identical.
- Scope honored: only session.ts + worktree.ts touched; `lattice doctor` (B-1637) untouched.
- This closes the external report's fix #3. (The report's core defect was already fixed in main — separately proven by reproduction; the reporter was on a stale dist.)
- Known follow-up: the smoke isn't in the default validate battery yet (systemic gap owned by backlog story B-99b6).
