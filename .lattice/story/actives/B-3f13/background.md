## Trigger Event
2026-06-20 user asked to remove specific Koala current-surface residues after grep showed CLAUDE.md, .gitignore, .lattice/Lattice.md, lattice-handoff.ts schemaVersion strings, and draft-check-hash.ts salt still expose the old brand.

## Key Insights
The current koala-residue gate passes because many tokens are classified as legacy logic, but the requested files are current user/runtime surfaces. Removing them requires coordinated docs, runtime artifact names, schema literals, and tests.

## Solution Tradeoffs
We should keep historical archives and old story evidence out of scope, while renaming active paths and wire strings in code. Handoff schema removal can break old projections, but the user explicitly does not need legacy compatibility.

## Conversational Texture
The user wants a concrete cleanup, not a new broad audit. We should make the smallest effective change, prove it with build/smoke/targeted grep, and clearly separate official gate pass from stricter selected-token cleanup.
