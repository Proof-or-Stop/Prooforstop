## Trigger Event
After B-b36d reached DONE on 2026-06-20, external review found that the new Lifecycle Readiness Check plan still leaves localReady undefined and keeps an ambiguous Target proof complete decision in the diagram.

## Key Insights
The important contract is not whether every proof row is complete, but whether any readiness row is blocking for the requested target. Manual and external rows may need a next action without an executable command.

## Solution Tradeoffs
This story should tighten the document and diagrams only, because implementation has not started. The fix should preserve the read-only V1 boundary while preventing future CLI code from inventing a second readiness predicate.

## Conversational Texture
The review feedback is precise and actionable: accept the contract-level issues from Claude Code first, then incorporate the smaller ChatGPT wording changes where they make the SVG and Markdown clearer.
