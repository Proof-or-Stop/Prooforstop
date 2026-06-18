## Trigger Event
On 2026-06-18 we saw the CLI still say authority job create requires a main/mac_ui/human actor key, even though the Mac-specific client surface is gone and the server side is being cleaned up.

## Key Insights
This is not a new product feature. The CLI needs to stop advertising a Mac-specific role name and instead speak the same neutral contract as the server, while keeping the current fail-closed path and project/session binding intact.

## Solution Tradeoffs
Make the smallest CLI correction necessary: remove stale mac_ui wording, align fail-closed reasons with the new server contract, and keep the existing bundle generator unchanged. Avoid broad refactors or new env tiers.

## Conversational Texture
The user wants the boundary to feel simpler, not more ceremonial. The visible behavior should read as one clear authorization path with less role jargon.
