## Trigger Event
On 2026-07-06 during B-991d Cell 03 execution, the user asked whether several agents could run the experiment in parallel. Inspection showed the existing runner appends to one cell03-rows.jsonl ledger, while Parallel Wave only schedules stories and cannot protect per-cell result rows.

## Key Insights
Proofbound already has story-level parallel scheduling and the pos-instrument-replay campaign already has append-only resume and lock patterns, but Cell 03 needs its own cellKey-based shard model. The implementation must preserve the frozen experiment semantics and make unsafe concurrency fail closed.

## Solution Tradeoffs
Do not optimize for its own sake and do not change the experiment design. Add only the correctness controls required for safe optional parallelism: deterministic shard assignment, independent shard output, lock/lease protection, and a merge validator that rejects duplicate or missing final rows.

## Conversational Texture
The user wants faster B-991d completion but has repeatedly emphasized consistency of logic and real correctness issues. This story should make parallel execution possible only after proof that it will not pollute evidence or alter the Cell 03 protocol.
