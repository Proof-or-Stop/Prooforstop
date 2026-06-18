## Operator Impact

What's left: even after B-2941 (two-pass retry heals parallel TIMEOUTs) and B-3d39 (DONE-merge race fixed), `npm run test:all` still goes red intermittently because a few known load-sensitive smokes occasionally FAIL (exit 1) rather than time out under heavy parallel load — and B-2941's two-pass retry ("Plan B" — the story that added pass-1 high-concurrency + pass-2 serial-retry-of-timeouts) only covers TIMEOUTs, never FAILs (deliberately, so a real bug is never silently retried to green). What changes: an OPT-IN `retryOnAnyFailure` manifest flag lets a SMALL, documented allowlist of known-flaky smokes also get the serial pass-2 retry on a FAIL, while every other smoke keeps the safe default (a FAIL is a real failure, never retried). This is a documented stopgap; the deeper shared-state root cause stays as a deferred follow-up.

## Trigger Event

User directive (2026-06-18): resolve the deferred parallel-only-FAIL findings B-24c3:F-001..F-004 + B-3d39:F-001. These are smokes (field-regression-cli, verification-freshness, worktree-repair, review-pass-discard) that PASS standalone serial (all four verified exit 0 on 2026-06-18) but intermittently FAIL (exit 1, NOT timeout) under heavy parallel worker-pool load. B-2941's two-pass retry only retries TIMEOUTs, so these load-induced FAILs escape and leave test:all red non-deterministically. User chose option (a): a narrow opt-in allowlist (retryOnAnyFailure) over option (b) root-cause shared-state fixes (deferred).

## Key Insights

- B-2941 added pass-2 serial retry for the subset of pass-1 results with status===TIMEOUT (run-all-smokes.ts). The retry is deliberately NOT applied to FAIL (exit 1) because a FAIL may be a genuine regression — blindly retrying FAILs would silently mask real bugs. That conservative default must be PRESERVED.
- The fix is an OPT-IN escape hatch: a new optional manifest field retryOnAnyFailure (default false). pass-2 retry membership becomes: status===TIMEOUT, OR (status===FAIL AND manifest entry has retryOnAnyFailure===true). Only the explicitly-allowlisted, documented-as-load-flaky smokes get FAIL-retry; everything else keeps FAIL=terminal.
- Allowlist candidates (all verified serial-PASS exit 0 on 2026-06-18, so they qualify as load-flake not real-bug): field-regression-cli, verification-freshness, worktree-repair, review-pass-discard. DEV re-confirms each is serial-stable before flagging it; any candidate that is NOT serial-stable must NOT be allowlisted (it would be a real bug, not a flake).
- This is a STOPGAP, not a root-cause fix. Each allowlist entry risks masking that specific smoke's own future real failure, so each must carry a comment naming the load-flake reason and the entry stays a candidate for the deferred shared-state root-cause story (why these smokes FAIL rather than merely slow under contention — likely shared /tmp, git index, or fixed-port contention).

## Solution Tradeoffs

- (a) opt-in retryOnAnyFailure allowlist (chosen): narrow, safe, preserves FAIL=terminal default for all non-allowlisted smokes. ~30-50 line runner change in run-all-smokes.ts pass-2 membership predicate + manifest field + per-entry flags + self-smoke + docs. Stops the bleeding immediately.
- (b) root-cause shared-state fixes per smoke: thorough but expensive (investigate + fix each smoke's contention) — deferred to a future story.
- (c) retry ALL FAILs (no allowlist): rejected — would silently mask genuine regressions, defeating the point of a CI gate.
- (d) leave as-is: rejected — user wants test:all reliably green so it can gate.

## Conversational Texture

User picked (a) on 2026-06-18 after an explicit assessment that the parallel-only-FAIL was a real-but-low-frequency, intentionally-conservatively-handled gap, and that retrying ALL FAILs is dangerous. The fix keeps Plan B's conservative FAIL=terminal default everywhere except an explicit, documented allowlist. Out of scope: root-cause shared-state fixes for the four smokes (deferred follow-up); --jobs default (B-be91 empirically falsified that lowering worker count fixes the races); on-disk mutex / done-effects / main-write-lock (frozen by their owning stories); test:coverage (B-c6cf, the story that added c8 coverage under --jobs 1 — stays --jobs 1).
