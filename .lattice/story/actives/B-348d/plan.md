# Execution plan: B-348d (opt-in retryOnAnyFailure allowlist)

## Order
1. **CHK-001** — In `run-all-smokes.ts`: add `retryOnAnyFailure?: boolean` to `ManifestEntry`. Extend the pass-2 membership predicate (line ~257-260) from `r.status === 'TIMEOUT'` to `r.status === 'TIMEOUT' || (r.status === 'FAIL' && byName.get(r.name)?.retryOnAnyFailure === true)`. Keep the `noRetry !== true` exclusion. Optionally reword the Pass-1 log from "N timeout(s)" to "N retryable failure(s)". `--no-retry` still short-circuits. Build.
2. **CHK-002** — In `smoke-manifest.json`: set `retryOnAnyFailure: true` on the 4 verified candidates (field-regression-cli, verification-freshness, worktree-repair, review-pass-discard). RE-VERIFY each serial-PASS (`node packages/main/dist/tasks/<name>-smoke.js` → exit 0) before flagging; drop any that is not serial-stable.
3. **CHK-003** — Add self-smoke fixtures: (a) a smoke that always FAILs WITH retryOnAnyFailure:true → retried in pass 2; (b) a smoke that FAILs WITHOUT the flag → NOT retried (default preserved). CHANGELOG Unreleased entry + docs/dev/test-coverage.md. Run self-smoke + 3× test:all.

## Key safety invariant
The pass-2 predicate gates FAIL-retry on `retryOnAnyFailure === true`. For every smoke WITHOUT the flag, a FAIL stays terminal exactly as B-2941 left it — so a genuine regression in any non-allowlisted smoke still turns the suite red. The negative self-smoke case (b) is the proof.

## Verify
- Build clean (tsc 0 errors).
- self-smoke green incl both new cases.
- Each of the 4 allowlisted smokes serial-PASS exit 0.
- 3× `npm run test:all` — deterministically green (the 4 load-flake smokes now retry-on-FAIL).
- Over-reach: no core/handlers production; only Unreleased CHANGELOG; only the 4 flagged in manifest.

## Out of scope (explicit)
- Root-cause shared-state fixes for the 4 smokes (deferred follow-up)
- `--jobs` default (B-be91 falsified)
- on-disk mutex / main-write-lock / done-effects (frozen)
- test:coverage (B-c6cf frozen, --jobs 1)
- retrying ALL FAILs (rejected — masks real regressions)
