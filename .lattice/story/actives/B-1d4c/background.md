## Trigger Event
On 2026-06-20, story B-0607 captured a truth-first host handoff stale-doc guard plan after repeated host confusion from stale/legacy plan data.

## Key Insights
Host transition must be deterministic across multiple hosts. Without an enforced fact preflight, hosts can resume from out-of-date context and duplicate work.

## Solution Tradeoffs
We should ship a lightweight fact bundle and handoff precheck gate before accept/resume. This adds upfront validation but avoids repeated wrong assumptions and lowers reviewer load when doing 3x2/2-host verification.

## Conversational Texture
Users should be able to hand off work between hosts and get the same accurate state without repeatedly explaining what already happened in previous runs.
