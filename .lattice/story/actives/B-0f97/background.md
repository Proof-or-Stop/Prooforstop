## Trigger Event

Story B-7dff, 2026-08-19. Its DONE attempt failed with "ProofStory intent equivalence gate did not pass — stale_milestone_evidence: M1", after seven passing lifecycle steps. The cause was a permanent waiver on CHK-001:happy:0 still bound to a hash from before the closeout merge. Two independent test-coverage reviewers then filed B-7dff:F-016 and B-7dff:F-017 for the identical problem on the twin waiver CHK-005:happy:0, which sat 106 commits behind HEAD.

## Key Insights

The refresh command is the tool an operator reaches for to answer "is my evidence current", and for waivers it answers with silence rather than with a negative. packages/main/src/handlers/evidence-refresh.ts excludes waiver rows in refreshOnlyDrift()/isWaiver() before checkEvidenceFreshnessForGit ever runs, so --dryRun reports "No stale verification evidence" for a story whose waiver bindings are months of commits out of date.

The failure surfaces at the worst possible moment. milestone_status flags the staleness but explicitly disclaims being a lifecycle gate, so two reviewers reasonably characterised it as benign lag; done_intent_equivalence_check consumes the same coverage relation and does block. The operator therefore learns about it at the final DONE step, after reviewer receipts and quorum have already been minted, and fixing it invalidates all of them.

There were exactly two waivers in that story and the same defect class hit both, one after the other, because fixing the first did not surface the second.

## Solution Tradeoffs

Option A, include waivers in the refresh scan and restamp them automatically: closes the detection gap and the correction gap in one step, and costs nothing at runtime since no command re-execution is needed. Risk is that a waiver silently following the tree could mask a case where the reason for the waiver stopped holding.

Option B, report waiver staleness but require an explicit operator rebind: keeps a human judgement in the loop about whether the waiver reasoning still applies, at the cost of a manual step in every closeout that carries a waiver.

Option C, exclude waiver bindings from the consuming gates instead, on the grounds that a waiver is a structural claim independent of tree state: simplest, but it weakens a freshness invariant rather than fixing a blind spot, and it would need a clear argument for why intent-equivalence should trust an unbound row.

## Conversational Texture

Found while driving B-7dff to DONE under an instruction to follow the whole process without escalating routine decisions. What makes it worth recording is the reasoning failure it produced rather than the code defect: the phrase "not currently consumed by a blocking gate, therefore benign" was used to wave the staleness through twice, once by two reviewers on M1 before a gate proved otherwise, and once by me on the twin waiver immediately after I had written down why that reasoning was wrong. A reviewer filed it against me the same round.
