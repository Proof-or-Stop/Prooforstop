## Trigger Event
- Evidence: operator reports B-0419 follow-up, and production CLI telemetry showed `authorityReady` remained true while Authority endpoint was unreachable.
- Related case: LATTICE_AUTHORITY_URL pointed to temporary unavailable host after maintenance window.
- Impact: shadow/enforce UX misled users into assuming authority flow is operational while submissions would fail.

## Key Insights
- Current authority status returns `serverReachability: not-probed` and derives `authorityReady` only from config completeness and no readiness warnings.
- Enforce/shadow readiness does not verify live connectivity before declaring ready.
- Authority status/conduit status are read-only commands and can still include conservative network checks without mutating workflow state.

## Solution Tradeoffs
- Option A: mark ready false based on explicit /v1/authority/policy probe in status/autopilot, surfacing actionable reachability warnings. (recommended)
- Option B: defer to existing behavior and only add docs guidance; lowest change but leaves false positives and repeated support incidents.
- Option C: fully remove policy-probe from status and move to separate command; cleanest isolation but reduces immediate visibility and requires extra operators step.

## Conversational Texture
- The objective is to make failures visible at the place people check authority health, rather than after a runner step fails in later execution.
- If the server is down, readiness should become conservative and transparent, with explicit suggested commands for verification and recovery.

