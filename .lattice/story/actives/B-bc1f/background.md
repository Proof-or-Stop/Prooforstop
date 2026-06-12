## Trigger Event
On 2026-06-12, an external ClawCreek run created story B-63ca directly with phase REVIEW, then review_run_start and review_loop_start both failed because currentReviewRound was missing even though the visible phase was REVIEW.

## Key Insights
The failure is a state consistency bug rather than a reviewer-lane bug. REVIEW phase commands trust currentReviewRound as structured metadata, so direct phase creation must either initialize that metadata or reject the unsupported phase before writing a misleading story.

## Solution Tradeoffs
The smallest compatible repair is likely to share or invoke the same review-round initialization used by story_advance into REVIEW. If direct advanced phases are intentionally unsupported, the safer alternative is a precise creation-time validation error with a migration or repair path.

## Conversational Texture
The report came from practical docs-review work where the user wanted a lightweight review-only pass over existing documentation. The desired product outcome is that Lattice does not strand users in a phase that looks ready but cannot run the matching review commands.
