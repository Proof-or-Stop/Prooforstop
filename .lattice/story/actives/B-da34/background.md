## Trigger Event
On 2026-06-29, after B-576e reached DONE, the user identified that the earlier five-milestone Authority Server cleanup promise had been narrowed into active-semantics retirement instead of full vocabulary, command, code/test, and guard removal. This story exists to bind that original five-milestone intent without discount.

## Key Insights
The failure mode is not only stale wording; it is an intent-to-contract loss. A story can be DONE while the original milestone promise is incomplete if the milestones are not encoded as verifiable checklist items and validation gates.

## Solution Tradeoffs
The safe path is stricter than B-576e: freeze vocabulary, clean user-facing surfaces, remove active command surfaces, delete or quarantine server-backed Authority code/tests, and add a hard scanner. The tradeoff is a larger diff and possible legacy compatibility breaks, which are acceptable for this user-requested cleanup.

## Conversational Texture
The user explicitly said the five milestones must be completed with no discount until DONE. The implementation must therefore avoid softer language like retire active semantics when the requested outcome is physical removal or quarantine plus hard validation.
