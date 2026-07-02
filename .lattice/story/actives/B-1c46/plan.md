# B-1c46 Plan: Runtime Memory Performance Index Optimization

Goal: turn the current correctness-only 1,000,000-record runtime memory path into a proven fast hot path without changing MemoryFreshnessPack semantics. Final user-facing proof is `node packages/main/dist/tasks/playbook-runtime-memory-performance-smoke.js --profile=full --targetWarmMs=2000` passing with recordCount=1000000, parityPass=true, indexedWarmCacheMs<=2000, authority=non_authoritative, and gateEvidence=false.

Non-goals: do not make runtime memory gate evidence; do not modify unrelated README/paper/recovery-runner files; do not claim 1-2s unless the performance smoke passes.

## CHK-001
M0 profile and red baseline. Run the current full-profile benchmark and add profiling fields that identify token matching, pack build, cache hit/miss, index build, and query timings. Record current unmet target as evidence: full profile must show the 1-2s target is not yet proven. This is the red/profile baseline for the optimization.

Acceptance: transcript includes referenceFullScanMs, indexedColdMs, indexedWarmCacheMs, warmCacheHits, peak RSS, profile timing breakdown, and an explicit target status such as unmet when indexedWarmCacheMs > 2000.

## CHK-002
M1 semantic parity guard. Add or strengthen golden cases that compare reference and optimized MemoryFreshnessPack digests for exact token, fuzzy/includes token, superseded suppression, candidate suppression, stale-relevant, stale-irrelevant, deprecated residue, malformed row handling, maxLines, and omittedCount.

Acceptance: parity smoke fails on semantic drift and passes before performance claims are accepted. It must keep authority=non_authoritative and gateEvidence=false.

## CHK-003
M2 exact-token fast path. Replace common matching path with direct tokenToIds exact lookup before any fuzzy fallback. Preserve ordering and cap semantics. Add profile counters for exact hits and fallback use.

Acceptance: M1 parity still passes, full 1,000,000 profile parityPass=true, and indexed cold or token-scan time improves relative to M0.

## CHK-004
M3 bounded fuzzy auxiliary index. Add prefix/trigram/equivalent lookup so includes/fuzzy matching no longer scans every token entry for normal queries. Keep a bounded fallback only for edge cases and report fallback counts.

Acceptance: exact/fuzzy parity still matches reference semantics; profile shows fuzzy index hits/fallbacks; full profile still passes result digest parity.

## CHK-005
M4 persistent cache and prebuilt index lifecycle. Add durable cache or reusable prebuilt index behavior across CLI process boundaries. Bind cache identity to projectRoot, schemaVersion, consumer, normalized query/context, contributing source digests, runtime config digest, consumer policy version, limits, and indexVersion.

Acceptance: first process writes or refreshes the durable cache/index; second process can reuse it; source/config/policy/index changes miss or downgrade safely. Runtime memory remains advisory only.

## CHK-006
M5 performance gate and benchmark report. Add `playbook-runtime-memory-performance-smoke.js` or equivalent. It must run the full profile, verify parity and advisory metadata, report p50/p95 or equivalent repeated-query latency, and fail when indexedWarmCacheMs exceeds targetWarmMs.

Acceptance: `node packages/main/dist/tasks/playbook-runtime-memory-performance-smoke.js --profile=full --targetWarmMs=2000` passes only if indexedWarmCacheMs<=2000 and all semantic/advisory checks pass; otherwise it exits non-zero and says the target remains unproven.

## CHK-007
M6 rollout docs validation and version bump. Create/update `docs/requirements/decisions/playbook-memory-performance-index-optimization-plan.md` with actual implementation, measured before/after numbers, risks, and exact commands. Run build, parity smokes, performance smoke, full baseline, review assurance, DONE, and CLI version bump after merge.

Acceptance: final DONE summary includes exact measured timings and either a proven <=2000ms full-profile hot path or an explicit blocked/report-first statement. No unrelated dirty files are included.
