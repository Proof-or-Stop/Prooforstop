# Third intake repair round: operation-scoped learning-root discovery

This continues the single Lab-memory-intake-measurement. Main was synchronized at d788f9adaf (0.3.352). Nothing is integrated into main or published.

## Measured comparison

| Controlled ordinary Git fixture | Before | After | Deterministic result |
|---|---:|---:|---|
| 2000 records, warmed query mean | 69.073ms | 23.714ms | Git 6 → 2 per query; index builds remain zero |
| 2000 records, cold pack mean | 439.974ms | 63.353ms | Git 32 → 2; index builds remain one |
| 5000 records, warmed query mean | 68.590ms | 24.421ms | Git 6 → 2 per query; index builds remain zero |
| 5000 records, cold pack mean | 464.339ms | 94.622ms | Git 32 → 2; fallback 2 → 2 |
| Story hash, 20 calls | 89 Git children | 89 Git children, implementation unchanged | Call sources inspected; no additional hash reduction claimed |

The warm reductions are 65.67% and 64.40%; cold reductions are 85.60% and 79.62%. These are shared-host, bounded module comparisons, not whole-CLI or production p95 guarantees. The 2000-record before cold observations were 484.497ms and 395.451ms, illustrating timing variance. Cold and warm numbers represent different paths and must not be added.

`measure-learning-scope.mjs` uses actual baseline bbefc8adec source modules and candidate 9bf03ba3f66bd147fb352059b7cdd990fe4c41ec, in before/after/after/before order. Each arm runs in a fresh process against one shared isolated ordinary Git fixture, clears that fixture's durable pack cache, measures one cold pack, then five warm packs. Two arms per version provide two cold and ten warm observations. Four Memory/learning modules come from the old commit for the before arm; other dependencies remain current. Import/transpilation is excluded. Source/dist bindings are checked before and after. Full serialized warm packs equal their prime, all 20 result digests agree across arms for each fixture, and nonempty result sets are asserted. Both datasets contain valid source records.

## Repair and boundaries

`withLearningRootScope` creates a fresh map for one synchronous Memory pack operation and restores the previous scope in finally. Successful observations are keyed by exact discovery origin; each subsequent pack starts fresh. No process-lifetime root memo, moving-ref cache, source digest omission or scan cap change is introduced. Any failed Git probe prevents storing that observation, including a successful fallback after an earlier failure. Non-Git and transient-failure paths deliberately remain retryable and are not promised the 6 → 2 bound.

Coverage proves nonempty pack parity, ordinary and linked worktrees, separate-git-dir, distinct origins, transient Git failure then recovery inside a scope, cleanup after an exception, nested scope restoration, and new-operation topology discovery. Existing source mutation, disabled cache, explicit/persisted index, durable hit, M3–M6, workspace, hash freshness, scanner and timing controls remain in the pinned wrapper.

## RED and GREEN provenance

Managed RED is recorded at bbefc8adec: `node scripts/lab/verify-intake-round-three.mjs` fails with `LEARNING_SCOPE_RED`, observing 6 instead of the required 2 Git children. The first attempted RED was rejected because a test compared omitted undefined fields before reaching the target; it is not counted as RED. The accepted witness compares serialized packs. Subsequent test strengthening uses a valid nonempty record and canonical temporary-root spelling; the subprocess threshold is unchanged. GREEN reruns the exact executable/argv, additionally retaining all previous controls and the learning-store smoke. The final tool-owned record is exported outside Git after committed-candidate verification to avoid self-referential evidence.

One existing scanner dependency binding (EX-MEMORY-QUERY-TIMING) was refreshed after reviewing the unchanged batch timing body and the new inner scoped call. No exception or admitted command was added. `scanner-rebinding.json` records the old/new digest; strict scanner report parity still passes.

## Cold/fallback observations and remaining hash calls

The 5000-record fixture exceeds the existing 4096 per-token ID cap. Both versions execute two exact-overflow fallback scans, visiting 10000 source records in total; results agree. The optimization reduces cold discovery overhead while preserving those scans. The 2000-record fixture does not overflow, and warm hits do not search candidates. This is a deliberately triggered fallback witness, not an estimate of real-world frequency.

Eight selected live Lab CLI invocations were sampled: session_brief, aux_doc_list, story_get and story_list, each twice. Only the two session_brief calls built Memory packs: the first rebuilt an index, the second hit cache. No token-scan fallback occurred. Thus the observed cold ratio is 1/2 among two Memory requests in this small selected sample; it does not establish a historical or production rate. See live-intake.json for per-command times and counters.

The fresh hash profile has 20 symbolic-ref observations, 20 combined Git-directory observations, 20 merge-base calls, 20 object-ref resolutions, plus nine first-use environment/tree/attribute operations. These have distinct current contracts; no additional safely redundant operation was proven in this round. Hash implementation and freshness tests are retained. This diagnostic is not a claimed hash repair.

This is local Lab maintenance evidence, not formal Story DONE, release evidence or an independent vendor audit.
