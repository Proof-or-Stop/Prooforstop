## Trigger Event
On 2026-09-06, Story B-bcae reached REVIEW and every required reviewer lane failed before receiving a reviewRunId because its explicit negative context was classified as unsafe triage authority. The exact failure was reproduced by concept, quality, and test-coverage reviewers.

## Key Insights
The safety guard is necessary and must continue rejecting affirmative, ambiguous, or joined-clause attempts to assign lifecycle authority. The defect is narrower: a complete explicit negative assertion is combined with later ordinary scope prose and loses its negative meaning during whole-source relation scanning.

## Solution Tradeoffs
A broad natural-language parser would increase complexity and create new bypass risk. Rewording B-bcae would not repair the lifecycle trap. The bounded choice is a small structural negative grammar plus fixtures that prove the reproduced safe case passes and representative positive or ambiguous authority cases still fail.

## Conversational Texture
The user authorized continuing until DONE, including this supporting repair, after the normal metadata correction path proved unavailable in REVIEW. The repair must remain local, independently reviewed, and mechanically verified before it is used to resume B-bcae.
