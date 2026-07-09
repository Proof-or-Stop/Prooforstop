## Trigger Event
On 2026-07-09 after B-90d6, review assurance was a valid DONE requirement but it surfaced late during done_prepare/DONE closeout instead of being visible when the first review findings made the requirement knowable.

## Key Insights
The gate was right to stop; the UX was late and under-specified. Review-assurance guidance must be generated from the canonical DONE/review-assurance predicate so display code does not invent weaker rules.

## Solution Tradeoffs
Prefer early advisory surfacing in status and phase-boundary commands while keeping TEST entry non-blocking unless the canonical lifecycle policy says otherwise. Avoid auto-signing host verdicts, fallback evidence, reviewer evidence, or delivery checks.

## Conversational Texture
The user wants agents to stop discovering one blocker at a time. The CLI should tell the agent why review assurance is required, what material it binds to, which writer is legal, and what cannot be automated.
