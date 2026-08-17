## Trigger Event
On 2026-07-05, B-e62e advanced to DONE and printed Milestone Status after worktree cleanup, but the live report showed stale evidence and blocked rows even though milestone-closeout.json contained M1 and M2 as completed.

## Key Insights
The progress table has two different truth sources: live milestone_status is correct during DEV/REVIEW/TEST, while DONE needs the frozen closeout snapshot because active story files may be archived or no longer material-bound.

## Solution Tradeoffs
Prefer a narrow fallback that only affects DONE stories with a valid milestone-closeout.json snapshot, preserving live freshness checks for active stories and preserving missing-closeout diagnostics when no snapshot exists.

## Conversational Texture
The user wants an always-visible developer progress table with clear status icons, so a false red blocked table after DONE is worse than silence because it undermines trust in the lifecycle output.
