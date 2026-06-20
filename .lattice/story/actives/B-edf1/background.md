## Trigger Event
On 2026-06-20, a genuine Codex host-2 soundness review of merged story B-5a9a (the secondary storyFilesHash feature) found that the MANDATORY whole-tree-drift re-attestation advisory is silently dropped on the DONE success path. B-5a9a accepts host verdicts whose materialHash drifted when storyFilesHash still matches, but the operator never sees the required advisory at DONE.

## Key Insights
eventsWithStoryFilesHashDowngrade (review-escalation.ts:408) pushes a re-attestation advisory into escalation.advisories when it downgrades a drifted host verdict. The report carries it (advisories field, review-escalation.ts:67/121/466). BUT the DONE gate omits it on the pass path: done-oracle.ts:710 renders the Review-escalation row hint as the generic "review escalation satisfied or not required" when escalation.ok===true (advisories never read), renderDoneChecklist prints pass-row detail but not pass-row hint, and the machine.ts:882 DONE guard falls through on ok===true. So whole-tree material drift can pass DONE with NO visible advisory — directly violating the B-5a9a design doc invariant "The warning is mandatory ... Operators and reviewers must see that unrelated whole-tree material drift occurred."

## Solution Tradeoffs
Surface escalation.advisories on the DONE Review-escalation PASS path via the always-printed row detail (not the hint, which renderDoneChecklist skips on pass rows). Keep the row a PASS — the design is valid-with-advisory, NOT a block (blocking would over-correct and re-introduce the instant-reject churn B-5a9a removed). Do NOT change the sound downgrade-accept logic. Add a smoke proving the advisory shows on a downgrade-accepted DONE and is absent when there is no drift. Out of scope: changing the downgrade logic, the floor evaluator, or blocking DONE.

## Conversational Texture
A cross-session genuine 2-host review (Codex host-2) caught this gap that both the main agent and B-5a9a own claude review missed. The operator reviewed the finding and asked to open a dedicated fix story directly rather than file a finding into the already-merged B-5a9a.
