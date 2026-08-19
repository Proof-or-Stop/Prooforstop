## Trigger Event
2026-06-30 user approved enabling the ProofStory gates after B-5082 completed the M0-M9 implementation and a follow-up audit found the repository config still defaulted to observe mode.

## Key Insights
The implementation exists and tests pass, but without project-level proofStory enforce settings the gates remain diagnostic only. This rollout must change configuration and prove the story itself can satisfy the new gates.

## Solution Tradeoffs
Setting all three modes to enforce gives the intended no-DEV-before-ProofStory and no-DONE-before-equivalence behavior, while existing active stories may need to add missing artifacts the next time they advance.

## Conversational Texture
The user wants the mechanism treated as solved and activated, not discussed indefinitely. Keep the change small, verifiable, and explicit about what is now enforced.
