## Trigger Event
On 2026-06-12, B-ebc5 wrote the accepted execution plan for the three current gap_analyze high gaps. An attempted follow-up story was discarded because an extra gitRoot repair UX checklist item expanded the approved scope. This replacement story keeps the scope limited to the two signed-workspace gap bindings only.

## Key Insights
The current code already contains much of the signed-workspace resolver and REVIEW fail-closed behavior. The remaining correctness task is to bind the documented signed-workspace failure reasons to implementation and regression evidence so gap_analyze stops reporting the two signed-workspace high gaps.

## Solution Tradeoffs
Prefer the smallest real correctness fix: source annotation, exact diagnostic consistency, or targeted regression coverage. Do not add new CLI UX, repair commands, Authority behavior, customerKeyRef handling, or broad refactors unless a test proves they are required for the two signed-workspace gaps.

## Conversational Texture
The user wants the approved execution plan carried out without scope creep. This story should make the two signed-workspace high gaps disappear while preserving the remaining customerKeyRef high gap for a separate Layer4 decision or implementation story.
