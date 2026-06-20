## Trigger Event
On 2026-06-20, story B-0607 captured a truth-first host handoff stale-doc guard execution plan after recurring failures when hosts resumed work from stale plan docs and lacked fresh evidence summaries.

## Key Insights
Different hosts currently read different context sources and can continue work on already-completed or superseded docs. The handoff payload does not consistently include the same authoritative fact bundle, so hosts may make duplicate or incorrect recommendations.

## Solution Tradeoffs
We can enforce a host-agnostic preflight contract with a compact payload and explicit stale-doc checks in handoff accept/dispatch flows. This adds some validation latency but prevents recurring rework and improves 3x2/2-host review reliability versus leaving verification to local habits.

## Conversational Texture
Users want this to work regardless of host and avoid asking the same issue repeatedly. Implementing it now should make handoff outcomes deterministic, auditable, and easier to review under high-risk conditions.
