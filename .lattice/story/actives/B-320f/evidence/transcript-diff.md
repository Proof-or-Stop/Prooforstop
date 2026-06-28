# B-320f Live Smoke Transcript Diff

Expected:

- User sees Autopilot v2 reliability behavior marked complete for M2 health-aware pause/resume, M3 adaptive throttle, and M4 process-pool claim/lease/fencing.
- User sees the acceptance table in `docs/requirements/decisions/autopilot-v2-reliability-execution-plan.md` show the implemented B-320f validation state.

Actual command:

```bash
node packages/main/dist/tasks/autopilot-v2-reliability-smoke.js
```

Actual output:

```text
autopilot-v2-reliability smoke PASS
```

Diff:

- No behavioral mismatch. The real-machine smoke passed and matches the intended user-visible acceptance signal.
- The broader validation set also passed through `done_prepare`: build, configured validation commands, DONE-required validation, fresh round-4 review passes, and local 3x2 host quorum over current material.
