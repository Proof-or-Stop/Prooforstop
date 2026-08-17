## Trigger Event
On 2026-07-02, after B-7b4e completed the Quantum M0-M1 local evaluator and the framework document was added, the user asked to execute the remaining milestones until each is DONE. The next ordered milestone is the shared ClaimAdmissibilityPack interface and registry.

## Key Insights
Quantum and PINN should not each invent their own pack loader, proof storage, or gate stack. The safest first implementation is a narrow typed contract and read-only registry that describes packs while preserving the existing proof-admissibility evaluator as the only proof-admissibility core.

## Solution Tradeoffs
Implement only M1 now: types, validation, listing, and smoke tests. Do not implement verifier execution, lifecycle gate policy, benchmark harnesses, or production readiness claims in this story. Later Quantum stories can consume this registry rather than duplicating registry semantics.

## Conversational Texture
The user wants the milestones finished, but also wants strict evidence and proof-or-stop discipline. This story keeps progress concrete while preventing the framework from becoming a second hidden proof manager.
