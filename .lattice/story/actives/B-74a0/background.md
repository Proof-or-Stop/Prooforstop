## Trigger Event
B-0717 documented that cli-engine.ts remains a god file at more than 4400 lines after prior naming cleanup. On 2026-06-19 the user asked to start actual development and split the file through multiple stories and hosts rather than leaving only an execution document.

## Key Insights
The largest stable region is the command catalog: ToolDef declarations, zod schemas, MAIN_TOOLS, and registry assembly. Extracting this first creates a clean import boundary that later help, flags, runtime, and lifecycle stories can reuse.

## Solution Tradeoffs
This story should preserve behavior and keep cli-engine.ts as the entrypoint shim. The tradeoff is a smaller first extraction instead of touching dispatch logic immediately, because command catalog churn is broad but mechanically verifiable with build and contract checks.

## Conversational Texture
The user explicitly does not want another documentation-only pass. This story is the first engineering slice of the cli-engine split and should be suitable for one host to own while other hosts work on non-overlapping follow-up slices.
