## Trigger Event
On 2026-06-12, after B-b750 reached review and validation success, the operator asked why TEST PASS had not completed DONE. The concrete lifecycle gap is not a code-test failure; it is an agent workflow interpretation problem where closure gates such as delivery-check and summary can be missed.

## Key Insights
Lattice already has hard DONE gates, so the implementation should not weaken the state machine or duplicate gate predicates. The missing capability is a host-neutral runbook projection that explains remaining closure blockers and separates local lifecycle readiness from Authority Server receipt-backed proof.

## Solution Tradeoffs
The conservative path is to reuse session_brief, next, and done-oracle data instead of inventing a new lifecycle engine. A new command is acceptable only if it remains read-only by default and gives stable machine-readable output that agents can follow without forging reviewer signatures or summaries.

## Conversational Texture
The user wants this executed as an auditor-led Lattice CLI story, with Claude CLI and Codex CLI host perspectives used to catch real correctness issues. The work must avoid arbitrary optimization, preserve consistency of logic, and keep Non-authority local evidence separate from Authority completion claims.
