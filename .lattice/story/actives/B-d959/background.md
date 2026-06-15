## Trigger Event
2026-06-15 after B-1550 reached DONE, the user asked whether the 3x2 review mechanism should degrade to 3 rounds x 1 host when another host is unavailable or out of credits, so development is not blocked by host capacity.

## Key Insights
The mechanism needs a capacity-aware fallback, but the fallback must be honest. Three rounds by one host can improve reflection, yet it does not provide independent-host assurance and must be recorded with a degraded assurance level.

## Solution Tradeoffs
Keeping 3x2 as the default preserves strong independence. Allowing 3x1 only under explicit unavailable-host conditions improves developer continuity, but it needs reason codes, stronger local evidence, user/project policy visibility, and negative controls so it is not silently treated as full 3x2.

## Conversational Texture
The user is optimizing for open-source practicality and developer flow, not lowering standards. The right tone is pragmatic: accept the concern, protect truth in the gate semantics, and document exactly when degraded review is allowed.
