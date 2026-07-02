# Playbook Runtime Memory Performance Index Optimization Plan

Status: B-1c46 execution baseline
Parent: `playbook-memory-entry-layer-optimization-plan.md`

## 1. Goal

Close M0-M6 for the playbook runtime memory hot path:

- preserve reference/full-scan semantic behavior;
- eliminate normal-query token-map scans from optimized candidate selection;
- persist safe pack cache entries across CLI process boundaries;
- prove 1,000,000-record parity;
- prove the optimized warm runtime hot path is at or below 2,000 ms.

Memory remains `authority=non_authoritative` and `gateEvidence=false`.

## 2. Boundary

This story optimizes runtime memory retrieval. It does not make memory a lifecycle
gate, does not prove DONE, and does not promote rollout enforcement for every
entrypoint. M7 health and M8 rollout remain separate work in the parent plan.

## 3. Milestone Ledger

| Milestone | Implementation | Verification |
|---|---|---|
| M0 profile/red baseline | Full-profile smoke records reference, indexed-cold, and warm-cache timings. | `playbook-runtime-memory-baseline-smoke --profile=full` and performance smoke output expose target status. |
| M1 semantic parity guard | Result digests compare reference and optimized `MemoryFreshnessPack` outputs. | `playbook-runtime-memory-index-smoke` and `playbook-runtime-memory-m3-m6-smoke`. |
| M2 exact-token fast path | Runtime index schema v2 adds exact lookup counters and direct token-id selection. | `exactFastPathHits=100` on full M6 report. |
| M3 fuzzy auxiliary index | Runtime index schema v2 adds bounded fuzzy token maps and visible fallback counters. | `fuzzyIndexHits=126`, `fuzzyFallbacks=0`, `tokenScanFallbacks=0` on full M6 report. |
| M4 durable pack cache | Pack cache persists lookup-bound entries under learning runtime cache and reuses them across processes. | M4 smoke proves `crossProcessCacheHit=true` and contributing mutation miss. |
| M5 performance gate | New full-profile performance smoke hard-fails if parity/advisory metadata/2,000 ms target fails. | `node packages/main/dist/tasks/playbook-runtime-memory-performance-smoke.js --profile=full --targetWarmMs=2000`. |
| M6 million-record parity | Full profile compares reference, indexed cold, and indexed warm/cache result digests. | M6 report: 1,000,000 records, matching digest, warm cache at target. |

## 4. Measured Results

Latest captured full M3-M6 run:

| Metric | Value |
|---|---:|
| Records | 1,000,000 |
| Reference full scan | 50,834 ms |
| Indexed cold query path | 9,231 ms |
| Indexed warm/cache hot path | 1 ms |
| Target warm latency | 2,000 ms |
| Target status | met |
| Result digest | `19e61cac88d5e038e5114c0059eb7b259ba7e8685c04dc7fdd41ed2c63bf1dc8` |
| Warm cache hits | 8 |
| Cache hit rate | 0.500 |
| Index build | 17,290 ms |
| Exact fast-path hits | 100 |
| Fuzzy index hits | 126 |
| Fuzzy fallbacks | 0 |
| Token scan fallbacks | 0 |

Latest captured performance smoke:

| Metric | Value |
|---|---:|
| Records | 1,000,000 |
| Reference full scan | 52,681 ms |
| Indexed cold query path | 9,977 ms |
| Indexed warm/cache hot path | 1 ms |
| Target warm latency | 2,000 ms |
| Target status | met |
| Peak RSS | 3,528,818,688 bytes |
| Exact fast-path hits | 100 |
| Fuzzy index hits | 126 |
| Fuzzy fallbacks | 0 |
| Token scan fallbacks | 0 |
| Index build | 26,241 ms |

Interpretation: the optimized warm runtime hot path meets the 1-2 second target.
The complete full-profile report still includes generation, reference scan, and
index build work, so it remains a validation path rather than a lifecycle
entrypoint path.

## 5. Verification Commands

```bash
npm --prefix packages/main run build
node packages/main/dist/tasks/playbook-runtime-memory-index-smoke.js
node packages/main/dist/tasks/playbook-runtime-memory-m3-m6-smoke.js
node packages/main/dist/tasks/playbook-runtime-memory-performance-smoke.js --profile=full --targetWarmMs=2000
```

Expected high-signal output:

```text
playbook-runtime-memory M3-M6 smoke passed: TOTAL 8 | PASS 8 | FAIL 0
playbook-runtime-memory performance smoke passed profile=full recordCount=1000000 semanticParity=pass parityPass=true indexedWarmCacheMs=1 targetWarmMs=2000 targetStatus=met authority=non_authoritative gateEvidence=false
```

## 6. No-Overclaim Rule

Allowed claim:

> The 1,000,000-record indexed/cached warm runtime memory hot path is verified at
> or below the 2,000 ms target with reference parity.

Disallowed claim:

> The entire 1,000,000-record validation report, reference scan, or index build
> completes in 1-2 seconds.

Memory packs are context. They remain non-authoritative and cannot satisfy
lifecycle gates.
