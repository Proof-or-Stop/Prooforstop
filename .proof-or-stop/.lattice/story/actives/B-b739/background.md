## Trigger Event
On 2026-06-23, after S4' step 2 (B-d43f) merged all 9 stateful live-loop scenarios (so all 15 B1-B15 are built + hermetically verified), the user directed: continue until results are backfilled into the paper. This story builds the real multi-turn agent + the powered-run path so the 9 stateful scenarios can produce real outcomes (the 6 stateless already have a powered batch from B-0c07).

## Key Insights
The B-c023/B-d43f live-loop harness runs a pluggable agent across turns with an AbortController watchdog. A real agent must (a) run claude -p per turn on {ws, context} like the B-0c07 single-shot real arm, reusing parseClaudeResult (non-JSON/API-error -> infra-fail; type-safe cost), and (b) honor signal.aborted by killing its child (the B-c023 contract). The hermetic self-check uses a stub multi-turn agent (0 spend) to verify the --run wiring + record schema + signal honoring; the real powered run is operator-triggered and cost-gated.

## Solution Tradeoffs
Build the real agent + the --run powered path + a hermetic stub self-check (the deterministic gate); the actual powered run (real claude -p, real money, non-deterministic) is a separate operator-triggered step whose records are honestly labeled small-N/exploratory. New file real-loop-agent.mjs + a --run path in live-loop-harness.mjs; do NOT touch probe-contract / the 6 stateless probes / run-recovery (e8aca935). The pre-reg amendment (6->15) and the paper backfill are the final steps after this.

## Conversational Texture
The user said to run S4 to completion until the results are backfilled into the paper. We are at the home stretch: this story (real multi-turn agent + powered path) -> pre-reg amendment -> paper backfill.
