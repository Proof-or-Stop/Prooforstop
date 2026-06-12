## Trigger Event
F-009 convergence still reports two signed-workspace high gaps tied to review-run-start-signed-workspace-resolution-execution-plan.md lines 262 and 311 after B-ebc5 completed the execution document.

## Key Insights
The current code appears to already fail closed for unresolved signed workspaces, so the likely problem is missing source/test/metadata binding rather than a need for a new product feature.

## Solution Tradeoffs
The conservative path is to inspect gap_analyze binding rules and add the smallest real correctness fix. gitRoot repair UX and Layer4 customerKeyRef are separate decisions and must stay out of scope.

## Conversational Texture
The user explicitly wants Lattice CLI flow, no arbitrary optimization, no scope growth, and no repeated cycles where one fix creates another unrelated batch of gaps.
