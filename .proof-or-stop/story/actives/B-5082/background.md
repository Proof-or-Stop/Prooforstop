## Trigger Event
After B-f7b7 reached DONE on 2026-06-30, the user asked for a line-by-line document audit and the audit found that several M0-M9 commitments were only MVP-complete, not fully complete.

## Key Insights
The existing ProofStory implementation has command registration, diagnostics, and MVP gate wiring, but the document also promises active prompt integration, parent-child slicing semantics, parent roll-up, lightweight single-outcome DONE equivalence, red freshness binding, spike disposable-code policy, and high-assurance review closure.

## Solution Tradeoffs
The follow-up should finish these missing commitments through existing Lattice lifecycle gates rather than creating a second lifecycle. It should keep rollout risk-adaptive and avoid forcing heavy ProofStory overhead onto simple stories while making enforce mode mechanically meaningful.

## Conversational Texture
The user wants an explicit checklist where each unfinished item is completed and marked done. The implementation should therefore be milestone-shaped, auditable, and evidence-backed, with each completed milestone reported clearly.
- User explicitly requires every completion mark to be preceded by a document cross-check. For each checklist item, before calling checklist_update status=done or showing ✅, record the relevant document commitment, implementation evidence, and verification/gate evidence.
