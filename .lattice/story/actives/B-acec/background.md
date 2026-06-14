## Trigger Event
On 2026-06-14, after B-16eb completed the decision-doc promotion execution plan with a real three-round two-host quorum, the user approved moving from the audited plan into development. The gap is now implementation, not more planning.

## Key Insights
Lattice already has story-local decision_set and durable docs/requirements/decisions/*.md documents, but lacks a controlled promotion bridge. The implementation must preserve scope discipline, digest freshness, and local quorum semantics while remaining separate from Authority receipt completion.

## Solution Tradeoffs
Implement a narrow first version with canonical docs/requirements/decisions/*.md targets, story-local proposal metadata, read-only preview, and explicit save confirmation. Defer custom paths, automatic promotion, and Authority integration so the workflow stays understandable and mechanically testable.

## Conversational Texture
The user wants the system to become safer and more automatic, but only inside Lattice boundaries. The work should feel like adding a hard workflow rail, not giving agents a broad new license to write durable policy documents.
