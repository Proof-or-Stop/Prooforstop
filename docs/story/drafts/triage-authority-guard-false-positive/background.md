## Trigger Event
On 2026-09-03, every reviewer lane on story B-1482 failed at review_run_start with REVIEW Task Context contains unsafe Finding-triage authority at checklist.CHK-003.context. A reviewer isolated the cause by extracting classifyControlledRelationSegment from the compiled prompt-envelope and running it over the checklist text: the only failing segment was a sentence about the story own priority elevation, which contains the word priority and the phrase the story within 260 characters.

## Key Insights
The guard protects something real: a checklist must not tell a reviewer that a severity level alone decides ownership or scope. But proximity is not a relation. Any sentence that mentions priority and the story together trips it, and because the check runs at review_run_start rather than at checklist write time, the failure appears much later, applies to every lane at once, and has no override, so the only exit is to reword the checklist of a story that did nothing wrong.

## Solution Tradeoffs
Require a grammatical relation between subject and outcome, which is precise but needs more parsing; or narrow the term lists so bare priority and bare the story cannot pair, which is cheap but may miss a paraphrase; or move the check to checklist write time, which gives a fast signal but does not fix the false positive itself. The first two are compatible and both need the true-positive fixture to prove the guard still bites.

## Conversational Texture
Recorded during B-1482 rather than fixed there: the story was mid-REVIEW on an unrelated evidence-gate change, and widening it to a prompt-envelope guard would have mixed two subjects. B-1482 worked around it by rewording its own checklist context.
