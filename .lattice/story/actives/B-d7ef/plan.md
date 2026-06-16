# Plan — B-d7ef: Remove orphans + 2 truly-dead modules (OSS hygiene v2)

## CHK-001 — Delete 'orphans' junk file
`git rm orphans` (5 bytes, "NO -"). Verify: `git ls-files orphans` returns nothing.

## CHK-002 — Delete 2 truly-dead modules
`git rm` packages/main/src/core/phase-protocol.ts, packages/main/src/verifier/bridge-utils.ts.
Each has 0 static imports, 0 dynamic/path consumers, 0 external symbol uses (verified).
Verify: modules gone; `git grep` for their basenames in static imports + dist/dynamic-import + fixture
execute strings returns no live consumer; intent-coverage.ts STILL present; `npm run build` +
`npm run test:e2e` pass.

## Out of scope (excluded)
intent-coverage.ts (live via fixture dynamic import), verifier/dev-cli.ts (serve launcher), the OMX
disable guard, .codex/.Codex consolidation, .lattice gitignore (OSS-export step), lab, experiments.
