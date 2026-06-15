## Trigger Event
On 2026-06-15, checking B-a57f and B-22b0 showed phase=DONE but done_closure reported evidence-freshness=fail after later main movement.

## Key Insights
The recorded test-evidence headHash/materialHash is historical DONE-time evidence. For already DONE stories, read-only done_closure should not compare that snapshot against current main HEAD after unrelated later material commits.

## Solution Tradeoffs
Fix only the DONE projection/readiness correctness issue. Keep active TEST and DONE-entry gates strict so stale evidence still blocks before completion.

## Conversational Texture
User asked to solve the residual freshness caveat, not to optimize or weaken lifecycle gates broadly.
