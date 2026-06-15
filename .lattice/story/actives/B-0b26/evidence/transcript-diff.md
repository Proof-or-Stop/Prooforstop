# B-0b26 — Real-machine user-acceptance transcript & diff

**Commit under test:** `4f7d7be25` (story/B-0b26)

## Expected (PLAN outcome)
`ls packages/` shows only `lab main utils`; `git ls-files` no longer lists any of the five
deleted paths; `git ls-files jek.md` still lists jek.md; `npm run build` and `npm run test:e2e`
both exit 0.

## Actual (observed)
```
$ ls packages/
lab main utils 

$ git ls-files | grep -E 'cli-guess-number|python-demo|python-rps|du.exe.stackdump|claude-session.mjs' | wc -l
0          # zero — all five deletion targets gone from the index

$ git ls-files jek.md
jek.md          # jek.md kept (user-owned, OQ/decision-doc protected)

$ npm run build   → exit 0
$ npm run test:e2e → exit 0 (story-lifecycle 5 steps + gap-convergence 4 steps, ALL PASS)
$ lattice validate → exit 0, 25/25 verification intent coverage
```

## Diff (expected vs actual)
No gap. packages/ contains exactly lab/main/utils; the five dead paths are gone from git and disk;
jek.md survives; build, e2e, and validate are all green. Over-deletion guards (packages/lab,
experiments/, CLAUDE.md/README.md/AGENTS.md/CHANGELOG.md, bin/lattice.js) all confirmed intact.

## User-value self-check
- Does the user see the intended result? Yes — a tidier repo: only real product packages remain.
- Run on a real machine from the user's perspective? Yes — ls/git/build/e2e in the story worktree.
- Residual of old behavior? No — 0 residual references to the deleted paths (only an acceptable
  historical claude-session.mjs note in docs/metadata/task.json and a coincidental .tmp-claude-session
  string in claude-cli.ts:58).
- User-owned file protected? Yes — jek.md explicitly kept per the user's decision and decision-doc rule.
