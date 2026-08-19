## Trigger Event
On 2026-07-02 the user asked whether the next step should first prove that real candidates are produced, consumed, and left as unhandled recommendations. This is linked to B-6241 and B-1c46.

## Key Insights
The existing promotion worker proves mechanics in smoke tests, but current real .lattice/learning data has no playbooks, outcomes, or promotion decisions. A read-only observation command can separate evidence from automation and avoid building automatic behavior without a real backlog.

## Solution Tradeoffs
Prefer a narrow read-only CLI command over adding automatic behavior. The command should summarize real candidate, outcome, and recommendation handling state while preserving authority=non_authoritative and gateEvidence=false.

## Conversational Texture
The user wants proof before optimization. The work should make the answer mechanical and repeatable, not rely on memory or a one-off manual shell inspection.
