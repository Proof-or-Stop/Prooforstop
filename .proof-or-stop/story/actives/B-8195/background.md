## Trigger Event
During B-0784 on 2026-07-18, the mandatory TEST validate selected trusted fresh-PASS reuse and logged commandExecutions=0, yet returned infra_failure because process-events.jsonl was dirty. An isolated RED reproduced the same canonical-pass-persistence-failed result without changing project material.

## Key Insights
B-914f already proves clean-tree reuse, but its smoke manually commits residual .lattice rows before the reuse attempt. The uncovered boundary is a canonical lifecycle write immediately followed by mandatory validate. The verifier currently treats every managed-path dirty row identically, without causal writer classification.

## Solution Tradeoffs
The fix must not simply allow metadata-only dirt. Only artifacts proven to come from the authorized immediately preceding lifecycle flow may join the isolated metadata transaction. Human confirmation, direct edits, malformed receipts, forged event-shaped content, unrelated paths, concurrent HEAD movement and writer failure must remain fail-closed.

## Conversational Texture
The user asked to establish a RED before opening this work because earlier workflow fixes incurred repeated full-suite and review costs. The implementation should stay narrow, reuse existing closeout transaction primitives, avoid another broad framework rewrite, and demonstrate one-shot zero-command convergence before claiming completion.
