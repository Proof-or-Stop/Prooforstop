## Trigger Event
On 2026-06-29 after B-3b9a reached DONE, the user pointed out that the ProofStory plan says the progressive model has four rules while it lists five, and asked whether many milestones should force automatic parallel story development.

## Key Insights
The rule-count mismatch is a straightforward document correctness issue. More importantly, a milestone ledger created before intent collision should be treated as candidate data until the accepted interpretation confirms it, otherwise a wrong early ledger could become gate evidence.

## Solution Tradeoffs
Keep this story docs-only and avoid implementing scheduler behavior now. The plan should require slicing before DEV for oversized ledgers, but leave automatic parallel execution to a dedicated Scheduler, Unattended, or Autopilot development story with dependency and resource checks.

## Conversational Texture
The user is trying to preserve the one-sentence development experience while preventing large requests from becoming either giant stories or uncontrolled parallel work. The wording should stay precise, English-only, and reviewable as an open-source design document.
