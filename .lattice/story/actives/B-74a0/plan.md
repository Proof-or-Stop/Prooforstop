# B-74a0 Plan

## Goal

Extract the command catalog and schema-only command definitions from `packages/main/src/cli-engine.ts` while keeping all command behavior, help output, handler registration, lifecycle dispatch, parser behavior, owner gates, and Authority semantics unchanged.

## Boundaries

Allowed:
- Create catalog/schema modules under `packages/main/src/cli/`.
- Keep `MAIN_TOOLS` and `ToolDef` available from `packages/main/src/cli-engine.ts` as compatibility exports/imports.
- Add a focused command catalog smoke and package script.

Excluded:
- Moving `parseFlags`, help rendering, alias normalization, root/worktree resolution, owner lease gates, reviewer gates, lifecycle special dispatch, `runCli`, or INIT_CHECK metadata sync.
- Changing command names, handler registry behavior, process-fact semantics, or host runtime semantics.
- Any Authority Server production completion claim.

## CHK-001 Extract Command Schema And ToolDef Definitions

Implementation:
- Move `ToolDef` and schema-only helper definitions currently used only to build command schemas into `packages/main/src/cli/command-schemas.ts` or the catalog module.
- Import required prompt constants, type constants, and contract schemas from their existing sources.
- Re-export or import `ToolDef` from `cli-engine.ts` so existing consumers keep compiling.

Verification:
- `npm --prefix packages/main run build`.
- Representative help output for `story_create --help`, `story_advance --help`, `validate --help`, and `authority_receipt_verify --help` still includes expected arguments and required markers.
- Confirm `cli-engine.ts` no longer owns the moved schema block, but still exposes compatible symbols.

## CHK-002 Extract MAIN_TOOLS Command Catalog Assembly

Implementation:
- Move the `MAIN_TOOLS` array assembly into `packages/main/src/cli/main-tools.ts` or `packages/main/src/cli/command-catalog.ts`.
- Keep command ordering stable.
- Leave runtime `TOOLS = MAIN_TOOLS` and `extraTools` merge behavior in `cli-engine.ts` untouched except for importing the built-in catalog.

Verification:
- A focused smoke compares the exported command name set/order and checks representative commands exist.
- Ensure no duplicate command names are introduced.
- Ensure catalog text does not reintroduce Gemini as a current host.

## CHK-003 Verify Command Catalog Behavior And Contracts

Implementation:
- Add `packages/main/src/tasks/command-catalog-smoke.ts` and `test:command-catalog-smoke` in `packages/main/package.json`.
- Smoke should import `MAIN_TOOLS` through `../cli-engine.js` to protect the compatibility facade.
- Smoke should run after build and fail if representative help output loses required schema/help guidance.

Verification commands:
- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:command-catalog-smoke`
- `node scripts/verify-process-fact-contract.mjs`
- `node bin/lattice.js validate --story=B-74a0 --json`

## Multi-Host Notes

B-74a0 is the dependency source for the other cli-engine split stories. Keep this first slice narrow enough that Claude Code CLI and Antigravity CLI can work on sibling parser/runtime/lifecycle slices after this catalog boundary lands. Local host verdicts are diagnostic only unless backed by verified Authority receipts.
