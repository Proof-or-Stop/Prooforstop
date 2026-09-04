## Trigger Event
On 2026-09-04, B-212f added CHK-004 during DEV to repair an acceptance-blocking evidence executor defect. The canonical proof-or-stop-implementer dispatch then required `.proof-or-stop/story/actives/B-212f/plan.md#CHK-004`, while `rg -n CHK-004` returned no match and the plan ended at CHK-003.

## Key Insights
The checklist, enforce-mode scope contract, and dispatch payload all contained CHK-004, so implementation remained possible and B-212f lifecycle truth was not weakened. The defect is a traceability mismatch: a generated required-reading pointer is dangling after an allowed DEV checklist addition.

## Solution Tradeoffs
One option is to update the tool-owned plan whenever DEV checklist_add succeeds; another is to make dispatch cite the checklist artifact for post-PLAN items. The solution must preserve the frozen PLAN contract, avoid rewriting authored planning history, and mechanically test that every emitted anchor resolves.

## Conversational Texture
The user requires nonblocking low or medium defects to retain reproduction, evidence, impact, recommendation, and a traceable later owner instead of expanding the current Story for global green. B-212f therefore records this narrow draft and keeps its current implementation scope unchanged.
