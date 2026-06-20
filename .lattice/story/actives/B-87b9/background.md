## Trigger Event
On 2026-06-21, starting P2 of the Lattice Lifecycle Proof-Or-Stop Readiness Check execution plan. P1 (read-only lifecycle_check V1) is DONE on main (B-bd45 + B-b179). The plan's Suggested Story Breakdown lists P2 as 'Add PLAN skeleton assistant - explicit PLAN writer, separate from V1'. The user asked to develop P2-P8 to completion using the host Codex CLI and Claude CLI.

## Key Insights
Per the Full Vision Step Contracts table, the PLAN skeleton step produces 'checklist/context/understanding suggestions' and is 'outside V1; explicit writer only'. So P2 must: (1) consume the existing V1 StoryReadinessReport (not invent a new readiness predicate, per line 492-493 of the plan), (2) be an EXPLICIT, opt-in writer (it may write checklist/context/understanding skeletons when asked), (3) keep the proof-or-stop separation - it does NOT run commands, launch reviewers, advance phases, or claim Authority. The cleanest surface is a new CLI command (e.g. lattice plan_skeleton --storyId=B-xxxx) that emits suggested PLAN artifacts derived from the story description + readiness report, which the operator then explicitly accepts.

## Solution Tradeoffs
Surface options: (a) a standalone command that only PRINTS suggestions (operator copies), vs (b) a command that can optionally WRITE the skeleton via existing checklist/understanding setters behind an explicit flag. The plan calls it an 'explicit writer', so (b) with a default-dry / explicit-write flag fits, but the write path must reuse existing setters (no new mutation primitives) and stay separate from V1's read-only command. Scope: one new command + its smoke; reuse StoryReadinessReport and existing PLAN setters; do not touch V1 lifecycle_check's read-only contract.

## Conversational Texture
The user reviewed the lifecycle execution plan, confirmed P1/V1 is done and P2-P8 are intentionally deferred, then chose to develop P2-P8 to completion using the host Codex CLI and Claude CLI. This is P2, the first deferred layer.
