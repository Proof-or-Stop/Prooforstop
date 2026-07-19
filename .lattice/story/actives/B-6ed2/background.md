## Trigger Event
During B-8195 on 2026-07-18, quorum_submit emitted six current-round host_verdict rows but left process-events.jsonl dirty. The following 46-command validation ran for about nine minutes and then correctly refused canonical PASS persistence because that dirt pre-existed validation.

## Key Insights
The verifier behaved correctly: it must never absorb pre-existing metadata into its own PASS transaction. The missing boundary belongs to quorum_submit itself. Gate-consumed host verdicts must either all become durable in one exact transaction or all disappear; partial rows cannot represent assurance.

## Solution Tradeoffs
A broad dirty-path allowlist would be unsafe because forged verdict-shaped rows or unrelated process events could be laundered into a trusted commit. The preferred design captures a clean entry baseline, emits the bounded batch, rechecks HEAD and exact bytes, and commits only its causal process-events delta with rollback on failure.

## Conversational Texture
The user repeatedly asked to avoid blind reruns, long validation loops, and manual confirmation after an approved plan. This story should stay small, begin with a real RED, expose progress through focused tests, and avoid another full suite until the exact persistence boundary is proven stable.
