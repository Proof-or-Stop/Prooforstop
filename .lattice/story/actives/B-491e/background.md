## Trigger Event
On 2026-06-19 the user confirmed that bundle generation belongs in the private Lattice Authority Server and should not remain in the open-source Lattice CLI.

## Key Insights
The CLI can stay open-source friendly by consuming provided env files and receipt refs, while server-owned generation of API keys, trust files, and senior identity material remains private.

## Solution Tradeoffs
Remove generation behavior and docs that tell developers to generate bundles locally, but preserve consumption and compatibility for reading server-provided env/config values.

## Conversational Texture
The user wants the developer experience to become simpler, not more magical: developers receive files from the server operator and the CLI uses them without pretending to own their creation.
