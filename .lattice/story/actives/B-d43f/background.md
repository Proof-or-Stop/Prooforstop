## Trigger Event
On 2026-06-23, after S4' step 1 (B-c023) merged the live-loop interruptible-harness skeleton + the first 2 stateful scenarios (B7, B10), the user directed: continue S4 — run all remaining scenarios through to backfilling the paper. This story is S4' step 2: the other 7 stateful B1-B15 scenarios.

## Key Insights
The B-c023 live-loop harness already provides runLiveLoop({scenario,agent,maxTurns,turnTimeoutMs}) with per-turn inject/truncate/kill hooks, a pluggable agent, an AbortController watchdog, and context accumulation. The 7 remaining scenarios are new scenario DEFINITIONS on that same loop: B4 uses the truncate hook (context loss), B5 uses the kill hook (host interruption/restart), and B3/B8/B12/B14/B15 use inject + workspace setup. classify must read real workspace artifacts (escalation/secret/migration marker files) + transcript facts, never the agent self-report.

## Solution Tradeoffs
Add all 7 scenarios in one story (mechanical extension of the step-1 architecture) verified hermetically with fake agents (0 spend) before the real powered run (the next story). Modify the existing live-loop-harness.mjs; do NOT touch probe-contract.mjs / the 6 stateless probes / run-recovery/run-ablation/run-a2prime (e8aca935). The real multi-turn claude -p agent + powered runs of all 9 live-loop scenarios, the pre-reg amendment (6->15), and the paper backfill are the subsequent steps.

## Conversational Texture
The user said to continue S4 and run all remaining scenarios to completion until the results are backfilled into the paper. We are executing the chain: this story (7 scenarios) -> real agent + powered runs -> pre-reg amendment -> paper backfill, reporting at each DONE.
