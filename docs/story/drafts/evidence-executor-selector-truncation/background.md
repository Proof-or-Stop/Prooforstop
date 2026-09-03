## Trigger Event
On 2026-09-02 story B-41c8 could not re-enter REVIEW: after its CHK-004 audit block grew, the three CHK-004 selectors moved past the first 12000 characters of the smoke output and verification_evidence_add refused every one with [receipt_selector_absent] although the smoke passed 37/37 and the selector lines were printed verbatim (offsets 12681, 13241, 14450 of 14759).

## Key Insights
A receipt must be bounded, but the judgement of whether the proof selector appeared must not be. Truncating the output before the selector check turns a storage limit into a false verification failure, and because refresh_stale demotes the old receipt on that failure, the story loses mechanical coverage it actually has. Head-only truncation is also the wrong shape for a receipt: the final PASS or FAIL line of a long suite is the first thing cut.

## Solution Tradeoffs
Match over the full output and store head-plus-tail (chosen: correct and cheap, the full output is already in memory) versus raising MAX_OUTPUT_CHARS (only moves the cliff) versus asking every suite to print its selector early (pushes an executor defect onto every fixture author and contradicts the natural place of a summary line). B-41c8 shortened its own audit block as a workaround but that does not fix the executor.

## Conversational Texture
The user asked that defects blocking a story be fixed in place and that non-blocking framework defects be recorded with evidence for a later owner; the executor change is out of B-41c8 scope (core/validation-executor.ts is not in its contract), so the story shortened its output and left this record.
