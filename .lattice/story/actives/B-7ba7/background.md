## Trigger Event
On 2026-07-04, the user asked whether Proof-or-Stop can show every milestone and the internal details of each milestone while a project is being executed, similar to screenshots where completed milestones are listed first, the active milestone is expanded, and remaining milestones are shown below.

## Key Insights
The existing ProofStory milestone ledger can store machine-countable milestone rows, but hosts still need a stable read-only command that joins ledger rows with checklist, verification, evidence, and summary facts into a progress table that a developer can understand without manually inspecting scattered files.

## Solution Tradeoffs
The first implementation should be read-only and reuse the existing milestone ledger rather than creating another storage layer. Mutating completion writers and executor-ledger integration are useful later, but V1 must first provide a trustworthy status report and exact next action surface.

## Conversational Texture
The user cares about project execution visibility: after each milestone or sub-objective changes state, the host should be able to show what is done, what is active, what remains, what evidence exists, and what still blocks progress, without hiding detail behind a vague DONE claim.
