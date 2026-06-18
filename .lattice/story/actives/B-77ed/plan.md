# Execution plan: B-77ed (migrate hand-rolled metadata locks to withMkdirLock)

## Order

1. **CHK-001** — Migrate the 3 hand-rolled metadata-lock loops to the shared `withMkdirLock` primitive.
   - `packages/main/src/handlers/finding.ts` `withReviewPassLock` (~line 38): replace the `mkdirSync`/`deadline = Date.now()+5000`/`sleepSync(50)` loop + the `try/finally rmSync` release with `return withMkdirLock(lockDir, fn, { label: 'review-passes metadata' });`. Keep `lockDir = ctx.store.storyFilePath(storyId, 'review-passes.lock')`.
   - `packages/main/src/handlers/review-run.ts` `withReviewRunLock` (~line 21): same, `label: 'review-runs metadata'`, lock path `review-runs.lock`.
   - `packages/main/src/handlers/init-check.ts` `withInitCheckLock` (~line 67): same, `label: 'init-check metadata'`, lock path `init-check.lock`. Note this one takes `store: StoryStore` not `ctx` — `store.storyFilePath(...)` stays.
   - Add `import { withMkdirLock } from '../core/mkdir-lock.js';` to each. Remove each file's now-unused local `sleepSync` (and unused `mkdirSync`/`statSync`/`rmSync` imports if they become dead — verify with build).
   - The `fn()` body (read-modify-write of the metadata JSON + `autoCommitStoryMetadata` git commit) is passed UNCHANGED into `withMkdirLock`. Commit stays inside the critical section.
   - Pass ONLY `{ label }` — rely on `withMkdirLock` defaults (deadlineMs 30000, staleMs 10000, pollMs 50, no `failFastIfHeld`) so the wait-and-poll semantics match the old loops, only with the correct 30s budget and the deadline>staleMs invariant satisfied.
   - Build clean (0 tsc errors).

2. **CHK-002** — Prove the fix, then retire the B-348d stopgap flags.
   - Build, then stress each of the 4 previously-flagged smokes (`field-regression-cli`, `verification-freshness`, `worktree-repair`, `review-pass-discard`) by invoking the smoke binaries DIRECTLY at high concurrency (no two-pass runner, i.e. equivalent to `--no-retry`), with concurrent filler load, for >= 24 total runs. Capture exit codes. Expectation: 0 FAIL.
   - If all pass: remove `"retryOnAnyFailure": true` from those 4 entries in `packages/main/smoke-manifest.json`.
   - If any smoke still FAILs under load: KEEP its flag, record a finding documenting the residual sub-cause, and note it in CHANGELOG/docs.

3. **CHK-003** — CHANGELOG + docs.
   - `CHANGELOG.md` Unreleased: describe the lock migration (5s->30s, invariant restored, ~60 lines de-duped) + the stopgap retirement with the empirical proof.
   - `docs/dev/test-coverage.md` Retry policy section: update to state the 4 smokes no longer need `retryOnAnyFailure` (root cause fixed, not stopgapped). Keep the `retryOnAnyFailure` mechanism documented as a general safety net.

## Key safety invariant

`withMkdirLock` is reused unchanged; the migration must not pass `failFastIfHeld` (that would convert wait-and-poll into fail-fast). Removing a `retryOnAnyFailure` flag is gated on per-smoke heavy `--no-retry` stress showing 0 FAIL — a real regression in any smoke must still turn the suite red.

## Verify

- `grep -c "Date.now() + 5000" packages/main/src/handlers/{finding,review-run,init-check}.ts` -> 0 each.
- Each handler imports and delegates to `withMkdirLock`.
- Build clean (tsc 0 errors); the 4 smokes pass standalone.
- Heavy `--no-retry` stress: 0 FAIL across >= 24 runs.
- `grep -c retryOnAnyFailure packages/main/smoke-manifest.json` -> 0 (or documents any kept flag).
- The existing `assertReviewPassConcurrentCliSurface` (5 concurrent review_run_start + review_pass_set) is the standing regression test.

## Out of scope (explicit)

- The `withMkdirLock` primitive itself (reused, not rewritten).
- The `retryOnAnyFailure` mechanism / run-all-smokes two-pass runner (B-2941 frozen) — only the 4 flags are retired.
- `main-write-lock` (B-3d39 frozen); moving git commits out of lock critical sections.
