# B-5cdc Transcript Diff

Story: B-5cdc
Phase: TEST
Recorded at: 2026-06-02T21:34:09Z

## Expected

CHK-001 expected the operator to run:

```bash
lattice authority enforce runner --once --dry-run --json
```

The output should show:

- `schemaVersion: lattice.authority_enforce_runner.v1`
- `mode: enforce`
- `once: true`
- `dryRun: true`
- `plannedSteps: ["register_runner", "runner_heartbeat", "claim_job"]`
- `spawned: false`
- `providerEvents: []`
- `localWorkflowUsable: true`
- no network mutation and no provider execution

CHK-002 expected the smoke tests to show a signed fake-provider event flow:

- successful fake job emits `stdout_delta` and `completed`
- failed fake job emits `stderr_delta` and `failed`
- transcript hash is present and signed envelope verification succeeds
- runnerId, runId, and provider mismatches are rejected

## Actual

Command:

```bash
env KOALA_AUTHORITY_MODE=enforce KOALA_AUTHORITY_URL=https://authority.test KOALA_AUTHORITY_ACTOR_KEY=test-actor KOALA_AUTHORITY_RUNNER_ID=runner-1 node packages/main/dist/cli.js --root . lattice authority enforce runner --once --dry-run --json
```

Observed JSON:

```json
{
  "schemaVersion": "lattice.authority_enforce_runner.v1",
  "mode": "enforce",
  "once": true,
  "dryRun": true,
  "plannedSteps": [
    "register_runner",
    "runner_heartbeat",
    "claim_job"
  ],
  "spawned": false,
  "providerEvents": [],
  "localWorkflowUsable": true,
  "status": "pass",
  "readinessWarnings": [],
  "nextActions": [],
  "note": "Dry-run only: planned runner register/heartbeat/claim steps; no network mutation and no provider execution."
}
```

Smoke commands:

```bash
npm run test:authority-enforce-runner
npm run test:authority-runner-events
lattice validate --story=B-5cdc --json
```

Observed result:

```text
authority enforce runner smoke passed: dry-run planned register/heartbeat/claim without provider execution
authority runner events smoke passed: stdout/completed/failed events are signed and transcript-bound
validate status: pass
verification intent coverage: 6/6 covered, 0 required missing
```

## Diff

Expected and actual match.

No unexpected provider execution occurred: `spawned` stayed `false` and `providerEvents` stayed empty for the dry-run CLI.

The only intentional boundary is that real Python authority job claiming and real provider CLI execution remain later milestones; B-5cdc implements the explicit dry-run runner surface and controlled fake-provider event helper only.
