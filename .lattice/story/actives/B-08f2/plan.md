# Plan — B-08f2: Eliminate the KOALA_* env-var layer (ship-clean)

## Goal
No KOALA_* env var remains in code/config/wrapper-assets/hook-docs/tests, with no koala fallback.
First substantive story of the ship-clean koala-removal program.

## Two operations
- **17 twin vars** (LATTICE_* already exists, dual-read): delete the `|| process.env.KOALA_X`
  fallback (e.g. registry.ts:289, cli-validate.ts:7). Vars: ACTIVITY_LOG, AUTHORITY_*, DIR,
  GLOBAL_MEMORY_DIR, MD_TEMPLATE, PROJECT_ROOT, REPAIR_IGNORE, RUNTIME_IGNORE_BLOCK_START/END, STORY_DIR.
- **38 KOALA-only vars** (no twin): rename `KOALA_X` -> `LATTICE_X` across reads AND setters,
  JSON configs, .Codex/.claude wrapper assets, and hook-contract docs (docs/guide-hooks.md).

## Out of scope (excluded)
LEGACY_KOALA_* path constants in core/lattice-paths.ts, .koala/ runtime dirs, docs/koala/framework-audit
(active), koala.config.json/markers, experiments/, CHANGELOG/history.

## CHK-001 — Rename/de-fallback across source, config, assets, hook docs
68 source/config/asset files (81 of the 98 hits are in packages/main/src). Drop fallback for the 17
twins; rename the 38 KOALA-only. Keep behavior identical. **Verify:** `npm run build` exits 0.

## CHK-002 — Update tests/smoke fixtures asserting KOALA_* names
30 test/smoke files. Update current-name assertions to LATTICE_*; do NOT rewrite recorded historical
fixtures. **Verify:** `npm run test:e2e` + affected `test:*` suites pass.

## CHK-003 — Drop docs/koala/legacy + residual-scan gate
git rm -r docs/koala/legacy/ (12 files, 0 code refs; framework-audit KEPT). **Verify:**
`git grep -E 'KOALA_[A-Z]' -- packages scripts bin .Codex .claude docs/guide-hooks.md` returns nothing;
`npm run build` + `npm run test:e2e` pass.
