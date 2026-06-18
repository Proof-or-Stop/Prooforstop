# Execution plan: B-be91 (Plan A — cap test:all default --jobs)

## Order
1. **Pre-CHK-001 empirical measure**: Run `npm run test:all -- --jobs 4` 3× in worktree. If all 3 exit 0 with 166/166 → lock in N=4. If any flake → run 3× at `--jobs 2`. If N=2 still flakes → file finding, escalate to Plan B story.
2. **CHK-001**: Edit root `package.json` `scripts.test:all` from `node packages/main/dist/tasks/run-all-smokes.js` to `node packages/main/dist/tasks/run-all-smokes.js --jobs <measured-N>`. Single-line script edit.
3. **CHK-002**: CHANGELOG Unreleased entry under Test infrastructure subsection (describe --jobs cap rationale + measured N + manual override path). Update `docs/dev/test-coverage.md` to note: test:all now defaults to `--jobs <N>` for reliability; manual override via `npm run test:all -- --jobs 8`.
4. **CHK-003**: Final 3× consecutive `npm run test:all` (using the NEW capped default — no explicit flag). All 3 must exit 0 with 166/166 PASS and no FAIL/TIMEOUT for the 4 previously-flaky smokes (review-pass-discard / field-regression-cli / verification-freshness / worktree-repair).

## Dependencies
- Pre-CHK-001 measurement determines the value used in CHK-001.
- CHK-001 must come before CHK-002 (CHANGELOG cites measured N).
- CHK-003 last (verifies the new default).

## Verify
- After CHK-001: `node -e "console.log(require('./package.json').scripts['test:all'])"` shows the new value.
- After CHK-003: 3 consecutive `npm run test:all` exit 0.

## Out of scope (explicit)
- `packages/main/src/tasks/run-all-smokes.ts` — B-6efb frozen
- `packages/main/smoke-manifest.json` — B-24c3 frozen
- Any `*-smoke.ts` source
- `test:coverage` script (B-c6cf frozen at --jobs 1)
- Plan B (two-pass retry) — separate follow-up story if Plan A fails
- Plan C (architecture redesign) — explicitly rejected as over-engineered
