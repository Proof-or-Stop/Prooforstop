## Trigger Event
On 2026-06-15, after B-bfb5 reduced package prompt template cost and after document docs/requirements/decisions/lattice-runtime-owned-agent-assets-execution-plan.md passed Claude CLI host audit, the user requested opening a story to execute the plan and to record task token consumption.

## Key Insights
Agent templates should be owned by the local Lattice CLI runtime, not copied into every business project. Offline execution means the installed local Lattice CLI can render prompts locally. Thin prompt config should not be required by default just to use runtime-owned prompts.

## Solution Tradeoffs
Execute only the first implementation slice: inventory, doctor projection, stale asset detection, and measurable token accounting. Do not implement deletion, migration, or broad host adapter rewrites in this story because those are separate correctness-sensitive changes.

## Conversational Texture
The user wants a practical implementation, not another broad optimization. Record token accounting using available mechanical measurements: prompt/template bytes and approximate tokens via bytes divided by four. Also state that exact provider billing tokens for this conversation are not exposed by Lattice CLI and cannot be claimed. Keep all evidence local Non-authority unless Authority Server receipt verification is explicitly performed.
