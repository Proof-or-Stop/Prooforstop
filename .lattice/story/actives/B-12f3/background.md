## Trigger Event
On 2026-06-13, B-c251 produced the audited execution plan for missing_scope_check guidance ergonomics. This story is the implementation follow-up for that plan, with the user explicitly requesting an Authority-enforced execution path.

## Key Insights
PLAN scope evidence must remain reviewer-written and gate-consumed. Local CLI guidance is Non-authority and must not be described as receipt-backed Authority Server proof. Without configured Authority server readiness and verified gate_decision receipts, Authority completion must fail closed.

## Solution Tradeoffs
Prefer narrow wording and help updates over a new lifecycle assistant. Do not weaken gates or auto-generate evidence. Treat Authority flow as mandatory for Authority claims, but keep local development evidence clearly Non-authority until receipt-backed proof exists.

## Conversational Texture
This is now the implementation story for the B-c251 execution document. The audit role must prevent local evidence, host verdicts, or Lattice reviewer passes from being laundered into Authority completion.
