## Trigger Event

Hit live on B-4043 during TEST-to-DONE closeout on 2026-07-27. Host verdicts existed at materials 443a65aa66cc and 329b38c4807a, both carrying storyFilesHash f29641b7d99d. With 329b38c4 current, the review-assurance floor reported exactly '0/3 rounds x 2 hosts (submitted=3, complete=false)' and DONE was unreachable for hours. It cleared only by accident: merging main moved storyFilesHash to f25bb43b739c, which stopped the old verdicts from downgrading onto the new material.

## Key Insights

The collision is produced by two individually reasonable mechanisms meeting. The downgrade exists so that unrelated whole-tree drift does not invalidate a verdict whose story-owned files never moved; the identity grouping exists so that one host cannot vote twice in a round. Neither is wrong alone. The defect is that the downgrade synthesises an at-current-material verdict that is byte-distinct on disk yet identity-identical to a live one, and the grouping cannot tell a superseded record apart from a genuine double vote. A reproduction was written before any fix: with only the current-material submission the fixture yields 3/3 valid rounds, and adding the superseded submission drops it to 0/3 with six manufactured duplicate-identity reasons, while all twelve verdicts remain distinct on disk.

## Solution Tradeoffs

Option A: during the downgrade, skip rewriting a verdict when the same (runId, host identity) already has a verdict natively at the current material. Preserves both mechanisms, keeps the advisory, and is the smallest change; chosen. Option B: make quorum runIds round-scoped so a fresh review round mints new runIds. This would let the gate's own prescribed remedy work, but it changes the quorum identity scheme and every consumer that assumes the fixed names. Option C: have the grouping prefer the newest verdict per identity instead of failing the round. Rejected because silently picking a winner weakens a real double-vote check. Option D: leave it and rely on the human fallback. Rejected because the wedge is reachable by ordinary parallel development and the escape is not discoverable.

## Conversational Texture

The operator asked for a red reproduction before any fix, which is what located the true cause. Two earlier explanations offered during the incident were wrong and were retracted: first that the floor counts by review round while the duplicate guard keys on material, then that a stale validationDigest invalidated the verdicts. Neither survived reading the code. The reproduction should therefore be landed as a permanent registered red test, not just quoted in the fix commit.
