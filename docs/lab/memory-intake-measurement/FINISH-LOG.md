# Consolidated Memory and Evidence Intake maintenance

This release integrates the single `memory-intake-measurement` Lab. It consolidates the earlier Memory timing and static AST Labs with four subsequent bounded optimization rounds. Historical records remain bound to their original commits. This maintenance is not formal Story DONE evidence.

## Before and after

Different rows represent different rounds and workloads. Do not add their durations or multiply their percentages. Counts are deterministic fixture observations; wall times are local measurements, not production latency guarantees.

| Repair / workload | Before | After | Evidence / qualification |
|---|---:|---:|---|
| Per-query timer includes actual pack construction | [0, 0] ms | [11, 17] ms | Deterministic clock; 28 ms total, or 33 ms with shared setup. Measurement correctness, not acceleration. |
| Static AST parsing, identical full strict report | 368 parses | 234 parses | Historical five-pair median 1881 to 1692 ms; report bytes equal. |
| Workspace discovery, 20 calls | 605.425 ms; 60 Git | 404.889 ms; 40 Git | Inventory calls 40 to 20, same-call successful reuse. |
| Story hash, first repair, 20 calls | 1500.004 ms; 149 Git | 1127.564 ms; 109 Git | Combined probes; moving-reference freshness retained. |
| Baseline discovery, first repair, 20 calls | 1181.438 ms; 120 Git | 820.228 ms; 80 Git | Same matched ABBA workload. |
| Workspace health | 38/40 | 40/40 | Fix duplicate configuration ownership check and default output budget; no checks removed. |
| Default smoke output | 11252 characters | 9450 characters | 11000 limit preserved; full caller details available with verbose. |
| Memory early warm hit, 2000 records | 198.372 ms | 63.166 ms | Five warm requests: five index builds to zero; all 20 pack digests equal. |
| Story hash, second repair, 20 calls | 1261.677 ms; 109 Git | 1003.911 ms; 89 Git | Conventional candidate avoids unnecessary worktree inventory. |
| Baseline discovery, second repair, 20 calls | 881.457 ms; 80 Git | 661.813 ms; 60 Git | Linked/custom/failure/freshness checks preserved. |
| Memory root discovery, 2000-record warm query | 69.073 ms; 6 Git | 23.714 ms; 2 Git | Operation-local successful root reuse. |
| Memory root discovery, 2000-record cold pack | 439.974 ms; 32 Git | 63.353 ms; 2 Git | Failed probes remain retryable; next operation observes new topology. |
| Cold candidate selection, 5000 records | 2 selections; 10000 fallback record visits | 1 selection; 5000 visits | One complete fallback scan retained; same result used for pack/cache projection. |
| Same single cold query, final fourth-round ABBA | 100.804 ms | 92.078 ms | 8.66% in this run; small timing gain varied across runs. |
| Ten cold batch queries, 5000 records | 382.597 ms; 24 Git; 21 source reads; 20 selections | 92.569 ms; 2 Git; 1 source read; 10 selections | 75.81% measured reduction; full serialized output parity. |
| Ten warm batch queries, 5000 records | 43.433 ms | 21.461 ms | 50.59% measured reduction. |
| Persisted index warm query, 20000 records | 89.213 ms; 5 validations/5 hits | 45.116 ms; 0 validations/5 hits | 49.43%; every hit still reads, hashes exact bytes and JSON.parses independently. |

## Detailed evidence map

All paths below are repository-relative and survive Lab cleanup:

- `docs/lab/memory-intake-measurement/REPORT.md`: original timing defect and deterministic RED/GREEN.
- `docs/lab/static-ast-reuse/`: scanner RED/GREEN, equivalence and invalidation controls.
- `docs/lab/memory-intake-measurement/CONSOLIDATION.md`: complete source ancestry and retired duplicate workspace.
- `docs/lab/memory-intake-measurement/history-repair/REPORT.md`: first discovery/hash repair and historical baseline failures.
- `docs/lab/memory-intake-measurement/round-two/REPORT.md`: 38/40 to 40/40, early cache hit and conventional baseline probes.
- `docs/lab/memory-intake-measurement/round-three/REPORT.md`: root scope, topology/failure boundaries, live sampling limitations.
- `docs/lab/memory-intake-measurement/round-four/REPORT.md`, `abba.json`, `summary.json`: final bottom-layer ABBA and source/commit provenance.

The fourth-round benchmark uses before/after/after/before ordering, fresh child processes, identical valid nonempty data and shared fixture repository conditions. Each version has two cold and ten warm observations per scenario. The baseline is 446351148f; the synchronized measured source is cb71c28d031960f0860d0d546889aff75844936a. The subsequent 1578f0645723989de0e6fbcf2f0e21d6568bc26a only changes three Lab documentation/data files. Later main synchronization and release preparation require fresh functional GREEN; historical timings are not relabelled as measurements of the release commit.

## Preserved behavior and limits

Cache hits retain source/configuration/query freshness and mutation isolation. Persisted validation reuse is process-local and byte-digest bound, with four-entry FIFO and a 32 MiB aggregate serialized-size eligibility budget; it does not retain parsed objects. Same-size/same-mtime tampering, deletion, invalid shape, source change, read failures and eviction remain checked. Batches share one consistent source observation and copy public digest objects. Mixed roots are refused; empty batches make no Git calls.

B-e6d9's 34.98 to 6.29 seconds and 828 equal blocks preceded this Lab and included intake/Git work. It is not a newly delivered pure-parser optimization. JSON.parse was not established as the general Story-query bottleneck. The normal live learning path did not use a persisted index in the sampled checkout; the 20000-record persisted case is an API workload. The remaining 89 Git calls per 20 Story hash queries are not claimed eliminated. A selected eight-CLI sample does not establish fleet-wide cold/fallback frequency. Ordinary single-query warm timing changes in round four mostly track Git noise and are not another claimed optimization.

## Verification and release provenance

The final pre-Finish fourth-round GREEN at 1578f06457 completed in 201047 ms: focused bottom-layer controls, index smoke 9/9, learning store 21/21, workspace 40/40, Memory M3-M6 9/9, complete scanner report parity and all prior failure/freshness controls.

The real scoped Claude CLI review passed without actionable defects, but is not whole-Lab Finish approval. The original whole-Lab provider invocation failed before review because repeated inline diff and file bodies exceeded its context limit. Final integration requires a new exact-candidate managed different-vendor audit and post-merge verification; the tool-owned record and generated CHANGELOG entry identify that candidate and result.

## Finish transport repair

A fresh synthetic transport witness reproduced the context-amplification defect: 3,700,307 input bytes produced a 1,903,210-byte initial prompt. Complete snapshot transport reduces that prompt to 3,225 bytes while preserving the original input digest within each invocation and exact source/diff bytes. A malicious adapter modifying diff.patch is rejected. These counts are from equivalent disposable fixtures; commit timestamps can change input digests across runs. The regression is registered in the existing Lab worktree verifier and the pinned Finish wrapper includes all four prior optimization rounds.

Main synchronization at 0.3.355 preserves both added npm test scripts and all static exception entries. Dependency hashes were refreshed only for merged changed inputs; runtime-verifier source excerpts and line positions reflect its four added continuity assertions. These are local reviewed static records, not vendor audit approval.
