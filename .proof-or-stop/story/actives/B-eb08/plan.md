# B-eb08 Plan

## CHK-001 Define and emit done_prepare closure progress labels

Add a narrow progress-reporting layer around post-validation done_prepare phases in packages/main/src/handlers/done-prepare.ts. The labels must follow the execution document M1 contract and remain diagnostic output only. JSON mode must keep stdout parseable by routing progress to a safe side channel or helper path that tests can verify.

Implementation steps:
- Identify post-validation phase boundaries already present in runDonePrepare: doneClosure, runtimeChange, cleanTree, and final DONE command rendering.
- Emit progress labels before each phase and keep step status rendering unchanged.
- Avoid changing review, delivery, DONE, Authority, or production readiness semantics.

Verification:
- Focused smoke proves human output includes the M1 closeout labels.
- Focused smoke proves --json stdout remains parseable.

## CHK-002 Add independent hard deadlines for heartbeating closeout phases

Add a bounded phase wrapper for heartbeating closeout work. Heartbeat/progress output must never be the only thing keeping a stuck phase alive; each heartbeating phase needs an independent phase deadline and an attributed timeout error.

Implementation steps:
- Add a small helper that reports phase start/progress and enforces a configurable phase timeout.
- Use the helper around post-validation phases that may otherwise go silent.
- Keep default behavior conservative and testable with short env-configured timeouts in smoke tests.

Verification:
- A slow-but-finishing phase succeeds.
- A deliberately hung heartbeating phase fails closed by the phase deadline even though progress output continues.

## CHK-003 Add regression coverage for human and JSON liveness contracts

Create packages/main/src/tasks/done-prepare-closure-heartbeat-smoke.ts and wire it into package scripts only if existing task conventions require that. The smoke should be hermetic and should not depend on B-783c activity-log persistence.

Implementation steps:
- Build a fixture or helper-level test that exercises progress labels, JSON stdout cleanliness, and phase timeout behavior.
- Run npm --prefix packages/main run build before executing the smoke from dist.
- Record evidence for each verificationIntent and checklist item.

Verification commands:
- npm --prefix packages/main run build
- node packages/main/dist/tasks/done-prepare-closure-heartbeat-smoke.js
- node packages/main/dist/tasks/validate-progress-heartbeat-smoke.js
