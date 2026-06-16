# Plan — B-747e: Rename KoalaConfig -> LatticeConfig

## Goal
Rename the project-config interface `KoalaConfig` to `LatticeConfig` (the only Koala* PascalCase
code identifier left). Pure mechanical rename, no behavior change. Ship-clean koala-removal slice.

## CHK-001 — Rename the interface + all references
**Files (5):** config.ts (definition `export interface KoalaConfig`, `DEFAULT_CONFIG: KoalaConfig`,
`_cache: Map<string, KoalaConfig>`, `loadConfig(): KoalaConfig`), dirty-worktree.ts, hooks.ts,
story-signed-workspace-resolution.ts, workflow-policy.ts.
Rename every `KoalaConfig` -> `LatticeConfig`. No backward-compat alias.
**Verify:** `git grep -w KoalaConfig -- packages` returns nothing; `npm run build` (tsc) exits 0;
`npm run test:e2e` exits 0.

## Out of scope
koala.config.json fixtures, koala comments/temp-dir strings, the lab package config reader,
documentation wording, the .koala path layer / LEGACY_KOALA_* constants.
