## Trigger Event
On 2026-07-01 the user approved the Playbook Runtime Memory Consumption plan and explicitly asked to start development until completion, after repeated evidence that dev-memory and playbook lessons exist but are not automatically consumed by runtime entrypoints such as session_brief.

## Key Insights
The issue is not lost storage; it is a missing runtime consumption layer. MVP1 must prove the current non-consumption failure first, then add active playbook surfacing and a digest-bound non-authoritative memory pack visible in session_brief.

## Solution Tradeoffs
Keep the first slice advisory-only and session-scoped. Do not wire handoff, story intake, DONE, blocking policy, or the 1M baseline yet; those are later parent milestones after the core pack and session consumer work.

## Conversational Texture
The user wants Proofbound to stop relying on hosts remembering to search memory manually. The implementation must be concrete and machine-verifiable, but it must preserve the boundary that memory and playbooks are context, not proof evidence.
