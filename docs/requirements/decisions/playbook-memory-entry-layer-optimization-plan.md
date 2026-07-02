# Playbook Memory Entry-Layer Optimization Plan

Status: draft execution plan
Related: `playbook-runtime-memory-consumption-execution-plan.md`

## 1. Problem

Proofbound now has verified runtime memory consumption: active playbooks and
dev-memory lessons surface at lifecycle entrypoints, while candidates remain
inert and memory remains `gateEvidence:false`.

The remaining gap is enforcing an operational latency SLO for making this a
normal entry-layer capability. The full 1,000,000-record baseline is valuable as
a correctness proof, but it is not the desired runtime path for `session_brief`,
handoff, story intake, DONE closure, or final-response checks.

## Current Verified Baseline Vs Runtime Target

The current verified 1,000,000-record result is a full reference/profile path,
not the optimized runtime hot path.

| Path | Status | Records | Elapsed | RSS evidence | Meaning |
|---|---|---:|---:|---|---|
| Full reference baseline | PASS | 1,000,000 | 49,347 ms | Run-dependent; see B-1c46 evidence doc | Correctness/profile proof only |
| Indexed small fixture path | PASS | fixture-sized | smoke-level | smoke-level | M0-M2 semantic safety proof |
| Indexed/cached million hot path | PASS | 1,000,000 | warm cache 1 ms | Canonical performance gate peak RSS: 3,610,689,536 bytes; RSS is run-dependent | B-1c46 proves the indexed/cached hot path target; the full reference+index report still takes tens of seconds |

Do not claim that the complete million-record report is sub-second or 1-2
seconds. B-1c46 proves the indexed/cached warm runtime hot path at
1,000,000 records with parity and `indexedWarmCacheMs=1`; it does not make the
reference full scan or index build instant. RSS is not the hot-path latency SLO;
the checklist-bound performance gate records the canonical peak RSS for the full
performance report; other RSS captures are run-dependent and should be read from
the B-1c46 evidence doc.

The full reference baseline is acceptable for full validation. It is not
acceptable for a regular entrypoint that should feel instant to a host starting
work.

## 2. Target Outcome

Make playbook memory a regular Proofbound entry layer:

> Every controlled development entrypoint gets a fresh, bounded, relevant
> memory pack quickly enough to be used by default.

The intended user-facing effect is "development gets smarter" in a precise
systems sense:

- prior lessons are automatically surfaced where forgetting causes mistakes;
- current facts still outrank memory;
- memory remains advisory and cannot satisfy lifecycle gates;
- full-scale baseline proves correctness at 1,000,000 records;
- runtime hot paths use index and cache instead of scanning everything.

This is not a claim that the model weights improve. It is lifecycle-level
institutional memory.

## 3. Non-Goals

- Do not make memory gate evidence.
- Do not let a memory pack prove DONE, review, validation, release, or delivery.
- Do not run the 1,000,000-record baseline on every session start.
- Do not commit generated million-row data to git.
- Do not make ordinary playbooks blocking by default.
- Do not optimize by hiding stale, superseded, malformed, or deprecated records.

## 4. Performance Policy

Separate correctness validation from runtime consumption.

| Path | Purpose | Expected behavior |
|---|---|---|
| Full baseline | Prove 1,000,000-record correctness | May take seconds; release/nightly/manual |
| Small baseline | Fast regression check | Runs in normal validation |
| Runtime entry pack | Normal host entry layer | Uses index/cache; should be fast |
| Health command | Drift and wiring inspection | Reports latency and stale status |

Initial SLO targets:

| Metric | MVP target | Enforce target |
|---|---:|---:|
| `session_brief` memory pack p95 | report-only | <= 1,000 ms |
| handoff memory pack p95 | report-only | <= 1,000 ms |
| DONE/final-response memory pack p95 | report-only | <= 1,500 ms |
| full 1M baseline | report-only | <= 30,000 ms |
| candidate false-surface rate | 0 | 0 |
| stale relevant mutation detection | 100% on fixtures | 100% on fixtures |

Performance thresholds remain report-first for rollout and health. The indexed
runtime hot path now has million-record parity and a passing 2,000 ms target in
B-1c46; enforcement at every lifecycle consumer still belongs to M7/M8 rollout.
Correctness thresholds remain required.

## 5. Architecture

### 5.1 Runtime Index

Add a derived local index for memory/playbook lookup. The index is disposable
and can be rebuilt from source memory files.

Suggested index keys:

| Key | Purpose |
|---|---|
| normalized token -> record ids | Cheap candidate retrieval |
| status -> record ids | Keep candidate/superseded/archived out of hot results |
| consumer -> playbook ids | Entry-specific playbook filtering |
| tag/class -> record ids | Stable recall for host-policy, stale-doc, intent-totality |
| source ref -> record ids | Freshness and mutation attribution |
| digest tuple -> pack cache keys | Fast reuse when inputs are unchanged |

The index is not a proof source. It is a cache of source files. Consumers must
still emit source digests and classify freshness.

Index rebuilds must be atomic. Rebuild writes to a temporary path, validates the
manifest and rebuilt digest, then atomically swaps the active `indexVersion`.
Readers either use the previous complete index or the new complete index; they
must never read a partial rebuild.

### 5.2 Two-Stage Retrieval

Runtime lookup should not score every record.

1. Cheap filter:
   - normalize query/context;
   - retrieve candidate ids from token/tag/status indexes;
   - drop inactive playbooks and suppressed/superseded entries by default;
   - cap candidate set, for example 500-2,000 ids.
2. Precise rank:
   - rank only the candidate set;
   - preserve deterministic ordering;
   - compute contributing source refs;
   - emit bounded top hits.

### 5.3 Pack Cache

Cache `MemoryFreshnessPack` results for unchanged inputs.

Suggested cache key:

```text
hash(
  schemaVersion,
  consumer,
  normalizedQuery,
  normalizedContextClass,
  contributingSourceDigestTuple,
  runtimeConfigDigest,
  consumerPolicyVersion,
  maxTopK,
  maxLines,
  indexVersion
)
```

Cache hit requirements:

- contributing source digest tuple still matches;
- index version still matches;
- consumer policy version still matches;
- result line cap and max top-k match current request.

Cache misses rebuild from indexed candidates, not from a full scan.

Freshness uses two digest classes:

| Digest class | Purpose |
|---|---|
| `broadSourceDigestTuple` | Health, drift, and background refresh detection across full source files. |
| `contributingSourceDigestTuple` | Hot-path cache validity for surfaced rows, suppressed superseded rows, active playbooks, and signature rows that actually contributed to the pack. |

Cache freshness is evaluated against contributing source refs, not only the
broad source digest. Broad source changes that do not affect surfaced or
suppressed contributing rows are `stale-irrelevant`; they may trigger background
refresh or health reporting, but should not punch through the hot-path cache as
a hard miss.

### 5.4 Freshness Semantics

Keep the current freshness distinction:

| Freshness class | Meaning | Runtime behavior |
|---|---|---|
| `fresh` | Surfaced sources still match | Use normally |
| `stale-irrelevant` | Source changed, but not any surfaced/suppressed contributing row | Warn or silently refresh |
| `stale-relevant` | A surfaced or suppressed contributing row changed | Refresh before showing or mark stale |

The implementation must not treat append-only unrelated memory churn as a hard
stale failure.

### 5.5 Entry Consumers

The optimized pack should become the default path for these consumers:

| Consumer | Required memory role |
|---|---|
| `session_brief` | Show bounded Memory Runtime Preflight every normal session |
| handoff create/resume | Preserve host policy and stale-doc lessons across hosts |
| story intake / story advance | Surface repro-first, intent-totality, and stale-doc lessons |
| DONE prepare / closure | Remind host to inspect current facts before completion claims |
| final response check | Prevent wording that sounds stronger than current evidence |

Each consumer must still say memory is advisory and `gateEvidence:false`.

### 5.6 Playbook Status Transition Invalidation

Playbook lifecycle changes must invalidate affected runtime index/cache rows.
This includes `activate`, `archive`, `reject`, `stale`, `supersede`, and any
future transition that changes whether a playbook may surface in runtime
guidance.

Required behavior:

- a candidate that becomes active must become visible after invalidation;
- an active playbook that becomes archived, stale, rejected, or superseded must
  stop surfacing after invalidation;
- candidate playbooks must never leak into runtime packs through stale cache;
- invalidation may be targeted by playbook id and affected consumer class, but
  must be fail-closed if targeting cannot be proven.

## 6. Milestones

| Milestone | Goal | Done when |
|---|---|---|
| M0 Red/profiling baseline | Capture current full-scan latency and hot-path cost | Current 1M baseline and runtime pack timings are recorded |
| M1 Index schema | Define derived index format and rebuild rules | Index can be rebuilt from source files, ignored by git, and atomically swapped without partial reads |
| M2 Indexed retrieval | Replace full-scan hot path with two-stage lookup | Small fixture results match existing runtime pack outputs |
| M3 Pack cache | Reuse unchanged packs safely | Digest/config/index changes invalidate cache; unchanged inputs hit cache |
| M4 Consumer rollout | Wire indexed pack into normal entrypoints | `session_brief`, handoff, story, DONE, final response use optimized path |
| M5 Correctness matrix | Prove active/candidate/superseded/stale/deprecated/malformed behavior | Matrix remains green with optimized runtime |
| M6 Million baseline parity | Prove optimized path still matches reference behavior at 1M scale | Full profile passes with exact 1,000,000 records, gold-query parity against reference full scan, and report-first latency numbers |
| M7 Health and observability | Make latency and cache behavior visible | Health reports index age, cache hit rate, p95 latency, stale counts |
| M8 Rollout policy | Move from report-only to warn/enforce where appropriate | Runtime SLOs are enforced only after correctness and observability are stable |

### M3 Pack Cache Detailed Checklist

- Define cache key over schemaVersion, consumer, normalized query/context,
  contributingSourceDigestTuple, runtimeConfigDigest, consumer policy version,
  max top-k/line cap, and indexVersion.
- Use contributing source refs for hot-path freshness.
- Treat broad source changes that do not affect contributing rows as
  stale-irrelevant or background refresh, not a hard hot-path miss.
- Invalidate cache on source/config/index/policy changes.
- Invalidate affected rows on playbook status transitions: activate, archive,
  reject, stale, supersede.
- Prove unchanged inputs hit cache and changed contributing inputs miss cache.

### M4 Consumer Rollout Detailed Checklist

- Wire optimized indexed/cached pack into `session_brief`.
- Wire optimized indexed/cached pack into handoff create/resume.
- Wire optimized indexed/cached pack into story intake / story advance.
- Wire optimized indexed/cached pack into DONE prepare / DONE closure.
- Wire optimized indexed/cached pack into final response check.
- Keep every consumer advisory-only with `authority=non_authoritative` and
  `gateEvidence=false`.

### M5 Correctness Matrix Detailed Checklist

For both reference and optimized paths, verify:

| Case | Required result |
|---|---|
| active playbook | surfaces when relevant |
| candidate playbook | `candidateFalseSurface=0` |
| superseded memory | suppressed by default and listed |
| stale-relevant mutation | detected as stale-relevant |
| stale-irrelevant mutation | not treated as hard stale |
| deprecated brand residue | detected only as residue, not current guidance |
| malformed row | does not crash |
| line cap | `maxLines` and `omittedCount` preserved |

### M6 Million Baseline Parity Detailed Checklist

- Generate or reuse a deterministic 1,000,000-record baseline.
- Run reference full-scan gold queries.
- Run indexed runtime gold queries.
- Run cached runtime gold queries.
- Compare required IDs, freshness class, candidate false-surface rate,
  supersession suppression, deprecated-term handling, malformed-row behavior,
  `maxLines`, and `omittedCount`.
- Report latency separately for:
  - reference full scan;
  - indexed cold path;
  - indexed warm/cache path.
- Performance SLO remains report-first for rollout; B-1c46 M6 must nevertheless
  prove the indexed/cached million-record hot path is at or below the 2,000 ms
  target before any host may claim the target is met.

## 7. Verification Matrix

| Case | Expected result |
|---|---|
| active playbook | Surfaces in relevant consumers |
| candidate playbook | Never surfaces as active guidance |
| superseded memory | Suppressed by default and listed in suppressed ids |
| stale relevant mutation | Detected and refreshed or marked stale |
| stale irrelevant mutation | Does not create false hard stale |
| deprecated brand residue | Detected only as scanner/test input, not preferred recall |
| malformed memory row | Does not crash runtime pack generation |
| cache hit | Same digest tuple returns same bounded pack |
| cache invalidation | Source/config/index changes invalidate correctly |
| status transition invalidation | Activate/archive/reject/stale/supersede updates affected visibility |
| indexed/full-scan parity | Gold queries match required ids, freshness class, false-surface rate, supersession suppression, deprecated-term handling, and line cap |
| full 1M profile | Correctness pass with exact record count |

Gold-query parity does not require identical top-k order for every non-required
hit. It does require:

- required gold ids are present;
- candidate false-surface rate is 0;
- superseded entries are suppressed by default;
- freshness class matches the reference full-scan path;
- deprecated brand residue is not returned as current guidance;
- malformed rows do not crash either path;
- render line cap and omitted-count semantics match.

## 8. Evidence To Collect

| Evidence | Command or artifact |
|---|---|
| Current full baseline | `playbook-runtime-memory-baseline-smoke --profile=full` |
| Small regression | `playbook-runtime-memory-baseline-smoke` |
| Consumer smoke | `playbook-runtime-memory-mvp1-smoke`, `mvp2-smoke` |
| Health report | `playbook-runtime-memory-health-smoke` or future CLI health command |
| Runtime timing | Per-consumer pack generation timing in health output |
| Cache behavior | hit/miss/invalidate counters |
| Index rebuild | deterministic rebuild digest |
| Reference parity | gold-query comparison between indexed/cached path and full-scan path |

## 9. No-Overclaim Rule

M0-M2 completion means:

- current full reference baseline cost is measured;
- runtime index schema and atomic rebuild are implemented;
- indexed retrieval matches reference behavior on small fixtures.

It does not mean million-record runtime performance is optimized.

M3-M6 completion under B-1c46 means indexed/cached million-record parity is
proven against the reference full-scan path and the indexed warm/cache hot path
meets `indexedWarmCacheMs <= 2000`.

A host may claim "1-2s million-record runtime memory" only for the optimized
warm runtime hot path after the full performance smoke reports
`targetStatus=met`. It must not imply that the complete reference scan,
baseline generation, or index build completes in 1-2 seconds.

## 10. Paper-Framing Note

If this is written into the paper, use bounded language:

> Memory exists is not enough; Proofbound verifies that relevant lessons are
> consumed at the lifecycle entrypoints where forgetting matters.

Do not write:

> The agent becomes smarter.

Safer claim:

> The development loop becomes lesson-aware: prior failures are converted into
> bounded, non-authoritative runtime context, while current evidence remains the
> only source for lifecycle gates.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Fast path diverges from full baseline | Keep full baseline parity tests |
| Cache returns stale lessons | Digest tuple and consumer-policy invalidation |
| Index hides malformed rows | Health command and malformed fixture matrix |
| Memory becomes fake proof | Preserve `gateEvidence:false` and non-gate registry classification |
| Performance work delays correctness | Keep performance report-first until M6 |
| Large index becomes noisy | Cap candidates before ranking and report omitted counts |

## 12. Definition Of Done

This optimization is complete when:

1. runtime entrypoints use indexed/cached pack generation by default;
2. small and full baselines still pass;
3. active/candidate/superseded/stale/deprecated/malformed matrix is green;
4. indexed/cached results have gold-query parity with the reference full-scan
   path;
5. playbook status transitions invalidate affected index/cache rows;
6. health output reports latency, cache, index, and freshness status;
7. performance SLOs are reportable before enforce and enforceable after rollout;
8. documentation states that memory improves attention and process recall, not
   gate evidence or model intelligence.
