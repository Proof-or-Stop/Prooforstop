## Trigger Event
On 2026-06-20, story B-3321 produced the accepted DONE Full-Test Gate Execution Plan after validating that ordinary lattice validate evidence can be narrower than root npm test, so local DONE can overclaim full-suite assurance.

## Key Insights
The fix must separate fast routine validation from DONE-required validation. Evidence must be hash-bound to current head, material, story files, and policy/command set so stale full-suite receipts cannot satisfy DONE.

## Solution Tradeoffs
Prefer an opt-in DONE-required profile or doneRequiredCommands path rather than appending root npm test to validate.commands. This keeps external users fast by default while making the self-host repository strict.

## Conversational Texture
The user wants Lattice to become more reliable without turning every project into an expensive full-suite runner. The implementation needs mechanical gates, clear output, and no hidden semantic drift.
