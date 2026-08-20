# B-c7e2 User-Value Transcript Diff

Story: B-c7e2 - Autopilot v2 M1 checkpoint-ledger-backed resume
Recorded: 2026-06-28

## Expected

- Healthy, non-stale autopilot runs can produce a `resume_ready` projection from the checkpoint ledger.
- Resume does not re-dispatch already committed done checkpoints.
- Stale, corrupt, unsafe, missing-freshness, autopilot-policy-drift, and linked dispatch-policy-drift cases refuse as stale or unsafe instead of claiming safe resume.
- Resume remains diagnostic/local: `authorityChanged=false`, `receiptVerified=false`, and `productionDone=false`.

## Actual Transcript

```text
$ npm --prefix packages/main run build
> @lattice/core@0.3.99 build
> tsc

$ npm --prefix packages/main run test:autopilot-resume-smoke
autopilot-resume smoke passed: fresh ledger projection, stale refusal, no re-dispatch, corrupt snapshot recovery, stale checkpoint fail-closed, early failed no-checkpoint refusal, policy drift fail-closed, dispatch policy drift fail-closed, missing freshness fail-closed, and authority boundaries verified

$ node packages/main/dist/tasks/autopilot-run-smoke.js
autopilot-run smoke passed: ... ledger-backed resume projection, cancelled resume refusal, and authority boundaries verified

$ lattice validate --story=B-c7e2
Project validation commands passed
Verification intent coverage: 9/9 covered (0 required missing)
```

Second-host validation:

```text
agy --print <B-c7e2 validation prompt> --print-timeout 180s
VERDICT: pass
```

Review result:

```text
concept: PASS
quality: PASS
test-coverage: PASS
open high/critical findings: 0
```

## Diff Notes

- Expected healthy resume behavior matched actual output: the smoke reports `fresh ledger projection` and `no re-dispatch`.
- Expected fail-closed behavior matched actual output: the smoke explicitly covers stale state, corrupt snapshot recovery, stale checkpoint, early failed no-checkpoint, autopilot policy drift, linked dispatch policy drift, and missing freshness.
- Expected authority boundary matched actual output: smoke and reviewer evidence confirm the resume path does not set Authority or production completion booleans.
- No user-facing discrepancy observed in the tested CLI behavior.

## Remaining Boundary

This story implements Autopilot v2 M1 resume projection only. It does not implement unattended re-dispatch, provider health ramping, multi-run queue governance, or production completion claims.
