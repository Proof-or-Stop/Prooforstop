## Trigger Event
2026-06-15 after B-b663, the user asked to execute the development work, meaning the runtime should now follow the documented policy instead of only describing it. The relevant policy source is B-b663 and the decision plan it updated.

## Key Insights
The current runtime still treats direct decision-doc file changes as a standalone 3x2 quorum requirement. The new target policy says documentation audit should use the same ordinary REVIEW default and automatic first-round threshold trigger as code work.

## Solution Tradeoffs
The safe path is to keep decision-doc change detection for diagnostics while moving the hard quorum trigger to review escalation facts. This avoids a misleading always-on rule, but it requires careful tests so risky first-round review findings still force quorum.

## Conversational Texture
The user is trying to make the open-source workflow practical: strong review when the first round exposes risk, but not unnecessary two-host friction for every documentation edit. The implementation should be direct, English-facing, and honest about remaining lower-assurance paths.
