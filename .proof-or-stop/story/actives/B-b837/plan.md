# Plan — B-b837: Delete the legacy-koala backward-compat/migration layer (ship-clean story 2)

## Goal & scope
Remove the legacy-koala backward-compat and migration logic from product runtime code
(`packages/*/src`), no compat shims kept, while keeping tsc/build green, the `packages/main`
test suite green, and `scripts/verify-koala-residue.mjs` still PASS.

Out of scope (other stories / kept history): renaming `koala-<role>` lane tokens (story 3);
scrubbing `docs/`,`experiments/`,`scripts/` and flipping the residue gate incl. the
`KOALA_RESIDUE_*` wiring in `handlers/review-preflight.ts` + `scripts/verify-koala-residue.mjs`
(story 4); `.lattice/story` audit metadata (kept as history).

## CHK-001 — Remove the legacy activity-log archive reader and its path constant
`core/activity-log.ts`: remove `getMigratedLegacyKoalaActivityLogPath()` and stop merging the
legacy archive into the activity tail (return only `.lattice/activity.jsonl`). `core/lattice-paths.ts`:
remove `LATTICE_LEGACY_KOALA_ACTIVITY_LOG`. `core/runtime-artifact-registry.ts` and
`core/stale-detector.ts`: remove the `activity.legacy-koala.jsonl` references.

## CHK-002 — Remove the KOALA_ env-var compat fallbacks
`core/usage-ledger/dispatch-usage.ts`: drop the `KOALA_HARD_BUDGET_TOKENS` fallback (LATTICE_ only).
`core/usage-ledger/writer.ts`: drop the `KOALA_USAGE_LEDGER` alias. `core/dispatch-runner.ts`:
remove `'KOALA_'` from the env passlist.

## CHK-003 — Remove legacy-koala write-path detection and old-artifact cleanup
`core/lattice-paths.ts`: remove `containsLegacyKoalaDir()` + `assertNoLegacyKoalaWritePath()`.
`core/prewrite-guard.ts`: remove `isLegacyKoalaWritePath()` + its filter. Adjust callers
`core/config.ts` and `handlers/dev-memory.ts` (drop the assert calls). `core/managed-assets.ts`:
remove `isGeneratedLegacyKoalaAgentPrompt()`, the `koala:internal` `LEGACY_INTERNAL_SECTION_RE`,
the `koala-*.md` handling, and the `legacy-koala-extra` asset entry.

## CHK-004 — Collapse koala-or-lattice dual-accept to lattice-only
`core/managed-assets.ts` `INIT_DOC_SECTION_RE`: `(?:koala|lattice)` → `lattice` only. Sweep any
other `(?:koala|lattice)` dual-read in product src (e.g. `claude-md-sync.ts`).

## CHK-005 — Tests and verification green
Delete/retarget tests asserting the removed compat (e.g. `tasks/storydir-inside-gitroot-suite.ts`
legacy assertions, managed-assets koala-*.md tests). Then verify:
`npm --prefix packages/utils run build && npm --prefix packages/main run build` (tsc clean);
`npm --prefix packages/main test` (suite green); `node scripts/verify-koala-residue.mjs` (still PASS);
`git grep -nE 'LegacyKoala|KOALA_[A-Z_]+|legacy-koala' -- 'packages/*/src/**/*.ts'` minus the
review-preflight.ts gate wiring → zero.

## Risk control
Per-edit, re-run the residue gate + targeted tests. The guard removals
(`assertNoLegacyKoalaWritePath`) only ever threw for legacy koala paths that no longer exist, so
dropping them is behavior-preserving for all live paths. Full suite + a `lattice session_brief`
smoke before `dev_finish`.
