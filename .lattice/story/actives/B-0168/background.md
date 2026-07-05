## Trigger Event
On 2026-07-05, after B-0315 reached DONE, main still had two uncommitted Tier-C documentation changes: a modified tier-c-crosshost-quorum-execution-plan.md and a new tier-c-powered-independent-host-campaign-protocol.md. They need a Lattice story so the work is not an unmanaged main-branch draft.

## Key Insights
The changes are documentation/protocol governance, not runtime implementation. Existing related stories B-ac71 and B-f57a explain the Tier-C foundation, but neither active story currently owns this M4 powered-campaign protocol solidification patch.

## Solution Tradeoffs
Use a narrow docs-only story that accepts only the parent plan update and the new protocol artifact. Keep implementation, experiment execution, paper wording changes, protocol.lock.json, and result analysis explicitly out of scope so the story remains small and reviewable.

## Conversational Texture
The user asked whether another story already handled the dirty Tier-C files, then asked to open a story to manage them. The priority is clean lifecycle accounting and preventing useful research-protocol text from floating outside the Proof-or-Stop process.
