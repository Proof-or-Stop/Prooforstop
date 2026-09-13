# Fourth intake repair round: candidate, batch and persisted-index work

The user requested all three bottom-layer repairs, RED/GREEN and Claude CLI review in the same Lab. Local main was synchronized before the repair. Baseline is 446351148f; final measured candidate is cb71c28d031960f0860d0d546889aff75844936a. No integration into main or push is performed.

## Final before/after results

| Scenario | Before | After | Reduction (negative means slower) |
|---|---:|---:|---:|
| 5000 records, one cold query | 100.804ms | 92.078ms | 8.66% |
| 5000 records, ten cold batch queries | 382.597ms | 92.569ms | 75.81% |
| 5000 records, ten warm batch queries | 43.433ms | 21.461ms | 50.59% |
| 20000 records, persisted-index warm query | 89.213ms | 45.116ms | 49.43% |
| 20000 records, persisted-index cold query | 138.684ms | 124.135ms | 10.49% |
| 5000 records, ordinary warm control | 25.971ms | 20.353ms | 21.63% |

Counts are the performance acceptance oracle: one cold query selects candidates 2 → 1 times and performs one complete overflow scan rather than two identical scans. A ten-query cold batch uses Git 24 → 2 times, reads the same source file 21 → 1 times, and selects candidates 20 → 10 times. Five warm persisted-index calls perform full canonical index validation 5 → 0 times. File bytes are still read and SHA-256 checked on every call, and JSON is parsed to return an independent object. JSON parsing is not eliminated.

Ordinary warm hits retain two Git probes per query and have no targeted speedup in this round. Earlier ABBA samples showed small slowdowns; the refreshed sample shows improvement dominated by Git time (24.69 → 19.39ms per query). It is a control, not a claimed optimization. Host variance also affects the single-cold total. Deterministic counts prove removal of duplicate work, while the table reports the last complete dataset without claiming production p95 or all-path speedups.

## Measurement provenance

`node scripts/lab/measure-memory-bottom-up.mjs OUTPUT` executes actual baseline modules against current dependencies and current candidate modules in before/after/after/before order. Each scenario uses one isolated ordinary Git fixture shared by its four arms. Each arm starts a fresh process and clears only its fixture cache. The single/batch scenarios contain 5000 validated source records; the persisted scenario contains 20000. Batch timing covers all ten queries including shared preparation, not per-query timings measured after assembly. Each arm records one cold call/group and five warm calls/groups; there are two cold and ten warm observations per version/scenario. Index creation for batch/persisted setup is excluded; ephemeral cold construction is included.

Source/dist binding is checked before and after the run. Imported baseline source digests, deterministic counts and individual timings are retained in abba.json. Complete serialized pack-array digests match across every arm and cold/warm repetition, with nonempty query results asserted. Each query's source digests, result order, context, rendering and freshness fields are part of this comparison; no selective ID-only comparison is substituted. Previous exploratory measurements remain outside the worktree, including the initial object-clone implementation which showed a cold-cost penalty. Only the final candidate dataset above is claimed as final performance evidence.

## Minimal repairs and safeguards

1. A per-pack cache context owns a candidate observation. Both result assembly and cache projection use it. New cache lookup clears old observations and cache storage discards the temporary observation; query/context changes cannot borrow a previous request's selection. Complete overflow scans, ordering, supersession and active-playbook matching stay intact.
2. The batch owns an explicit successful learning-root scope. Child packs inherit it only in that batch; ordinary nested scopes remain fresh by default. A fresh shared source digest snapshot is passed through index selection, cache checks and returned packs. Returned source-digest objects are copied per pack to prevent mutation aliases. New batches re-observe sources; stale supplied indexes follow the existing rebuilding/fallback path. Failed root probes remain uncached and retryable.
3. Persisted-index validation stores a small process-local map of file-content SHA-256 validation records. It does not retain a parsed index graph. Every read hashes the actual complete Buffer, then parses an independent object; unchanged bytes can reuse successful canonical validation under the current module's validator. A new module/process has an empty memo, so validator-version changes cannot inherit an old process record. Missing, unreadable, invalid and changed content clear/bypass the old record. The map has a four-entry limit and a 32MiB summed serialized-domain eligibility budget. These are internal optimization records, not signed process evidence or Story credentials.

Focused controls cover uncached/batched parity, single overflow completeness, next-batch source mutation, mixed roots, empty batches, returned pack/index mutation isolation, same-size/same-mtime index tampering, deletion, invalid JSON shape, read failure recovery and FIFO memo eviction. The real index smoke checks fuzzy and overflow candidate parity. All prior learning-root, Memory M3–M6, workspace, hash failure/freshness, scanner and timing controls remain inside the new pinned wrapper.

## RED, GREEN and independent review

The managed RED command is `node scripts/lab/verify-intake-round-four.mjs`, with BOTTOM_UP_RED at 446351148f. It reproduces all three families: selections 2 vs 1; batch Git 24 vs 2, reads 21 vs 1 and selections 20 vs 10; persisted validations 5 vs 0. The command runs the actual implementation, not a synthetic failure marker. See managed-red.json.

GREEN replays that exact executable/argv on the final committed candidate, with strengthened boundary checks and the previous three-round verification wrapper. Final tool-owned GREEN is exported outside Git after the committed run. The requested Claude CLI audit uses the repository's managed `lab:worktree audit memory-intake-measurement --developer codex` route after GREEN, with a verdict bound to the exact candidate and full Lab diff. Its actual outcome is likewise exported outside Git to avoid a self-referential approval commit. No prior audit is relabelled as approval of these new repairs.

The existing EX-MEMORY-QUERY-TIMING scanner binding is refreshed for the reviewed source changes and the clock test's synchronous scope stub. All timing assertions remain unchanged. No scanner exception or admitted invocation was added. The strict scanner still compares complete reports and requires one parse per exact input, retaining the original scanner optimization.

These are local Lab maintenance records, not formal Story DONE or a release.

## Latest-main reconciliation before Claude review

The first audit dispatch did not start Claude because main advanced to b07b6e9fbf (0.3.353) during GREEN. Main was merged locally into this Lab. Memory repair source files had no conflicts. The scanner manifest had 38 hash-only conflicts plus one additive-entry conflict; both sides’ existing records were retained, including all pre-existing IDs/multiplicities. Forty retained bindings were refreshed only for the version-only package.json/package-lock.json changes (main-sync-bindings.json). A new build and the full ABBA measurement above use the synchronized candidate. Previous measurements and pre-sync GREEN remain historical artifacts outside the worktree. Fresh GREEN and Claude review must bind the final synchronized commit.
