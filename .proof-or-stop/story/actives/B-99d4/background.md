## Trigger Event
On 2026-07-09 the operator reported that after sending a subagent to do work and receiving its completion, they wanted to assign that agent more work, possibly preserving some prior memory. The available full-history fork path could not specify the worker role, so it could not reliably restart as the intended worker.

## Key Insights
The product need is not full conversation inheritance. A fresh worker context with precise instructions, the prior result summary, and an explicit worker role is acceptable and often safer. The role must be chosen at launch time rather than inferred from inherited chat history.

## Solution Tradeoffs
Preserving full history may keep useful memory but couples continuation to the parent conversation and blocks role selection. A fresh role-aware reassignment loses implicit history, but it is auditable, bounded, and lets the caller provide only the facts the next worker needs.

## Conversational Texture
The user described this as a small pitfall rather than a broad redesign request. The implementation should stay narrow: make the second assignment ergonomic, avoid overclaiming memory continuity, and prefer explicit operator instructions over hidden inherited state.
