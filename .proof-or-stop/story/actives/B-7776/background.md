## Trigger Event
During the B-bbaf quality review on 2026-07-14, the quality lane recorded a low-severity observation: resumeBreakerState accepts priorState even though its implementation never reads that value, while every caller still supplies a real prior state.

## Key Insights
The runtime behaviour is already correct because a human acknowledgement intentionally clears the freeze, restores the one-shot recovery budget, and re-baselines every signal from current counters. The defect is misleading API shape rather than faulty product behaviour.

## Solution Tradeoffs
Removing the unused parameter and updating the three internal call sites is preferable to renaming it with an underscore, because no compatibility or symmetry requirement justifies retaining it. The change should remain narrow and preserve all existing reset assertions.

## Conversational Texture
The user explicitly wants this simple cleanup handled now through a real story, partly to observe whether the workflow itself triggers repeated assurance cascades, stale evidence, or other non-converging process behaviour during a very small maintenance change.
