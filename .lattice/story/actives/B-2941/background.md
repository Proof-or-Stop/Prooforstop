## Trigger Event

User directive (2026-06-18): npm run test:all exit code is unreliable on main — same code, same command, different runs produce 159/167, 162/167, 165/167 with different smokes timing out each time (autopilot-run, cli-json-stdout-contract, review-pass-discard, worktree-repair, etc rotate as victims). This makes test:all unusable as a CI gate. After B-24c3 (per-smoke timeoutMs bumps + 9 stabilized but 4 deferred findings) and B-be91 (Plan A cap --jobs N empirically falsified), the consistent finding is: every individual smoke passes standalone serial, but parallel runs flake unpredictably. Plan B = two-pass retry: pass 1 high-concurrency, pass 2 serial retry for any smoke that timed out. Since every smoke passes in --jobs 1 mode, retry effectively converts "timed out under load" into "passed on retry", giving test:all a stable exit 0 that OSS-launch CI consumers can trust. This story unlocks the "test:all is your CI gate" promise.

## Key Insights

- Empirical falsification data from B-be91:F-001 + B-24c3:F-001..F-004 + the 2026-06-17/18 baseline triage runs proves: zero failing smokes in single-process serial mode; every parallel failure has been a timeout (B-24c3 + this story scope) or a shared-state-race FAIL of review-pass-discard (handled by a single noRetry override). No production bug is concealed by retry.
- The runner (B-6efb run-all-smokes.ts) currently has a single execution pass. Adding a second pass requires un-freezing run-all-smokes.ts narrowly for two-pass logic only; the worker pool, manifest reader, and CLI flag parser remain untouched.
- The retry pass uses the same DefaultProviderExecutor seam — only the worker-pool size argument changes (forced to 1). This keeps the retry behaviorally identical to test:coverage's --jobs 1 mode that already exits 0 reliably (B-c6cf).
- The smoke-manifest.json schema needs one optional new field: noRetry?: boolean — for smokes where retry would mask a real regression (none today, but the operator escape hatch matters; the field is documented as "always-retry" override OFF by default).

## Solution Tradeoffs

- (a) Two-pass retry in the runner (chosen): pass 1 default jobs (8); pass 2 forces --jobs 1 for the subset of timeouts (and FAIL exits when a single smoke is flagged noRetry=false explicitly — covers review-pass-discard FAIL pattern). Single execution path; no manifest churn for the 9 B-24c3 smokes; preserves CHANGELOG / CI promises. Workload: ~80-150 lines runner change + new self-smoke + docs.
- (b) Retry from outside the runner via npm script: cat output, find TIMEOUT lines, re-spawn with --select. Rejected — fragile string parsing, no shared state between passes, no clear stop signal.
- (c) Make the runner adaptive (track timeouts, dynamically lower jobs): rejected as overengineered relative to two-pass. Plan A (just lower jobs) already disproved that worker count alone fixes anything.
- (d) Accept the flake: rejected — defeats the purpose of OSS-launch CI gating.

## Conversational Texture

User picked (a) two-pass retry on 2026-06-18 after explicit consideration of why Plan A failed (cap --jobs N falsified) and why per-smoke timeoutMs bumps converge but never finish (B-24c3 tail). User stressed this is critically important and must be solved, with an explicit commitment to running the full Lattice workflow. Scope: unfreeze run-all-smokes.ts narrowly for two-pass logic; add noRetry? optional field to smoke-manifest schema; update run-all-smokes-smoke.ts with retry-behavior cases; CHANGELOG + docs/dev/test-coverage.md update. Out of scope: any production code (handlers/, core/, providers/, cli-engine.ts, cli-prompts.ts); existing per-smoke timeoutMs values (B-24c3 frozen); any *-smoke.ts source other than self-smoke; --jobs default (stays at runner cpuCount default); test:coverage script (B-c6cf frozen). Plan A's B-be91:F-001 stays as the falsification record — not retracted, just superseded by Plan B's different mechanism.
