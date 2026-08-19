## Trigger Event
On 2026-07-05 the user explicitly authorized continuing the multi-model ablation provider-execution track, but the current launch artifact still reports providerExecutionAuthorized=false and all authorization metadata fields missing. B-785e and B-fe25 completed static readiness only, so a new audited story is required before any provider cell can run.

## Key Insights
The existing guard is correct because it prevents accidental provider spend and false result rows. The next layer must not simply flip a boolean; it must bind human approval, dated provider snapshots, prompt digest, tool-surface digest, runner ownership, budget cap, and duplicate policy while preserving sequencing: cell 03 first, real budget lock second, cell 06 only after that.

## Solution Tradeoffs
Keep this story narrow: create an authorization metadata artifact and checker support for an authorized-but-bounded state. Do not run the full Phase 1 matrix, do not write result rows, and do not unlock paper claims. This avoids arbitrary optimization and keeps correctness focused on launch safety.

## Conversational Texture
The user wants visible milestone status updates after each step and has granted permission to proceed, but also needs to know exactly what is done, what is in progress, and what remains blocked. The implementation should therefore produce explicit status-table updates and machine-checkable artifacts rather than vague chat-only progress.
