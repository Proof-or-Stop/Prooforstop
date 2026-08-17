## Trigger Event
B-9dfb was completed on a separate orchestrate/main history on 2026-06-24, but current local main does not contain its DONE readiness behavior. The user asked whether to connect that work here, and we decided to port only the behavior into a fresh local story.

## Key Insights
The useful asset is the code behavior, not the stale B-9dfb story binding. done_prepare should distinguish harmless pre-existing Lattice lifecycle metadata dirt from real source or material dirt, while lifecycle_check should not report localReady false for a merely advisory missing done_prepare report.

## Solution Tradeoffs
Cherry-picking the entire alternate main would import unrelated history and stale story metadata. A narrow port inside a fresh worktree keeps current main coherent, reruns validation under the current codebase, and preserves the existing story lifecycle gates.

## Conversational Texture
The conversation focused on whether B-9dfb was truly merged and what to do after discovering it lived on another history. The desired operator experience is practical: bring back the proven readiness fix without creating another confusing branch or stale worktree situation.
