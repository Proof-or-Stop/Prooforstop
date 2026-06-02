# B-b710 user acceptance transcript diff

## Expected outcome

Users can inspect authority readiness without enabling paid/server-backed authority:

- default/off mode remains locally usable and does not claim production DONE
- enforce mode with missing prerequisites reports actionable readiness warnings instead of blocking ordinary local story workflows
- status smoke proves the same no-overclaim behavior mechanically

## Actual transcript

Command:

```bash
node packages/main/dist/cli.js --root . authority_status --json
```

Observed key fields:

```json
{
  "authorityMode": "off",
  "mode": "off",
  "receiptVerified": false,
  "productionDone": false,
  "canClaimProductionDone": false,
  "localWorkflowUsable": true,
  "readinessWarnings": [],
  "nextActions": []
}
```

Command:

```bash
KOALA_AUTHORITY_MODE=enforce node packages/main/dist/cli.js --root . authority_status --json
```

Observed key fields:

```json
{
  "authorityMode": "enforce",
  "mode": "enforce",
  "receiptVerified": false,
  "productionDone": false,
  "canClaimProductionDone": false,
  "localWorkflowUsable": true,
  "readinessWarnings": [
    "enforce mode set but KOALA_AUTHORITY_URL is empty; runner / policy discovery cannot reach the Python authority",
    "enforce mode set but no KOALA_AUTHORITY_ACTOR_KEY / KOALA_AUTHORITY_ACTOR_KEY_PATH detected; future runner submissions would be unsigned and rejected",
    "enforce mode set but KOALA_AUTHORITY_RUNNER_ID is empty; runner identity binding would be missing"
  ]
}
```

Command:

```bash
npm run test:authority-status-smoke
```

Observed:

```text
✓ authority status readiness smoke passed
```

## Outcome diff

No user-visible mismatch. Off mode remains usable with no authority warnings; enforce mode reports missing server, actor key, and runner ID prerequisites while keeping local workflow usable and all production authority claims false.

## Notes

This story intentionally exposes readiness diagnostics only. It does not submit evidence, verify authority receipts, or convert local JSON/status output into production authority proof.
