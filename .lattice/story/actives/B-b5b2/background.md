## Trigger Event
On 2026-06-11, the user asked whether root-level documents should be moved to the correct places after we found many Lattice baseline and execution-plan documents sitting beside README and agent entrypoint files. This needs a small documented migration guide rather than ad hoc file moves.

## Key Insights
The root directory mixes true entrypoints such as README, AGENTS, CLAUDE, and KOALA compatibility assets with requirements decisions, baseline plans, overview notes, and personal notes. Moving them blindly would break references and collide with active Layer4 work.

## Solution Tradeoffs
Prefer a scoped migration guide and reference inventory first, not a bulk rename. The guide should say what remains at root, what belongs in requirements decisions, guides, notes, or archive, and how redirects or reference updates should be handled later.

## Conversational Texture
The user wants the repository to feel cleaner and more deliberate, but also expects Lattice discipline: no arbitrary optimization, no mixing with unrelated runtime upgrades, and no claim that Production Safety or global capability is unlocked just because documents are reorganized.
