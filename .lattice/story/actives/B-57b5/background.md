## Trigger Event
B-0717 documented cli-engine.ts still contains lifecycle dispatch and INIT_CHECK metadata logic inside the same god file. On 2026-06-19 the user asked to start the architectural split, but this final slice depends on earlier module boundaries being stable.

## Key Insights
Lifecycle dispatch, INIT_CHECK metadata, and merge-main recovery are tightly coupled to story phase transitions and git state. They should be extracted last so command catalog, help parsing, and gate helper modules already provide stable imports.

## Solution Tradeoffs
This story is intentionally dependent on B-74a0, B-a776, and B-6e69. The tradeoff is slower start, but it avoids rewriting the most safety-sensitive runCli path while surrounding modules are still moving.

## Conversational Texture
The user asked for multiple stories and multi-host development, but also called this a major architecture拆解. This story marks the final integration pass and should receive the strongest review/validation once earlier hosts finish their slices.
