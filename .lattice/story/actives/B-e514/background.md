## Trigger Event
On 2026-07-14, direct inspection found that both root entry documents duplicated hundreds of lines of stale lifecycle guidance instead of acting as concise global-thin host entrypoints.

## Key Insights
AGENTS.md and CLAUDE.md are filename-contract entrypoints for their respective hosts. Shared host-neutral guidance belongs behind the .lattice/Lattice.md pointer, while each root file should retain only minimal host-specific directions.

## Solution Tradeoffs
The requested scope deliberately changes only the two root Markdown files. This removes stale duplication quickly, while template or runtime managed-asset alignment remains outside this document-only story and must not be implied as delivered here.

## Conversational Texture
The user first questioned the oversized CLAUDE.md, then asked about AGENTS.md, and explicitly confirmed that both files should function as entry pointers. The user requested modifying them first and creating the Story afterward.
