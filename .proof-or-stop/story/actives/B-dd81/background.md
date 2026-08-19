## Trigger Event
B-360e completed Story 1 and established the frozen 16-role contract and measurement baseline on 2026-07-18. The ordered execution plan now requires Story 2 before any incremental or budget behavior can be enabled.

## Key Insights
The current host can observe and request prompts, but a trustworthy Story-aware full-context envelope cannot be assembled by the main Agent itself. Freshness, provenance and role eligibility must be machine-bound to the same signed review facts.

## Solution Tradeoffs
This Story implements only canonical full context and deliberately postpones incremental selection. It accepts additional signed artifacts and gate checks in exchange for replay resistance, deterministic rollback and auditable provider-attempt accounting.

## Conversational Texture
After completion, a user can request a Story-aware full Prompt through agent_prompt and see a deterministic envelope identity tied to the current HEAD, review round and ReviewRun. Replaying an older envelope produces a stable rejection reason, provider retries retain the recorded attempt identity, and compatibility-only evidence visibly cannot unlock review gates.
