## Trigger Event
On 2026-09-07, B-8a40:F-088 recorded a real REVIEW scope blocker after dev_memory_finish generated dev-memory-candidates.jsonl at 08:17:49Z. Claude RR156 and the owner independently observed the exact blocking row.

## Key Insights
The producer is packages/main/src/core/dev-memory.ts resolveStoryCandidatePath. These candidates cannot satisfy gate evidence. The existing scope classifier fails closed because the generated path lacks registration. B-8a40 exact-path scope acknowledgement at 08:23:14Z changed the result to warn with no blocking rows, preserving the data and unchanged classifier material fb029a3a. This does not repair the durable producer contract.

## Solution Tradeoffs
The named future Story created from this draft owns central runtime classification and regression tests. B-8a40 retains F088 and occurrence-level closure evidence; it does not expand into a registry redesign. This mechanism is distinct from conditional F085 abrupt-termination mutant residue. Escalate back to the active Story immediately if acknowledgement fails to remove the actual blocker, authority changes, or acceptance/evidence integrity is affected.

## Conversational Texture
The user requires immediate repair of actual blockers and traceable bounded routing of residual nonblocking work. Preserve the original observation, before/after commands, exact path, and limitations. This draft is compatibility backlog accounting, not a signed deferral, applicability verdict, waiver, or whole-repository completion claim.
