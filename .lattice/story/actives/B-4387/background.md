## Trigger Event
- Evidence: operator reports B-0419 follow-up, and production CLI telemetry showed control readiness stayed true while control endpoint was unreachable.
- Related case: configured control URL pointed to temporary unavailable host after maintenance window.
- Impact: status/enforce UX misled users into assuming control flow is operational while submissions later failed.

## Key Insights
- Current status returns `serverReachability: not-probed` and marks ready only by configuration completeness with no readiness warnings.
- Enforce/shadow readiness does not verify live connectivity before declaring ready.
- Status and conduit commands are read-only and can include conservative network checks without mutating workflow state.

## Solution Tradeoffs
- Option A: mark ready false based on explicit control-plane /policy probe in status/autopilot, surfacing actionable reachability warnings. (recommended)
- Option B: defer to existing behavior and only add docs guidance; lower immediate changes but keeps false positives and repeated support incidents.
- Option C: move control probe to a separate command only; cleaner isolation but loses immediate visibility and adds one extra operator step.

## Conversational Texture
- The goal is to make failures visible where users check control health, before submission.
- If the control server is down, readiness should become conservative and transparent, with explicit suggested commands for verification and recovery.
