## Trigger Event

User directive (2026-06-18): after B-24c3 (parallel-race timeoutMs bumps for 9 originally-named target smokes + 3 scope-acked emergent victims = 12 bumps total) DONE on main, parallel-load redistribution still surfaced 4 more race victims that did not fit the per-smoke-bump pattern (B-24c3:F-001..F-004 filed as deferred). The user diagnosed this as a convergence-tail problem and asked HOW to actually solve it. Root cause analysis showed serial standalone runs are fast (9-129s wall-time) but parallel runs of the SAME smokes show 2-4x slowdown under 8-worker load — clearly a shared-resource contention (git index locks, fs sync, disk IO, page cache) rather than CPU. User chose simplest viable fix: Plan A — lower the default jobs ceiling so workers do not oversubscribe contended kernel resources.

## Key Insights

- The runner (B-6efb runBoundedRealLeafDispatch) already supports --jobs N; test:coverage (B-c6cf) already uses --jobs 1 successfully. test:all currently uses NO --jobs flag, defaulting to the runner internal worker count cap (likely cpuCount-based ~8).
- The full B-24c3-observed race set is 12 bumped + 4 still-flaky = 16 known-race smokes (the 12 from CHK-001/002 of B-24c3 + the 4 in F-001..F-004). Standalone serial wall-times in the 9-129s range; under 8-worker parallel they balloon 2-4x. CPU is not the bottleneck (OS scheduler would only give ~1.1x slowdown). The actual bottleneck is shared kernel resources (git index/lock, fs syncfs, /tmp throughput).
- N=4 hypothesis: at 4 workers, each gets ~half the contended resource share that 8 workers fight over. Predicted: most/all races disappear at N=4 because the resource bandwidth ceiling is no longer exceeded.
- Wall-clock tradeoff: --jobs 4 doubles parallel wall-clock from ~3min to ~5-6min worst case — acceptable for developer use; test:coverage is unchanged at --jobs 1 for the CI-quality coverage path.

## Solution Tradeoffs

- (a) Plan A (chosen): change root package.json test:all to invoke the runner with --jobs N where N is empirically measured. Single-line script change. Verify N=4 first; if still flaky try N=2. If neither works escalate to Plan B (two-pass retry). Out of scope: no runner changes (B-6efb frozen).
- (b) Plan B: two-pass execution (parallel pass plus serial retry for timeouts). Larger workload, kept in reserve for if Plan A insufficient.
- (c) Full architectural redesign (adaptive pool plus isolation plus retry): 5-10x cost; user explicitly rejected as over-engineered relative to Plan A expected effectiveness.
- (d) Do nothing: accept flaky test:all; treat test:coverage (serial) as CI gold standard. Acceptable but weak OSS-launch story; rejected.

## Conversational Texture

User picked (a) Plan A on 2026-06-18 after explicitly considering (a)/(b)/(c)/(d). Same author also explicitly committed to (b) Plan B as a follow-up story IF Plan A insufficient. Out of scope for THIS story: any runner code change (run-all-smokes.ts B-6efb frozen, runBoundedRealLeafDispatch frozen); any smoke-manifest.json change (B-24c3 just merged); any *-smoke.ts source change. The 4 deferred findings B-24c3:F-001..F-004 are expected to resolve incidentally if Plan A works; otherwise they roll into Plan B scope.
