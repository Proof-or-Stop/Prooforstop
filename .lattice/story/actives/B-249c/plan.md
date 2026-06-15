# B-249c Execution Plan

## CHK-001

Goal: reproduce the real post-DONE freshness projection bug in an isolated fixture, not by mutating completed production stories.

Steps:
- Add a done-preflight smoke scenario that creates a DONE story with PASS test evidence bound to an evidence head/material hash.
- Commit a later unrelated material source change after the DONE snapshot.
- Assert `done_closure` for the already DONE story reports `evidence-freshness` as pass once fixed.

Acceptance:
- The fixture is source-driven and isolated in a temp repo.
- Existing stories B-a57f/B-22b0 are not rewritten.

## CHK-002

Goal: fix only the DONE projection semantics.

Chosen behavior:
- If story phase is `DONE`, compare `test-evidence.materialHash` against `currentMaterialHash(root, evidence.headHash)`.
- If the recorded evidence head cannot be inspected, fail closed.
- If story phase is not `DONE`, keep the existing strict current-HEAD freshness check.

Non-goals:
- Do not weaken active TEST/DONE-entry gates.
- Do not alter Authority receipt or productionDone semantics.

## CHK-003

Goal: prove the fix and guard against regression.

Commands:
- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/done-preflight-smoke.js`
- `lattice validate --story=B-249c --json`

Acceptance:
- Post-DONE main movement no longer creates a false freshness failure for completed stories.
- Active TEST stories still fail freshness after material changes.
- Smoke output remains local/non-authority only.
