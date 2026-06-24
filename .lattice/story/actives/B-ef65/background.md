## Trigger Event
On 2026-06-24, commit bac345a80 proved that two lattice validate invocations for the same story can enter the real validation command concurrently. Follow-up commits 8248dc50d and 5c643b627 proved a story-scoped execution lock and non-regression matrix.

## Key Insights
The correctness issue is not general optimization. It is a workflow correctness gap: validate writes evidence and runs long commands, so same-story concurrent execution can pollute evidence or waste agent time. The lock must be story-scoped, not global.

## Solution Tradeoffs
The chosen repair serializes validate and done_required_validate for the same story while preserving unrelated story/worktree validate concurrency and reviewer/delivery metadata writes. It avoids broad owner-lease changes and keeps the fix host-neutral.

## Conversational Texture
The user asked to treat this as an experiment: after red evidence and a proven fix already exist, open a formal Lattice story and measure how much lifecycle ceremony remains from story creation through DONE, including any friction encountered.
