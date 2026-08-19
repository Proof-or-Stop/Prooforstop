## Trigger Event
2026-06-22 audit of Proofbound clean export found concrete cleanup candidates: root package keeps an unused MCP dependency, implementation-review handler is defined but unreachable, intent coverage code is legacy-only, one-time migration scripts remain active-looking, and package-local docs/story/actives residue sits beside current .lattice story state.

## Key Insights
This is not a general optimization pass. The cleanup target is code whose current product relationship is mechanically inconsistent: declared but unused dependencies, defined but unregistered command handlers, obsolete coverage helpers, and old metadata paths that can confuse maintainers about the active Lattice lifecycle.

## Solution Tradeoffs
Prefer small correctness fixes over broad rewrites. Keep smoke/regression assets that protect behavior, keep host-neutral Lattice workflow boundaries, and only remove files when static references and package scripts show they are one-time migration residue rather than supported user-facing commands.

## Conversational Texture
The user explicitly approved this cleanup order and asked to execute it through stories until complete. The work should stay disciplined: do not optimize for optimization, do not optimize arbitrarily, only fix real correctness issues, and preserve consistency of logic.
