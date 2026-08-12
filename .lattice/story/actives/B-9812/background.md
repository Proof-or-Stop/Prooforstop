## Trigger Event
On 2026-08-12, an isolated clean-clone benchmark at commit 58c7cdc measured all 46 root npm test members passing in 1688.9 seconds. This delay blocks the implementer feedback loop and makes routine DONE convergence unreasonably expensive.

## Key Insights
The three longest tests consume 79.9 percent of wall time. A single acceptance case spends about 95.2 percent of its 26.42 seconds in 26 fresh-process CLI calls, while Git and build take less than half a second. Repeated initialization, not model inference or necessary business computation, is the dominant cost.

## Solution Tradeoffs
Preserve the dist standalone black-box boundary and full gate assurance, but verify the process boundary with bounded sentinels while the larger mutation matrix reuses an already verified in-process context. Concurrency must be constrained by a manifest resource contract; tests with unknown shared resources remain serial rather than becoming flaky.

## Conversational Texture
The user considers even five minutes long, but explicitly set this Story target to complete the full suite in under five minutes with safe parallel execution. Completion requires real temporary-clone measurements and cannot be claimed through removed cases, renamed exclusions, theoretical estimates, or retries that hide the first failure.
