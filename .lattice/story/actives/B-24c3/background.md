## Trigger Event

User directive (2026-06-18): after B-6745 (lattice-p5fix session, merged 2026-06-17 23:13) stabilized the headline P5 authority/baseline smoke failures, npm run test:all still surfaces 9 parallel-only timeouts on subsequent runs (different smokes time out on different runs depending on system load). Serial standalone runs of all 9 PASS cleanly in 9-129s, confirming the failures are purely worker-pool race / parallel-load slowness, not real bugs. Goal: bump per-smoke timeoutMs in packages/main/smoke-manifest.json so test:all parallel exits 0 consistently across runs without weakening any smoke logic.

## Key Insights

- The 9 timeouting smokes ALL pass standalone (serial wall-times: experience-layer-digest-extract 15s / gap-log 19s / init-check-fallback 12s / scope-contract 9s / story-capsule 9s / story-create-concurrency 21s / story-metadata-protection 12s / unattended-dispatch 12s / lattice-baseline 129s). Of the 9, seven are already present in packages/main/smoke-manifest.json at the default 60s timeoutMs (gap-log, init-check-fallback, scope-contract, story-capsule, story-create-concurrency, story-metadata-protection, unattended-dispatch); experience-layer-digest-extract is NOT yet present in the manifest (discovered by the runner via directory-scan, runs at the default 60s) and must be ADDED with timeoutMs=180000; lattice-baseline is already at 240s (set by B-2d6c) yet still times out at 240s under heavy parallel load (~2x slower than standalone).
- Pattern is identical to B-2d6c CHK-002 and B-6745 CHK-002: parallel worker-pool load amplifies per-smoke runtime; raising per-smoke timeoutMs to a finite measured ceiling (never infinity) is the standard, no-production-change fix.
- review-pass-discard FAILED (exit 1) at 14.6s under parallel mode on the same run but PASSED in 33s standalone — this is a different category (NOT a timeout; possibly shared-state race or transient). OUT OF SCOPE for this story; file finding and defer to a follow-up.

## Solution Tradeoffs

- (a) per-smoke timeoutMs bumps (chosen): minimal scope, mirrors B-2d6c CHK-002 / B-6745 CHK-002 pattern, tests-only edits to packages/main/smoke-manifest.json. Bump 8 entries from default 60s to 180s; bump lattice-baseline from 240s to 360s. Workload: ~1 commit + verify 3x parallel runs all green.
- (b) Make the runner adaptive (increase timeout dynamically when other slow smokes are running concurrently): out of scope; would require changes to run-all-smokes.ts which is contract-frozen.
- (c) Skip the parallel-race smokes entirely (skip:true in manifest): unacceptable — loses real coverage; rejected.
- (d) Investigate root cause of why some smokes are 2x slower under parallel load: useful long-term but expensive for now; defer.

## Conversational Texture

User picked option (a) on 2026-06-18. Same pattern as B-2d6c and B-6745 — pure manifest timeoutMs bump, test/config-only, 0 production change, no smoke logic changed, no assertion weakened. Out of scope: review-pass-discard parallel-only FAIL (file finding, follow-up); run-all-smokes.ts (B-6efb frozen); any production code (no path under packages/main/src/handlers/ or core/). After DONE on main, 3 consecutive npm run test:all should all exit 0 with 162/162 PASS.
