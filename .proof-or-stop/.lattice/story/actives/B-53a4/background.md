## Trigger Event
On 2026-07-07 the user explicitly asked to upgrade manual milestone_ledger_set/add into automatic writes at planning write points, while also challenging whether the current ledger behavior was already automatic. This needs a code story because the existing implementation writes real milestone-ledger.json only through explicit ProofStory commands.

## Key Insights
The important boundary is that milestone_status must remain read-only, and no prose or checklist text should be interpreted as hidden milestone rows. The only safe automation is to accept already-structured milestone rows at a command that is already mutating planning metadata.

## Solution Tradeoffs
The narrow implementation should reuse the existing buildMilestoneLedger/writeMilestoneLedger path so schema validation, duplicate rejection, candidate state, and later intent-collision confirmation semantics stay identical to milestone_ledger_set. Avoid broad generation logic, natural-language parsing, and automatic add loops.

## Conversational Texture
The user is testing whether this can be implemented directly rather than expanded into more planning documents, so the work should stay code-and-test focused. The final answer should clearly separate real milestone-ledger.json writes from checklist-derived display output.
