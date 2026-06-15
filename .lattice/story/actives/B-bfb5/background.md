## Trigger Event
On 2026-06-15, docs/audits/lattice-token-cost-and-takeover-audit.md identified repeated full agent prompt snapshots as a concrete Lattice token-cost problem and the user asked to turn it into an independent optimization story. This story tracks that work separately from B-59a6 and other active lifecycle stories.

## Key Insights
The audit is executable enough to seed implementation because current code confirms the main facts: many .claude agent templates contain large koala:start snapshots, prompt-registry and managed-assets/global-thin mechanisms already exist, and init/scope/delivery signatures do not read template bytes. The billing impact still needs measurement caveats because prompt cache behavior is unknown.

## Solution Tradeoffs
Prefer a narrow safety-preserving refactor: generate or resolve smaller load-bearing prompt slices from a registry and add opt-in slim read output. Avoid arbitrary compression, prompt rewrites, Authority Server changes, or reviewer gate relaxation. The implementation must prove that fresh-context and flow-fact semantics remain intact.

## Conversational Texture
The user wants lower Lattice token cost without losing the reliability gained from multi-host review, signed evidence, and lifecycle gates. The useful result is not a generic cleanup but a mechanically verified reduction path that keeps correctness and logic consistency explicit.
