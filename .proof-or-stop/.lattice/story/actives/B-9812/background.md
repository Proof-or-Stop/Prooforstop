## Trigger Event

On 2026-08-12, an isolated clean-clone benchmark at commit 58c7cdc on the B-cdf6 descendant measured all 46 root npm test members passing in 1688.9 seconds. This historical descendant measurement exposed a delay that blocks the implementer feedback loop and makes routine DONE convergence unreasonably expensive.

## Key Insights

The authoritative B-9812 base currently has 45 canonical root members; its frozen inventory is distinct from the historical 46-member B-cdf6 descendant measurement. In that historical run, the three longest tests consumed 79.9 percent of wall time, and one acceptance case spent about 95.2 percent of its 26.42 seconds in 26 fresh-process CLI calls while Git and build took less than half a second. Repeated initialization is the dominant cost.

## Solution Tradeoffs

Preserve the dist standalone black-box boundary and full gate assurance, but verify the process boundary with bounded sentinels while the larger mutation matrix reuses an already verified in-process context. Concurrency must be constrained by a manifest resource contract; tests with unknown shared resources remain serial rather than becoming flaky.

## Conversational Texture

The user considers even five minutes long, but explicitly set this Story target to complete the full suite in under five minutes with safe parallel execution. Completion requires real temporary-clone measurements of the completeness-checked inventory and cannot be claimed through removed cases, renamed exclusions, theoretical estimates, or retries that hide the first failure.
