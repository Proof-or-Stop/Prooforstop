## Trigger Event
On 2026-07-07, a local Proof-or-Stop workflow exposed that story_advance --phase=TEST can appear stuck while lattice validate --json runs many configured commands silently, eventually hitting the idle watchdog with a stuck: 300 seconds without output style failure.

## Key Insights
The watchdog itself is correct and should remain fail-closed, but validate must make real progress visible to the lifecycle parent. Heartbeat and progress must also be JSON-safe, flushed immediately, and routed without corrupting machine-readable stdout.

## Solution Tradeoffs
The story should add progress events, long-command heartbeat, timeout diagnostics, stale-lock cleanup, and infra-failure evidence classification. It should not remove validate, weaken gates, use unlimited timeouts, or make failed tests pass.

## Conversational Texture
The user is trying to unblock other sessions from wasting time on silent validation loops. The desired outcome is a small correctness fix with clear milestones that another host can execute without re-litigating the design.
