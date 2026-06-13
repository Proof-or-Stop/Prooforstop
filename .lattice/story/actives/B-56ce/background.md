## Trigger Event
During B-160f flow feedback on 2026-06-13, validation, stale evidence, owner lease, delivery-check, and codex namespace recovery paths were reported as hard to recover from even when the underlying Lattice gates behaved correctly.

## Key Insights
Initial inspection shows the gate mechanisms are mostly doing their job: timeout is treated as a failure, stale evidence is detected, owner lease blocks foreign mutation, and delivery-check remains a DONE hard gate. The real problem is that several CLI messages do not tell the operator the safest next command or the exact meaning of the gate failure.

## Solution Tradeoffs
The solution should improve diagnostics and narrowly compatible aliases rather than weakening gates or inventing broad automation. In particular, delivery-check fallback must preserve independent reviewer provenance, owner lease takeover must remain explicit, and timeout guidance must not convert a real failing test into a pass.

## Conversational Texture
The user is asking for Lattice flow correctness, not cosmetic copy edits. The work should stay host-neutral across Codex, Claude, and local shells, and follow the stated discipline: no arbitrary optimization, no optimization for its own sake, only real correctness issues, and consistent logic.
