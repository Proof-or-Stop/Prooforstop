# B-b837 user-acceptance transcript-diff (real machine, 2026-06-23)

PLAN outcome (expected): a maintainer running the residue greps over packages/*/src sees zero
matches except the review-preflight.ts gate wiring (story 4); the residue gate still PASSes; the
build is type-clean.

## Actual (run in worktree .worktrees/B-b837)
- `git grep -nE 'LegacyKoala|KOALA_[A-Z_]+|legacy-koala' -- 'packages/*/src/**/*.ts'` excluding
  handlers/review-preflight.ts and test/smoke files → **0 hits** (only review-preflight.ts gate
  wiring remains, deferred to story 4).
- `node scripts/verify-koala-residue.mjs` → **PASS koala-residue: 0 unclassified**.
- `node scripts/verify-koala-residue.mjs --self-test` → **PASS 5/5**.
- typecheck (`npx tsc --noEmit -p packages/main/tsconfig.json`, asserted) → **exit 0, 0 type errors**.
- `lattice validate` → **PASS** (test-evidence.json written on TEST entry).

## Diff vs expected
No difference. The legacy-koala backward-compat/migration layer is gone from product runtime code;
the only remaining koala in packages/*/src is the review-preflight.ts residue-gate wiring, which is
explicitly story 4 scope. Behavior preserved (concept + quality review lanes: 0 findings; all 47
verificationIntents bound + passing). Migration support for old koala installs is intentionally
dropped per the user's no-compat directive.
