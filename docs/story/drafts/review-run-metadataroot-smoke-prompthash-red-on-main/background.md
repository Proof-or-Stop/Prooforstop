## Trigger Event
On 2026-09-03 the B-83aa CHK-003 implementer reproduced node packages/main/dist/tasks/review-run-metadataroot-wrapper-root-smoke.js failing on the unmodified main dist at 28e6372a03 with invalid Prompt Envelope: legacy ReviewRun promptHash does not match the frozen legacy role body (Proof B, rr-mr-e2e-1), identical to the failure already drafted for evidence-state-gate-smoke.
## Key Insights
Neither smoke is registered in proof-or-stop.config.json validate.commands or in the root test:serial-reference chain, so proof-or-stop validate and npm test never run them and the legacy promptHash drift stayed invisible; both fixtures exercise the legacy v1 ReviewRun envelope path, so one fix covers both.
## Solution Tradeoffs
Option one re-derives the legacy promptHash in the fixtures from the current frozen role body so the smokes track the contract; option two freezes a byte copy of the legacy body inside the fixtures, stable but hiding real drift; option three retires the legacy v1 path and deletes both smokes if nothing else depends on it. Option one, followed by registering both smokes, is preferred.
## Conversational Texture
The user asked for the gate-layer defects to be driven to DONE through the normal process; this side finding is pre-existing on main and not acceptance-blocking, so it is deferred as a draft per the defect-triage rule and cross-referenced with the earlier evidence-state-gate draft.
