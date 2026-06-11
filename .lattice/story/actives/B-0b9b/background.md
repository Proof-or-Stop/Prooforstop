## Trigger Event
After B-b5b2 created a root document migration guide on 2026-06-11, the user clarified that the root directory must not keep agent-generated Markdown as permanent clutter. The user-owned jek.md may remain, but generated Lattice and legacy Koala root documents should move to canonical docs homes or be retired.

## Key Insights
The previous guide was useful as an inventory but too conservative about legacy compatibility. The stronger product rule is that root should contain stable entrypoints and user-owned notes only. Agent-generated baseline, execution-plan, capability, and legacy guide files should not remain root-level truth sources.

## Solution Tradeoffs
A direct bulk move would be fast but risks broken links and false capability claims. A staged execution solution is safer: document allowed root files, map every generated root doc to a canonical destination or retirement action, define reference checks, and isolate high-risk Production Safety or capability-claim files into explicit boundary handling.

## Conversational Texture
The user is pushing for a cleaner repository shape, not another abstract classification pass. The solution should be concrete enough for the next implementation story, and it should remove the ambiguity that KOALA.md can continue to appear as a retained root compatibility asset.
