## Trigger Event
On 2026-06-23, live Authority runner tests hit claimed-job-story-mismatch because a runner claimed stale queued jobs left by earlier Tier-C tests instead of the current story job. Server story B-28c5 added signed claim selectors, but CLI live claims must send those selectors for the protection to apply.

## Key Insights
The server cannot infer a runner intended story from a broad claim without risking hidden policy guesses. The host-neutral contract is cleaner when the client declares story intent in the signed claim and the server enforces it before leasing. SSE remains an advisory hint and must not become a second ownership path.

## Solution Tradeoffs
Prefer a narrow CLI claim-payload fix over adding queue purge, cancel endpoints, or arbitrary retry loops. Broad claims should remain possible for generic runners, but story-bound live runner flows should include storyId and exact continuation flows may include jobId later.

## Conversational Texture
The user is frustrated because each layer has revealed another small mismatch. The work should stay boring and precise: make the client send the identity the server now understands, prove it in smokes, and avoid broad redesign or extra operator ceremony.
