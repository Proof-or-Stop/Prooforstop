## Trigger Event
Story B-f495 accepted the slim / fields execution plan on 2026-06-15, but intentionally stopped at audit-only status. The next concrete step is to implement that accepted plan in the prompt and documentation surfaces agents actually read.

## Key Insights
The CLI already supports slim and fields on story_get and checklist_get, and smoke coverage proves default output remains full. The missing piece is behavior guidance: agents should spend compact output for orientation, then reload full output before evidence-sensitive work.

## Solution Tradeoffs
Prefer a shared prompt-registry snippet plus targeted command-example edits instead of changing command defaults. This keeps compatibility stable, avoids lifecycle gate semantics changes, and makes rollback a prompt/documentation change rather than a data migration.

## Conversational Texture
The user wants this moved through the real Lattice lifecycle, not left as a loose note. The implementation should be practical and reviewable: reduce routine context cost without training reviewers to skip evidence when it matters.
