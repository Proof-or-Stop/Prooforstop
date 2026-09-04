## Trigger Event
On 2026-09-04 the concept reviewer of story B-1482 probed the triage-authority guard after that story narrowed it, and found that settles and resolves bypass the generic-pair disqualification while decides, determines, governs and overrides are caught. It filed the observation as a low finding, verified against main that the same vocabulary already gated the two dedicated detectors before B-1482, and left the disposition to the owner.

## Key Insights
A closed verb list is a defensible design for a heuristic guard, but only if its closedness is visible. Read as written, the guard appears to test for a decisive relation; in fact it tests for membership in five verb families. A maintainer adding a sixth phrasing has no signal that the list is the contract, and a reviewer reading the code can mistake the guard for stronger than it is.

## Solution Tradeoffs
Broadening the test, for example by treating an exclusivity adverb next to any intervening verb as decisive, catches paraphrases but risks new false positives of exactly the kind B-1482 had to fix. Documenting the closedness costs nothing and removes the misreading but leaves the paraphrases uncaught. Pinning the chosen behaviour with fixtures is required either way, because today neither behaviour is asserted anywhere.

## Conversational Texture
Recorded rather than fixed inside B-1482: the limitation is pre-existing, the story was already three review rounds deep on an unrelated evidence-gate change, and widening it to guard vocabulary would have mixed two subjects.
