# B-6048 Execution Plan: Playbook Memory M3-M6 Optimized Runtime Path

## Scope

Complete only M3-M6 from `docs/requirements/decisions/playbook-memory-entry-layer-optimization-plan.md`:

- M3 pack cache with freshness-safe invalidation.
- M4 optimized indexed/cached advisory packs wired into lifecycle consumers.
- M5 reference-versus-optimized correctness matrix.
- M6 deterministic 1,000,000-record indexed/cached parity report with report-first latency.

Out of scope: M7/M8, enforce-mode rollout, making runtime memory gate evidence, or claiming 1-2s million-record runtime performance before M6 produces the parity report.

## Shared Invariants

- Runtime memory is advisory only: `authority=non_authoritative` and `gateEvidence=false` in every consumer and smoke assertion.
- Current structured facts outrank memory. Memory may prompt checks, but it cannot prove REVIEW/TEST/DONE/release status.
- The optimized path must preserve reference semantics before any performance statement.
- Performance thresholds are report-first; correctness parity is blocking.

## CHK-001

M3: implement pack cache with freshness-safe invalidation.

Implementation:

- Add a shared cache helper for `MemoryFreshnessPack` results.
- Cache key covers schema/version identity, consumer, normalized query/context, contributing source digest tuple, runtime config digest, consumer policy version, top-k/line cap, and index version.
- Treat contributing source changes as hard misses; broad unrelated source changes are stale-irrelevant/background refresh, not a hard hot-path failure.
- Invalidate on source/config/index/policy/limit changes and playbook status transitions.

Verification:

- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/playbook-runtime-memory-m3-m6-smoke.js`

Expected transcript includes cache hit, cache miss, stale-irrelevant behavior, and `authority=non_authoritative gateEvidence=false`.

## CHK-002

M4: roll indexed/cached memory packs into lifecycle consumers.

Implementation:

- Route session brief, handoff create/resume, story intake/story advance, DONE prepare/closure, and final response checks through the same optimized advisory pack path where those consumers build runtime memory.
- Keep consumer policy explicit so a consumer cannot upgrade memory into gate proof.
- Preserve bounded render limits and omitted counts.

Verification:

- `node packages/main/dist/tasks/playbook-runtime-memory-m3-m6-smoke.js`
- `lattice session_brief` should continue to render Memory Runtime Preflight with non-authoritative metadata.

Expected transcript shows consumer rollout coverage while memory remains advisory.

## CHK-003

M5: add reference-versus-optimized correctness matrix.

Implementation:

- Add a matrix that compares reference full selection with optimized indexed/cached selection.
- Cover active playbooks, candidate false-surface zero, superseded suppression, stale-relevant mutation, stale-irrelevant mutation, deprecated brand residue classification, malformed row tolerance, line cap, and omitted count.
- Ensure malformed rows do not crash either path.

Verification:

- `node packages/main/dist/tasks/playbook-runtime-memory-m3-m6-smoke.js`

Expected transcript lists each matrix case as PASS for reference and optimized paths.

## CHK-004

M6: prove million-record indexed/cached parity with report-first latency.

Implementation:

- Generate or reuse a deterministic 1,000,000-record baseline.
- Run reference full-scan gold queries, indexed runtime gold queries, and cached runtime gold queries.
- Compare required ids, freshness classes, candidate false-surface rate, supersession suppression, deprecated-term handling, malformed-row behavior, maxLines, and omittedCount.
- Report `referenceFullScanMs`, `indexedColdMs`, and `indexedWarmCacheMs` separately with `performancePolicy=report-first`.

Verification:

- `node packages/main/dist/tasks/playbook-runtime-memory-baseline-smoke.js --profile=full`
- `node packages/main/dist/tasks/playbook-runtime-memory-m3-m6-smoke.js`

Expected transcript includes `recordCount=1000000` and latency fields, but does not claim 1-2s million runtime unless the report itself proves it.
