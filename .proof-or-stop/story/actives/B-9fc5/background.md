## Trigger Event
B-43de reached DONE with a valid ProofStory parent ledger, but the user asked whether the original ten-milestone strengthening roadmap was truly complete. The answer was no: S0 was complete, M4 was partial, and M5-M12 still needed child stories.

## Key Insights
B-5082 protected the scoped story intent correctly, but it did not prove that the broader user intent was fully satisfied across a parent roadmap and child milestones. The missing layer is a cross-story totality gate.

## Solution Tradeoffs
The plan should not pretend to implement the runtime gate immediately. It should first define the contract, data model, rollout, verifier, and DONE claim boundary so future implementation stories can be mechanically checked.

## Conversational Texture
The user is pressing on a real trust gap: a small story can be DONE while the larger requested roadmap is not. The plan must make that mismatch visible and prevent future summaries from sounding complete when only a parent ledger is complete.
