## Trigger Event
On 2026-07-01, after B-e891 completed the G02 missing-row baseline, the user asked to continue the next group. The next documented row in the 10x15 baseline is G03: prose closure without machine evidence must not satisfy DONE.

## Key Insights
G03 protects a different failure mode than G02. The ledger can contain all 15 required rows and every row may contain confident completion wording, but without command-backed closure evidence those rows must remain open and the parent rollup must refuse full completion.

## Solution Tradeoffs
Implement one standalone deterministic smoke for G03 and update only the baseline document. Do not change the parent-roadmap evaluator and do not implement G04-G10 in this story, because each negative-control group should remain independently auditable.

## Conversational Texture
The user is building the UDM no-false-DONE baseline group by group and wants each completed group to prove one specific anti-false-DONE behavior. The third group should be clear, runnable, and bounded rather than broadening into the full 10x15 suite.
