## Trigger Event
On 2026-07-01, after B-b596 completed the G01 positive-control baseline, the user said to continue with the second group. The concrete follow-up is G02, the missing-row negative control for the UDM no-false-DONE baseline.

## Key Insights
G01 proved the evaluator can pass when every required row is closed. G02 must prove the opposite boundary: one missing required milestone must stay visible and must block full roadmap completion even when the other fourteen rows look healthy.

## Solution Tradeoffs
The safest slice is a focused synthetic smoke and documentation update rather than broad validation wiring or implementing all remaining groups at once. This keeps the proof narrow and makes the failure condition easy to audit.

## Conversational Texture
The user is validating unattended development against false DONE, so the important outcome is not just a passing test. The output must clearly show that G02 blocks the full completion claim and does not shrink the remaining baseline scope.
