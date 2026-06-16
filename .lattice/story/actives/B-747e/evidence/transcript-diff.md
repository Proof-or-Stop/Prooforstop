# B-747e — Real-machine transcript & diff

**Commit:** `8dfabdbe1` (story/B-747e)

## Expected (PLAN outcome)
`git grep -w KoalaConfig -- packages` prints nothing; `interface LatticeConfig` is in config.ts;
`npm run build` and `npm run test:e2e` exit 0.

## Actual (observed)
```
$ git grep -w KoalaConfig -- packages          → (empty)  — zero KoalaConfig identifiers
$ git grep -nw 'interface LatticeConfig' packages/main/src/core/config.ts
   packages/main/src/core/config.ts:26:export interface LatticeConfig {
$ git grep -nE 'type KoalaConfig|as KoalaConfig' -- packages  → (empty)  — no compat alias
$ git diff --stat (impl commit)                → 5 files, 20 insertions(+) / 20 deletions(-)
$ npm run build                                 → exit 0 (tsc)
$ npm run test:e2e                              → exit 0, ALL PASS
$ lattice validate                              → PASS, 12/12 verification intent coverage
```

## Diff (expected vs actual)
No gap. The KoalaConfig interface is fully renamed to LatticeConfig across its definition and 4
consumers — a pure identifier swap (20/20), build + e2e green, no behavior change, no backward-compat
alias. Over-reach guards held: only the 5 core type files changed; koala.config.json fixtures, the
lab package, and comments/prose were untouched (deferred to later residual-sweep slices).

## User-value self-check
- Does the user see the result? Yes — `KoalaConfig` is gone from the codebase; `LatticeConfig` is the project-config type.
- Real-machine? Yes — grep/build/e2e/validate in the story worktree.
- Residual? Note: a now-dead `/\bKoalaConfig\b/` regex remains in cli-engine-branding-smoke.ts (out of scope, harmless) — flagged for a later slice.
