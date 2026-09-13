# Second intake repair round — complete health and bounded early cache reuse

This is the next repair cycle in the existing Lab-memory-intake-measurement, with no second Lab or main integration. It addresses the user's four requested topics. Local main was synchronized to the 0.3.352 baseline before the new RED; comparison baseline b9c99c15ab includes that synchronization and the preceding intake repairs.

## Results

| Item | Before | After | Proof |
|---|---|---|---|
| Workspace/config ownership | validation_plan reloads config after obtaining workspace.config; structural case fails | Uses workspace.config; structural and workspace parity cases pass | Complete suite 38/40 → 40/40 |
| Default smoke output | 11252 characters, exceeds unchanged 11000 bound | 9450 characters, below 11000 | Default and verbose executions both 40/40 |
| Memory hit, 2000 records | 198.372ms/query; 5 index builds per 5 hits | 63.166ms/query; 0 builds per 5 hits | 68.16% lower mean in fixture; all 20 pack digests equal |
| Story hash, 20 calls | 1261.677ms; 109 Git children, including 20 worktree inventories | 1003.911ms; 89 Git children, no worktree inventory in this conventional ordinary-checkout fixture | 20.43% lower mean; all 80 hash values equal |
| Baseline selection, 20 calls | 881.457ms; 80 Git children | 661.813ms; 60 Git children | 24.92% lower mean; results equal |

Configuration loading already has a process cache. Removing this extra call repairs ownership and the structural contract; no significant standalone JSON/config parsing speedup is claimed. Workspace discovery's prior optimization remains in place, but this round does not claim another workspace-discovery speedup.

## Implementation and safeguards

The validation planner consumes the shared workspace's config instead of independently reloading it. The structural prohibition remains enabled, and the existing ordinary/main, linked worktree, wrapper-root, terminal and selection-digest parity controls pass.

Default audit rows retain every caller, call line, read category and delegation count. Complete delegation identities stay in verbose output and are explicitly asserted there. The 11000-character bound and all 40 checks remain; no previously failing case was deleted or waived. The earlier history health comparison still prints historical baseline provenance, while the new outer pinned command requires the suite's absolute zero exit code directly, so a future return to 38/40 fails this cycle.

The Memory early cache path applies only without a persisted or explicit index. Cache entries must be marked as having actually used a successful source index build, and their index schema, complete current source digests, normalized query/context, limits, and runtime configuration must match. Explicit index results cannot grant this reuse. Existing stored-index validation and index version checks remain in place. Changed sources, different lookup context, absent/old/ineligible cache entries and disabled caching follow the original path. A failed index build cannot mark an entry eligible. The policy namespace changes to v2, with index schema included in lookup identity; old cache entries incur a one-time miss rather than being trusted under the new policy. This is an advisory Memory cache, never execution/PASS evidence.

The tests exercise serialized pack parity, fresh-process durable hits, contributing-source mutation, cache disablement, explicit index isolation and a corrupt stored index. The existing M3–M6 suite is additionally pinned for cache/config/identity/freshness coverage. The intake observer now counts both early and normal probes; those are probe counts and may exceed logical requests on misses.

Baseline resolution determines linked-checkout policy before requesting a worktree inventory. Linked checkouts and explicit candidate snapshots preserve their existing observations. An ordinary direct call reads the primary worktree only after remote/conventional baseline candidates fail. Current refs still resolve on every call: there is no moving-ref or cross-command cache. Local containment, remote-ahead/diverged tips, missing or poisoned refs, unusual primary branches, deadlines and pathname controls remain in the pinned tests.

## RED/GREEN and measurement

The managed RED at b9c99c15ab8582e6673c97de78197e82bbf9a541 runs `node scripts/lab/verify-intake-round-two.mjs` and requires MEMORY_PREINDEX_RED. Its actual Memory witness observes one index build during a cache hit; the direct health smoke fails 38/40, and baseline probes exceed the new limit. See [RED record](managed-red.json). The RED also exposed scanner evidence drift from synchronization; it is retained in the log, not mistaken for the target performance failure.

The same pinned executable/argv rebuilds content-bound dist, requires full workspace health, runs the new Memory and discovery checks, the real M3–M6 memory suite, and all prior history/Memory-timing/scanner controls. The managed CLI records GREEN only against the final committed candidate. Its final record is exported outside the worktree at delivery, avoiding a self-referential evidence commit. These are Lab maintenance records, not formal Story DONE, release evidence or a fresh independent vendor audit.

The final benchmark candidate is b9e9c92364f5b70142af43d5f40f764c0ad148a8. [Memory ABBA](memory-abba.json) uses one fixed 2000-record fixture with five warmed queries per fresh child and before/after/after/before ordering; cold priming is excluded. [Git ABBA](git-abba.json) uses one fixed 50-file repository and 20 calls per function per fresh child. Historical modules are loaded from the actual immediate pre-repair commit; other dependencies remain current. Import/transpilation time is excluded, and complete source/dist bindings are checked before and after. This is a bounded module replay, not two complete historical CLI installations. Raw module hashes, individual measurements and result digests are retained.

Wall-clock measurements on the shared host vary: the two before Memory rounds averaged 234.305 and 162.439ms, after 65.688 and 60.643ms. The acceptance thresholds use deterministic construction/subprocess counts and output parity, not the observed percentage. This does not establish production p95 or cold-path trigger frequency, and baseline savings must not be added to hash savings because baseline work is nested in hash.

## Evidence reconciliation

Main synchronization changed runtime-contract, package and registry bytes alongside the retained Lab additions. The scanner manifest retained the union of existing exceptions. Conflicting incoming bindings were reconciled, then 70 existing records were rebound to current dependencies/caller positions; [rebinding ledger](scanner-rebinding.json) identifies the changes. Unchanged call-expression digests locate existing callers. Source excerpts either move unchanged or expand only to include inserted lines while retaining every previously reviewed line in order. No exception, allowed invocation or configured index was added. The strict scanner reports zero needs-review/stale/unexpanded rows, and the previous AST-reuse test still compares complete reports.

The prior two health failures are now repaired; their earlier no-new-regressions reports remain historical evidence, not current unresolved exceptions. No speculative generic JSON cache or broad Memory fallback removal was added.
