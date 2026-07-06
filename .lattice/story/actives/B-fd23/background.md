## Trigger Event
On 2026-07-06, while taking over story B-e1f6 (cell03 parallel shard runner) at REVIEW, the operator listed six unresolved items that B-e1f6 deliberately left out of scope and asked that they be captured as milestones in a successor story rather than folded into B-e1f6's frozen narrow scope.

## Key Insights
B-e1f6 makes parallelism safely IMPLEMENTABLE at the tool layer only; it does not make the current real provider run safe-parallel. The real B-991d Cell 03 runner is still serial and appends to one ledger, real rows carry no formal attemptId/runId/shardId accounting, provider-reported usage is not recorded per attempt, retry/failed/superseded attempts have no de-duplication guarantee, the cumulative total of 68,397,574 tokens is not protected by a shard-local usage ledger, and there is no result-writer that safely merges validated shard outputs into the formal Cell 03 result ledger. Any of these gaps can pollute the aggregate if real parallel runs start before they are closed.

## Solution Tradeoffs
Prefer adopting the existing B-e1f6 cell03-shards helpers (plan, shard-runner, merge validation) directly inside the real B-991d runner rather than reimplementing sharding, and prefer append-only shard-local usage ledgers keyed by attemptId with idempotent supersede semantics over mutating a shared running total. The result-writer must reuse B-e1f6 merge-validation guarantees (binding/digest/duplicate/missing checks) before any row enters the formal ledger. This is high-risk because it touches real provider execution and the real cumulative usage total, so it must not be merged with the safe tool-layer story.

## Conversational Texture
The operator cares that no takeover Host mistakes B-e1f6's tool-layer safety for real-run safety; the deliverable is that real parallel Cell 03 runs cannot double-count usage or corrupt the aggregate, with each real attempt individually accounted and each shard merged only through validated integration.
