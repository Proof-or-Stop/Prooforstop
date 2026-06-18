# Plan — B-d7c3: B2 collapse test:X-smoke scripts into manifest

## Goal
Mechanically collapse 143 packages/main + 44 root per-smoke npm scripts into
smoke-manifest entries; add `test:legacy` shim; update tracked docs + CHANGELOG.

## CHK-001 — Collapse 143 packages/main scripts
For each entry in packages/main/package.json matching `test:X-smoke` with body
`node dist/tasks/X-smoke.js`:
1. Add a row to packages/main/smoke-manifest.json `smokes` array: `{name: X}` (no tags unless already classified).
2. Delete the npm script entry.

**KEEP** 6 entries: test:e2e, test:run-all-smokes-smoke, test:main-write-lock-coverage,
test:review-convergence-smoke, test:review-incremental-context-smoke, test:docs-drift-smoke.

**Verify:** packages/main test:* count drops from 151 to ~8; `npm run test:all` exits 0 +
aggregate matches the pre-B2 sum of individual smoke results (modulo gap-log preexisting bug).

## CHK-002 — Remove 44 root smoke proxies
For each entry in root package.json matching `test:X-smoke` with body
`npm --prefix packages/main run test:X-smoke`:
1. Delete the npm script entry. (No manifest action needed — already covered by CHK-001.)

**KEEP** the root proxies for the 5 main-test-chain scripts (test:main-write-lock-coverage,
test:review-convergence-smoke, test:review-incremental-context-smoke, test:docs-drift-smoke,
test:e2e) AND test:all AND test:run-all-smokes-smoke (if present at root, it's not).

**Verify:** root test:* count drops from 114 to ~70; `npm test` exits 0 (chain still resolves).

## CHK-003 — test:legacy shim + docs + CHANGELOG
1. Add to root package.json: `"test:legacy": "node packages/main/dist/tasks/run-all-smokes.js --select"`.
   Usage: `npm run test:legacy -- <name>` proxies to `--select <name>`. Verify with
   `npm run test:legacy -- gitroot-cwd-contract` exits 0 + PASS line.
2. Grep tracked docs for `test:<name>-smoke` references (`git grep -nE 'test:[a-z0-9-]+-smoke' -- docs README.md CLAUDE.md AGENTS.md CHANGELOG.md`).
   For each hit in non-historical/non-decision-doc active prose, replace with the
   `npm run test:all -- --select <name>` form OR `npm run test:legacy -- <name>`.
   Historical CHANGELOG entries stay (truthful record).
3. Add CHANGELOG entry: documenting the per-smoke npm-script removal + migration command.

**Verify:** `npm run test:legacy -- gitroot-cwd-contract` exits 0; tracked-doc grep for the
removed names returns only historical contexts; CHANGELOG entry committed.

## Out of scope
- Any *-smoke.ts file
- run-all-smokes.ts, run-all-smokes-smoke.ts
- verify-*.mjs scripts (separate concern — B3 or later)
- test:e2e / cli-e2e
- Decision docs
