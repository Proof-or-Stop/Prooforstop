# PLAN — quorum_submit duplicate-runId guard (B-5c79)

## Overview
Add a guard in the `quorum_submit` handler that refuses to re-emit a quorum for a runId that already
carries a verdict at the same `materialDigest`, while still allowing a fresh quorum after the material
changes. Update the smoke test accordingly.

## CHK-001
In `packages/main/src/handlers/quorum-submit.ts`, after `materialDigest`/`storyFilesHash` are computed
and before the emit loop, compute the planned runIds (`${storyId}-q-r1..rN`), read existing verdicts via
`listVerdicts(ctx.root, 'local', storyId)`, and refuse if any existing verdict has a planned runId AND
the same `materialDigest`.

## CHK-002
The refusal throws an Error naming the colliding runId(s) and explaining that re-submitting would
duplicate the quorum (matching the existing `REFUSAL` style). No verdicts and no host_verdict events
are written on refusal (the guard runs before the emit loop).

## CHK-003
A fresh quorum after the material changes is NOT blocked: because the guard keys on
`(runId, materialDigest)`, existing verdicts at a prior materialDigest do not collide with the new one.

## CHK-004
Update `packages/main/src/tasks/quorum-submit-smoke.ts`: restructure the rounds-knob case so it does
not re-submit overlapping runIds at the same material; add a case asserting a same-material re-submit
refuses and writes no new verdicts; add a case asserting a re-quorum after a material change succeeds.

## CHK-005
Build `packages/main` and run the quorum-submit smoke + the full test suite green.

## Out of scope
No changes to `core/verdicts.ts`, the runId scheme, escalation/floor logic, or any other handler.
