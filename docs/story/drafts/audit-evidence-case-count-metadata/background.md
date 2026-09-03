## Trigger Event
B-d854 final concept review found that checklist verification prose still calls CASE 42 the last case even though the hardened verifier now executes through CASE 46.

## Key Insights
This is metadata wording drift rather than a false-green result because the tool-owned receipt also requires process exit zero and captures CASE 46 plus the final verifier marker.

## Solution Tradeoffs
Do not reopen the current acceptance scope solely to rewrite immutable plan-era wording; preserve the finding and handle the metadata cleanup in a focused follow-up.

## Conversational Texture
The operator requires nonblocking defects to have reproducible evidence, impact, and an explicit later owner rather than being silently ignored in pursuit of a nominally green Story.
