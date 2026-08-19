## Trigger Event
On 2026-07-05, after B-7ba7 reached DONE, the user asked whether all milestone rows could be printed with status, solved problem, and evidence at final closure. The live milestone_status view could print those fields, but after DONE merge/version bump it recomputed freshness and no longer represented the accepted green closeout state.

## Key Insights
The issue is not missing milestone data; it is a truth-boundary mismatch. A live diagnostic should continue to report current freshness, while a DONE closeout needs a signed or hash-bound snapshot of the accepted closure report generated before DONE changes move the material hash.

## Solution Tradeoffs
Keep milestone_status read-only and live. Add a narrow closeout snapshot path that captures the report at DONE readiness and exposes it as a stable artifact. Avoid broad lifecycle rewrites, automatic proof fabrication, or changing freshness semantics for active stories.

## Conversational Texture
The user wants an operationally clear table after each milestone-driven story finishes, not another agent-written summary. The output should be mechanical, easy to inspect, and explicit about what problem each milestone solved and what evidence supported closure.
