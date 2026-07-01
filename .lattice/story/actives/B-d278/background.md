## Trigger Event
On 2026-07-01, after B-727b reached DONE for G03, the remaining UDM no-false-DONE baseline groups G04-G10 still needed machine evidence before the full 10x15 baseline could be claimed complete.

## Key Insights
The user is testing whether large milestone work can avoid false DONE. The remaining groups share one baseline document and one evaluator contract, so they should be implemented together with per-group checklist coverage and aggregate verification.

## Solution Tradeoffs
A separate story per group would reduce blast radius but repeat the same document merge and validation overhead seven times. One bounded story with one checklist item per group keeps the proof surface explicit while avoiding shared-document conflicts.

## Conversational Texture
The work should continue the group-by-group proof discipline established by G01, G02, and B-727b for G03. The final wording must stay humble: local deterministic smokes are not Authority, production, fullAuthority, or remote host completion proof.
