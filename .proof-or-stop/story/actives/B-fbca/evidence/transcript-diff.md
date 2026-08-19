# B-fbca user-acceptance transcript-diff (real machine, 2026-06-24)

PLAN outcome (expected): a maintainer running `git grep -i koala -- 'packages/*/src/**'` sees ZERO
hits (literal zero koala in product runtime source); the renamed lattice-residue gate PASSes
zero-tolerance; tsc clean.

## Actual (worktree .worktrees/B-fbca)
- `git grep -i koala -- 'packages/*/src/**'` → **0 hits** (literal zero; exit 1).
- `node scripts/verify-lattice-residue.mjs` → **PASS lattice-residue: 0 brand residue in product runtime source**; `--self-test` → 7/7.
- `npx tsc --noEmit -p packages/main/tsconfig.json` → exit 0.
- `lattice validate` → PASS (REVIEW→TEST preflight all gates pass incl. the renamed lattice-residue gate + codex verify 7/8).

## Diff vs expected
No difference. packages/*/src is literal-zero koala: all 8 signature salts renamed koala-*→lattice-*
(globally consistent, no signer/verifier mismatch), legacy-koala detection deleted, config
(idleKoala→idleLattice, koala.config.json→lattice.config.json) + .koala/ runtime paths + 4 schema
ids renamed, and the residue gate renamed verify-koala-residue.mjs→verify-lattice-residue.mjs +
flipped to zero-tolerance over SCAN_ROOTS=packages/*/src. Remaining koala lives only in the gate
SCANNER (intrinsically contains the literal to detect it), test fixtures, and docs/ (gate does not
scan docs; separate later story). The salt rename intentionally breaks in-flight stories' old-salt
signatures (user-accepted collateral); old koala config/storage is not migrated (no-compat).
