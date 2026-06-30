## Trigger Event
B-9fc5 created the plan-only execution baseline after B-43de showed that parent governance DONE can be correct for a scoped story while the larger roadmap still has child-story-needed rows. The operator now explicitly asked to implement that plan until DONE.

## Key Insights
B-5082 protects story-local intent and milestone scope, but it does not by itself provide cross-story parent-child totality. The missing layer must compute allRowsClosed, preserve partial_parent_done, and prevent no full-roadmap claim violations when child rows remain open.

## Solution Tradeoffs
The implementation should layer on existing ProofStory controls instead of replacing them. It must start with Red/Repro tests to prove the current overclaim risk before runtime changes, then add a model, evaluator, claim consumer, CLI surface, migration path, and certification.

## Conversational Texture
The user is correcting a repeated process failure where a parent story can be marked DONE and later sound like the whole roadmap was complete. The important product outcome is not just another ledger, but an operator-visible gate that makes partial versus full completion impossible to blur.
