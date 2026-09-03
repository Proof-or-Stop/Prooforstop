## Trigger Event
On 2026-09-02 the B-83aa CHK-004 implementer surveyed every fixture that seeds review runs with fallback hashes and found that node packages/main/dist/tasks/evidence-state-gate-smoke.js fails on the unmodified main dist at 7de56c4623 with legacy ReviewRun promptHash does not match the frozen legacy role body [review_evidence_invalid].
## Key Insights
The smoke is not registered in proof-or-stop.config.json validate.commands, so proof-or-stop validate never runs it and the red went unnoticed; its fixture roots are git-committed, so the failure is the prompt-envelope legacy promptHash check drifting from the frozen role body, not the freshness predicate B-83aa changed.
## Solution Tradeoffs
Option one re-derives the legacy promptHash in the fixture from the current frozen role body so the smoke tracks the contract; option two pins the fixture to a byte-frozen legacy body copy, which is stable but hides real drift; option three deletes the smoke if the legacy v1 path it covers is retired. Option one is preferred, followed by registering the smoke.
## Conversational Texture
The user asked for the framework defects to be driven to DONE through the normal process; this side finding is unrelated to those stories and is deferred as a draft per the defect-triage rule because it is not acceptance-blocking.
