## Trigger Event
On 2026-06-19, B-503b landed the Review Assurance Floor execution plan, but the CLI runtime still does not mechanically enforce the policy before DONE. This story turns that documented decision into a gate-consumed capability.

## Key Insights
The previous bug pattern showed that small code tasks can reach DONE without enough review and later reveal correctness issues. A PLAN-only risk label is insufficient; the DONE path must inspect actual material diff and failure signals.

## Solution Tradeoffs
The implementation should add a minimal runtime gate and diagnostics rather than a broad review framework rewrite. It must preserve docs-only low-risk behavior, support local Non-authority evidence, and keep Authority Server claims receipt-backed only.

## Conversational Texture
The user explicitly approved using Lattice CLI parallel development capability, but asked that the work run until DONE and require three rounds with two hosts. The work should be practical, conservative, and focused only on correctness.
