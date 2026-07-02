# Playbook Runtime Memory Performance Index Optimization Plan

Status: B-1c46 implemented
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
| M0 profile/red baseline | Full-profile smoke records reference, indexed-cold, warm-cache, target, peak RSS, cache, index, query, and counter timings. | Initial red profile: `indexedWarmCacheMs=2971`, `targetWarmMs=2000`, target unmet. Final baseline exposes `targetStatus=met`. |
| M1 semantic parity guard | Result digests and semantic guard compare reference and optimized `MemoryFreshnessPack` outputs. | Full profile reports matching digest, `semanticParity=pass`, and false-surface rates all 0. |
| M2 exact-token fast path | Runtime index schema v2 adds exact lookup counters and direct token-id selection. | `exactFastPathHits=100` on full M6 report. |
| M3 fuzzy auxiliary index | Runtime index schema v2 adds bounded fuzzy token maps and visible fallback counters. | `fuzzyIndexHits=126`, `fuzzyFallbacks=0`, `tokenScanFallbacks=0` on full M6 report. |
| M4 durable pack cache | Pack cache persists lookup-bound entries under the learning runtime cache and reuses them across processes. | M4 smoke proves `crossProcessCacheHit=true`, `cacheKeyDigest=<sha256>`, and `staleMutationMiss=true`. |
| M5 performance gate | New full-profile performance smoke hard-fails if semantic parity, advisory metadata, or the 2,000 ms target fails. | `node packages/main/dist/tasks/playbook-runtime-memory-performance-smoke.js --profile=full --targetWarmMs=2000` passed with `indexedWarmCacheMs=1`. |
| M6 million-record parity | Full profile compares reference, indexed cold, and indexed warm/cache result digests. | M6 report: 1,000,000 records, matching digest, warm cache at target. |

## 4. Measured Results

Pre-optimization M0 red profile:

| Metric | Value |
|---|---:|
| Records | 1,000,000 |
| Reference full scan | 39,660 ms |
| Indexed cold query path | 10,681 ms |
| Indexed warm/cache hot path | 2,971 ms |
| Target warm latency | 2,000 ms |
| Target status | unmet |
| Warm cache hits | 8 |
| Peak RSS | 1,160,101,888 bytes |

Canonical checklist-bound full baseline evidence:

| Metric | Value |
|---|---:|
| Records | 1,000,000 |
| Reference full scan | 49,347 ms |
| Indexed cold query path | 6,972 ms |
| Indexed warm/cache hot path | 1 ms |
| Target warm latency | 2,000 ms |
| Target status | met |
| Index build | 14,132 ms |
| Warm prime | 11,270 ms |

Canonical checklist-bound performance gate evidence:

| Metric | Value |
|---|---:|
| Records | 1,000,000 |
| Reference full scan | 38,547 ms |
| Indexed cold query path | 6,825 ms |
| Indexed warm/cache hot path | 1 ms |
| Target warm latency | 2,000 ms |
| Target status | met |
| Peak RSS | 3,610,689,536 bytes |

Interpretation: the optimized warm runtime hot path meets the 1-2 second target.
The complete full-profile report still includes generation, reference scan, and
index build work, so it remains a validation path rather than a lifecycle
entrypoint path.

## 5. Verification Commands

```bash
npm --prefix packages/main run build
node packages/main/dist/tasks/playbook-runtime-memory-index-smoke.js
node packages/main/dist/tasks/playbook-runtime-memory-m3-m6-smoke.js
node packages/main/dist/tasks/playbook-runtime-memory-baseline-smoke.js --profile=full
node packages/main/dist/tasks/playbook-runtime-memory-performance-smoke.js --profile=full --targetWarmMs=2000
```

Expected high-signal output:

```text
playbook-runtime-memory M3-M6 smoke passed: TOTAL 8 | PASS 8 | FAIL 0
playbook-runtime-memory performance smoke passed profile=full recordCount=1000000 semanticParity=pass parityPass=true indexedWarmCacheMs=1 targetWarmMs=2000 targetStatus=met authority=non_authoritative gateEvidence=false
```

## 6. Implementation Notes

- `playbook-runtime-memory-index.ts` uses schema v2 with exact token maps plus
  bounded fuzzy token maps. Normal full-profile queries report no token scan
  fallback.
- `playbook-runtime-memory-cache.ts` persists pack cache entries under the
  learning runtime cache. Cache keys bind project root, schema version,
  consumer, normalized query/context, contributing source digests, runtime
  config digest, policy version, limits, and index version. A changed
  contributing source misses; irrelevant broad source churn can downgrade to
  stale-irrelevant.
- `playbook-runtime-memory.ts` accepts a prevalidated runtime index source digest
  tuple for repeated hot-path calls. The full-profile benchmark passes the
  source digests from the just-built index, avoiding repeated million-row source
  digest work before each warm cache hit.
- `playbook-runtime-memory-performance-smoke.ts` is the user-visible gate. It
  exits non-zero unless semantic parity, advisory metadata, and
  `indexedWarmCacheMs <= targetWarmMs` all pass.

## 7. No-Overclaim Rule

Allowed claim:

> The 1,000,000-record indexed/cached warm runtime memory hot path is verified at
> or below the 2,000 ms target with reference parity.

Disallowed claim:

> The entire 1,000,000-record validation report, reference scan, or index build
> completes in 1-2 seconds.

Memory packs are context. They remain non-authoritative and cannot satisfy
lifecycle gates.
