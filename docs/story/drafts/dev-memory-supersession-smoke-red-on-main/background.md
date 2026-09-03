## Trigger Event
On 2026-09-02 the B-c86f CHK-001 implementer ran node packages/main/dist/tasks/dev-memory-supersession-smoke.js as a side check and it failed with AssertionError: 34e97f9 should use current product names; the same failure reproduces on the unmodified main dist at /Users/jek/Documents/GitHub/Prooforstop.
## Key Insights
The smoke pins five project rows as current-product-name rows, but row 34e97f9 predates the identity cutover and still reads Proofbound/Lattice. The smoke is not part of proof-or-stop validate (not in proof-or-stop.config.json), so nothing blocks DONE today, which is exactly why the red went unnoticed since the e07d27d450 merge.
## Solution Tradeoffs
Option one supersedes the row through dev_memory_capture with a supersedes-34e97f9 tag so history stays append-only. Option two rewrites the row in place, which the dev-memory design discourages. Option three relaxes the smoke to only assert rows written after the cutover. Option one is preferred.
## Conversational Texture
The user asked for the four framework defects to be driven to DONE; this side finding is deferred as a draft per the defect-triage rule because it is medium severity and not acceptance-blocking for any of those stories.
