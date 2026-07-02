## Trigger Event
On 2026-07-02 the user asked to start the Proof-or-Stop PINN M0-M5 work and continue until everything is DONE, after we confirmed the Orchestrate copy only showed a plan and the canonical root had a previous documentation-only DONE story B-2769.

## Key Insights
The existing document is valuable but explicitly says no runtime PINN module exists. To make the six milestones honestly DONE, the implementation needs a small host-neutral runtime pack that proves evidence binding and claim progression mechanically rather than only in prose.

## Solution Tradeoffs
Keep the first runtime pack deterministic and bounded: model PINN claim admissibility, adapter receipts, transition decisions, and benchmark metrics as local CLI logic. Do not implement scientific PINN solvers, PDE correctness, external authority, networking, or production-readiness claims in this story.

## Conversational Texture
The user wants a direct completion push, not another status explanation. The response should still preserve Proofbound truthfulness: document-only DONE is not enough, so this story must make the visible CLI commands and tests line up with the M0-M5 table.
