## Trigger Event
This is a synthetic smoke test case created on 2026-06-12 for direct phase REVIEW validation with event ID B-0001.

## Key Insights
The review-only path can fail when story is created in REVIEW but missing currentReviewRound metadata. This entry verifies the command behavior and message path.

## Solution Tradeoffs
We intentionally create a minimal review-only story through CLI and immediately attempt reviewer start to validate that the CLI reports review-entry-flow guidance instead of only telling to advance phases.

## Conversational Texture
Team and future operator context for this regression run: verify that this is treated as a legacy direct creation path and guide next step clearly to a supported entry flow.
