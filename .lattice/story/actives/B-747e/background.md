## Trigger Event
On 2026-06-16, continuing the ship-clean koala-removal program (after story B-08f2 renamed the env-var contract), a scan for Koala* PascalCase code identifiers found exactly one: the `KoalaConfig` interface in packages/main/src/core/config.ts, referenced in 5 files (~20 occurrences).

## Key Insights
`KoalaConfig` is the project-config type returned by `loadConfig()` and used by DEFAULT_CONFIG and a module-level cache; it is a small, clean, mechanical rename to `LatticeConfig` with no behavior change. It is the ONLY remaining Koala* PascalCase identifier (grep confirms no other), so this fully clears the code-identifier category of the residual sweep. The larger residual (fixtures, comments, doc prose) is judgment-laden and deferred to separate slices.

## Solution Tradeoffs
Rename the interface and all type references KoalaConfig -> LatticeConfig; keep an exported alias only if a consumer outside this repo needs it (none — no external users yet, this is OSS prep). Verify with a build (type resolution) and the e2e suite. Out of scope: koala.config.json fixture filenames, koala prose/comments, the lab project-config.ts reader, the .koala path layer.

## Conversational Texture
The user is driving the OSS launch and wants koala gone; after the big B-08f2 env-var story they asked to keep going. This focused identifier rename gives a clean, low-risk, concrete next step rather than barreling into the murky 310-file residual sweep, which needs its own decomposition and fresh context.
