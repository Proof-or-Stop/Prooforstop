## Trigger Event
On 2026-07-05, after B-fe25 prepared provider-free M2 launch readiness, the user asked to start the next step and asked whether a detailed execution document exists. The readiness artifacts explicitly say providerExecutionAuthorized=false and formal Phase 1 cells have not run, so a separate launch story is required before any paid provider execution.

## Key Insights
The existing protocol already defines the logical order: M0 and M1 are done, M2 must begin with cell 03 E2 A4 same-family calibration, then freeze a real budget lock, and only then allow cell 06 A2prime. The missing layer is not another broad optimization; it is the operational launch document and evidence boundary that prevent host labels, snapshots, budgets, and provider outcomes from being mixed together.

## Solution Tradeoffs
Keep the first story narrow: create the detailed execution plan, lock the authorization and snapshot prerequisites, and define verification for cell 03 calibration and budget-lock generation. Do not run the full 3456-cell Phase 1 campaign or Phase 2 powered matrix in this story unless a later explicit human approval and complete runner credentials are recorded.

## Conversational Texture
The user wants visible progress tables and does not want another vague statement that the protocol is complete when only readiness is complete. The work should therefore show milestone status, blockers, and next actions in plain language while preserving Proofbound host-neutral, evidence-first boundary.
