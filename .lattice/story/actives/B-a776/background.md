## Trigger Event
B-0717 and the 2026-06-19 development request identified cli-engine.ts as still too large and growing. After B-74a0 extracts the command catalog, the next separable block is flags, help text, aliases, and dry-run parsing.

## Key Insights
Help rendering and flag parsing are broad user-facing surfaces but should not need lifecycle gate internals. They can be extracted behind pure functions once MAIN_TOOLS and command definitions have a stable module boundary.

## Solution Tradeoffs
This story should wait for B-74a0 to avoid import churn. The upside is a low-risk user-facing slice with strong smoke tests for --help, --json, aliases, and dry-run behavior; the tradeoff is that it does not reduce lifecycle complexity yet.

## Conversational Texture
The user wants parallel work, but not chaotic edits to the same file. This story is prepared as a second host slice once Round 1 lands, making the plan visible without forcing simultaneous edits over the same catalog block.
