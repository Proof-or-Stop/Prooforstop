# Plan: B-40eb koala residual full sweep

## Overview
Option A (semantic-full + extend branding gate). The decision boundary is the B-3cca `cli-engine-branding-smoke.ts` classification rule: **keep** process-lane names / legacy alias `'koala'` / `.koala` runtime paths / `LEGACY_KOALA` / `KOALA.md` / salts; **clean** all user-readable branding (comments / `@title` / CLI prose / errors / prose / brand function names / `mkdtemp` prefixes). Batch order: lab -> utils -> scripts -> main src -> main tests -> root docs; run `lattice validate` + `npm run test:e2e` after each batch. Story 4 separately extends the branding gate audit scope to full active scope as a permanent verify gate.

## CHK-001 Precise classification + whitelist
PLAN completed the inventory: active-scope `git grep -liI koala` excluding the file-level whitelist (decisions / CHANGELOG / docs-story / framework-audit / jek.md) = 266 candidates; after the B-3cca branding rule, **272 files / 1655 lines** are unclassified (real brand). Whitelist (documented exceptions): process-lane names `koala-(codex|review*|implementer|reviewer|eval*|delivery|init|agent|story*)`, legacy alias `'koala'`, `.koala` runtime paths, `LEGACY_KOALA*`, `KOALA.md`, salts `koala-*-integrity-v1`, decisions / CHANGELOG / docs-story history, test-assertion intent `assertNotContains(...,'koala')`.
- Method: a perl replica of the branding `isClassified` rule generates the must-change list (`/tmp/branding_filter.pl`, verified).
- userSees: must-change list of 272 files / 1655 lines, visible by directory (main-src 81 / main-tests 128 / scripts 39 / lab 11 / docs-utils-root 13).

## CHK-002 packages/lab branding
`lab/src/core/*.ts`, `handlers/lab.ts`, `tool-defs.ts`, `profiles/*.ts` `@title` / comments / errors / CLI prose `koala-lab` -> `lattice-lab` (11 files / 28 lines).
- Coordinate with B-ed70: **do not** change `lab/package.json` description (its CHK-001) nor the `.Codex` line in `src/core/config.ts` (its CHK-002).
- userSees: `git grep koala-lab packages/lab` leaves only B-ed70's two spots; `npm --prefix packages/lab run build` passes.

## CHK-003 packages/main src branding
`packages/main/src/**` source comments / CLI prose / brand function names (e.g. `runKoalaFromCwd` -> `runLatticeFromCwd`) koala branding -> Lattice, excluding `.koala` runtime paths, process-lane names, salts. Update all references when renaming.
- userSees: branding rule over `packages/main/src` leaves 0 must-change; `npm run build` exits 0 and related smokes pass.

## CHK-004 scripts branding
`scripts/*.mjs` (39 files / 324 lines) koala branding / comments -> Lattice, keep `.koala` path references.
- userSees: branding rule over `scripts` leaves 0 must-change; the `verify-*.mjs` still pass.

## CHK-005 test smoke/fixtures judgment
`packages/main/tests` + `src/tasks/*-smoke.ts` + fixtures: line-by-line judgment.
- **Keep**: `assertNotContains(...,'koala...')` (lattice-only-absence-smoke), cli-engine-branding-smoke rule regexes, koala.config.json "is ignored" assertion fixtures.
- **Change**: `runKoala*` function names, `mkdtemp 'koala-*'` prefixes, non-assertion @title / comment branding, load-semantics koala.config.json fixtures -> lattice.config.json.
- userSees: `npm run test:e2e` all pass; branding rule over tests leaves 0 must-change.

## CHK-006 root-doc prose
`CLAUDE.md` (docs/koala/reviewer-redesign.md path ref, keep or update), `docs/guide.md` (Koala/Lattice prose), `README.md` (prose after excluding `.koala` paths), `packages/utils/**` (5 files / 10 lines).
- userSees: root docs + utils branding rule leaves 0 must-change.

## CHK-007 Acceptance gate
`git grep -in koala -- packages scripts README.md CLAUDE.md docs/guide.md` after the B-3cca rule leaves **0 unclassified**; `lattice validate` all-green; `npm run build` exits 0; `npm run test:e2e` all pass.
- Note: the permanent extended branding gate is built by **story 4** (extend the cli-engine-branding-smoke audit scope to full active scope + wire into `lattice validate`).
