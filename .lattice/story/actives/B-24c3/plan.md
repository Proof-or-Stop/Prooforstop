# Execution plan: B-24c3 (9 parallel-race timeout bumps)

## Order
1. **CHK-001** — In `packages/main/smoke-manifest.json`: set `timeoutMs=180000` for the 7 existing entries (gap-log, init-check-fallback, scope-contract, story-capsule, story-create-concurrency, story-metadata-protection, unattended-dispatch); ADD a new entry `{"name":"experience-layer-digest-extract","timeoutMs":180000}`. Verify `run-all-smokes-smoke` self-smoke still passes (dedup check per preMortem D2).
2. **CHK-002** — In `packages/main/smoke-manifest.json`: change `lattice-baseline.timeoutMs` from 240000 to 360000. Verify standalone smoke still passes.
3. **CHK-003** — CHANGELOG Unreleased entry. Run `npm run test:all` 3 times in a row; require all 3 to exit 0 with 162/162 PASS and no FAIL/TIMEOUT for the 9 target smokes.

## Dependencies
- CHK-001 + CHK-002 independent (both edit smoke-manifest.json — combine into one commit).
- CHK-003 last (records final state in CHANGELOG + verifies stability).

## Verify
- `node packages/main/dist/tasks/run-all-smokes-smoke.js` after CHK-001 (dedup check).
- `node packages/main/dist/tasks/lattice-baseline-smoke.js` after CHK-002 (standalone).
- 3× consecutive `npm run test:all` after CHK-003 — all exit 0.
- Per-smoke serial check: any of the 9 named smokes that fail when run alone is a real regression (not in scope).

## Out of scope (explicit)
- `packages/main/src/**` — production AND smoke source code OFF LIMITS
- `packages/main/src/tasks/run-all-smokes.ts` + `run-all-smokes-smoke.ts` — B-6efb frozen
- `scripts/verify-koala-residue.mjs` — B-292d frozen
- `package.json` — no new test:* scripts
- review-pass-discard parallel-only FAIL — separate problem class (race, not timeout); file finding + split to follow-up story
- Any smoke not in the 9-name list — leave untouched
