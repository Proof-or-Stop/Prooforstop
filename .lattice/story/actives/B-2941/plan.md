# Execution plan: B-2941 (Plan B — two-pass retry)

## Order
1. **CHK-001** — Unfreeze `packages/main/src/tasks/run-all-smokes.ts` narrowly: add `--no-retry` flag parsing; after pass 1 completes, compute timeout set (status=TIMEOUT, exclude entries with manifest.noRetry=true); if empty → exit pass 1 result (today behavior); else log `Pass 1: X/N passed; M timeouts → retrying serially...`, then run pass 2 by re-invoking the same worker logic with forced --jobs 1 and select=<timeout names>; final output: `Pass 2: K/M passed; Final: (X+K)/N passed in T s`; exit 0 iff Final passed equals total. Rebuild dist.
2. **CHK-002** — Add `noRetry?: boolean` optional field to smoke-manifest schema (no entry uses it on initial landing). Update `packages/main/src/tasks/run-all-smokes-smoke.ts` with 4 new fixture cases: (a) pass 1 timeout → pass 2 retry → PASS; (b) noRetry=true smoke that times out stays TIMEOUT in Final; (c) --no-retry CLI flag disables pass 2 entirely; (d) smoke fails BOTH passes → counts as Final FAIL. Verify self-smoke 13/13 (or new total).
3. **CHK-003** — CHANGELOG Unreleased entry under Test infrastructure subsection. Update `docs/dev/test-coverage.md` to note two-pass + --no-retry override + noRetry manifest field. Final: 3× consecutive `npm run test:all` all exit 0 with Final 167/167 PASS — including previously flaky review-pass-discard / field-regression-cli / verification-freshness / worktree-repair.

## Dependencies
- CHK-001 before CHK-002 (self-smoke fixture cases need the runner two-pass logic).
- CHK-002 before CHK-003 (CHANGELOG describes the final shape including noRetry field).

## Verify
- After CHK-001: `node packages/main/dist/tasks/run-all-smokes.js --no-retry --select gitroot-cwd-contract` shows today behavior.
- After CHK-002: `node packages/main/dist/tasks/run-all-smokes-smoke.js` shows 13/13 (or higher) checks passed.
- After CHK-003: 3× `npm run test:all` all exit 0.

## Out of scope (explicit)
- `packages/main/src/{handlers,core,providers}/` + `cli-engine.ts` + `cli-prompts.ts` — production OFF LIMITS
- `package.json` — test:all script unchanged
- Existing per-smoke timeoutMs values (B-24c3 frozen)
- Any `*-smoke.ts` source other than self-smoke
- `--jobs` default (stays at runner cpuCount)
- `test:coverage` script (B-c6cf frozen at --jobs 1)
