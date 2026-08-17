# B-c7e2 Plan

## Scope

Implement only Autopilot v2 M1 checkpoint-ledger-backed resume. Candidate repro/spike evidence remains intake evidence and cannot become verificationEvidence, DONE evidence, remote quorum proof, or production proof. M2 provider health/ramp, M3 throttling, M4 process pool/fencing, and duplicate Tier-C story cleanup are out of scope.

## CHK-001

Add the checkpoint ledger and replay projection in packages/main/src/core/lattice-autopilot.ts. The implementation must persist or read committed checkpoint facts from a per-run ledger/snapshot boundary, derive the committed done set, and identify the next pending step. The smoke test must prove committed done checkpoints are not re-dispatched and conflicting/stale checkpoint material fails closed.

## CHK-002

Re-enable autopilot_resume for healthy non-stale runs by replacing the unconditional unsafe_state refusal with M1-safe resume semantics. A stale run must still return refused/stale_state. Resume must keep authorityChanged=false, receiptVerified=false, and productionDone=false, and it must not restart provider work outside the ledger-backed M1 boundary. Update command catalog, command policy, process-fact wording, and existing autopilot smoke expectations so the public surface matches the new semantics.

## CHK-003

Add packages/main/src/tasks/autopilot-resume-smoke.ts and package script wiring. Run npm --prefix packages/main run build, the new autopilot-resume smoke, and the existing autopilot-run smoke. Use Antigravity CLI (agy) as the second-host validation path and do not use Claude CLI. Record verificationEvidence for all checklist items only after the tests pass.

## Validation

Primary commands: npm --prefix packages/main run build; node packages/main/dist/tasks/autopilot-resume-smoke.js; node packages/main/dist/tasks/autopilot-run-smoke.js; lattice validate --story=B-c7e2. Second-host command: agy --print with a concise validation prompt after local tests pass.
