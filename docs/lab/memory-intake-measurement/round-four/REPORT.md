# Fourth intake repair round: candidate, batch and persisted-index work

The user requested all three bottom-layer repairs, RED/GREEN and Claude CLI review in the same Lab. Local main was synchronized before the repair. Baseline is 446351148f; final measured runtime candidate is 8429c09eb3. No integration into main or push is performed.

## Final before/after results

| Scenario | Before | After | Reduction (negative means slower) |
|---|---:|---:|---:|
| 5000 records, one cold query | 96.310ms | 94.003ms | 2.40% |
| 5000 records, ten cold batch queries | 444.640ms | 107.835ms | 75.75% |
| 5000 records, ten warm batch queries | 49.798ms | 27.271ms | 45.24% |
| 20000 records, persisted-index warm query | 103.849ms | 54.383ms | 47.63% |
| 20000 records, persisted-index cold query | 159.718ms | 149.270ms | 6.54% |
| 5000 records, ordinary warm control | 31.061ms | 33.484ms | -7.80% |

Counts are the performance acceptance oracle: one cold query selects candidates 2 → 1 times and performs one complete overflow scan rather than two identical scans. A ten-query cold batch uses Git 24 → 2 times, reads the same source file 21 → 1 times, and selects candidates 20 → 10 times. Five warm persisted-index calls perform full canonical index validation 5 → 0 times. File bytes are still read and SHA-256 checked on every call, and JSON is parsed to return an independent object. JSON parsing is not eliminated.

Ordinary warm hits retain two Git probes per query and have no targeted speedup in this round. Their final timings vary from roughly 26 to 41ms by arm; the measured mean is slightly slower and must not be presented as an improvement. The small single-cold timing gain in the final sample is reported as observed, despite the deterministic elimination of duplicate selection. Batch and persisted warm gains are larger. These are shared-host microbenchmarks, not whole-CLI or production p95 promises.

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

The existing EX-MEMORY-QUERY-TIMING scanner binding is refreshed for the reviewed source changes and the clock test's synchronous scope stub. All timing assertions remain unchanged. No scanner exception or admitted invocation was added. The strict scanner still compares complete reports and preserves the prior 368 → 234 exact-input parse count result.

These are local Lab maintenance records, not formal Story DONE or a release.
