# B-92e2 user-value transcript diff

## Expected

- Local CLI exposes the Baseline 2-5 command surface:
  `baseline_run`, `baseline_suite`, `baseline_suite_report`, and
  `capability_claim_evaluate`.
- Engineering suite reports remain fail-closed without fresh lower-layer proof
  and without real non-local capability proof.
- Production-safety capability claims remain unauthorized in local diagnostic
  mode unless required lower-layer suite proof and external authority facts
  exist.

## Actual transcript

### CLI surface

Command:

```bash
node packages/main/dist/cli.js help | rg "baseline_run|baseline_suite|baseline_suite_report|capability_claim_evaluate"
```

Observed output:

```text
baseline_run                          Create a local Baseline 2-5 diagnostic run artifact without authority claims (text/json)
baseline_suite                        Alias for baseline_suite_report; aggregates local baseline final reports fail-closed (text/json)
baseline_suite_report                 Aggregate local baseline final reports and write a fail-closed suite report (text/json)
capability_claim_evaluate             Evaluate a local capability claim fail-closed from lower-layer suite reports (text/json)
```

Diff note: matches expected command surface.

### Engineering suite fail-closed behavior

Command:

```bash
node packages/main/dist/cli.js baseline_suite_report --layer=engineering --format=json
```

Observed key fields:

```json
{
  "schemaVersion": "lattice.baseline_suite_report.v1",
  "layer": "engineering",
  "suiteStatus": "BLOCKED",
  "authorization": "not_authorized",
  "outcome": "EXPECTED_BLOCK",
  "capabilityProof": false,
  "localOnly": true,
  "lowerLayerProof": [
    {
      "layer": "development",
      "status": "MISSING",
      "reason": "baseline-suite-report.json missing"
    }
  ],
  "authorityChanged": false,
  "receiptVerified": false,
  "productionDone": false,
  "fullAuthorityDone": false
}
```

Observed blocked reasons included stale engineering artifacts and missing
Development lower-layer proof.

Diff note: matches expected fail-closed behavior. The command did not synthesize
PASS from local or stale artifacts.

### Production-safety claim fail-closed behavior

Command:

```bash
node packages/main/dist/cli.js capability_claim_evaluate --target=production-safety --format=json
```

Observed key fields:

```json
{
  "schemaVersion": "lattice.capability_claim_report.v1",
  "claimId": "CLAIM-PRODUCTION-SAFETY",
  "target": "production-safety",
  "authorized": false,
  "outcome": "EXPECTED_BLOCK",
  "authorizedClaimLevel": "none",
  "highestEvidenceBackedClaim": "none",
  "blockedReasons": [
    "required lower-layer suite report development is MISSING: baseline-suite-report.json missing",
    "requested claim CLAIM-PRODUCTION-SAFETY is missing one or more required lower-layer suite reports"
  ],
  "hardFacts": {
    "falseDoneCount": 0,
    "safetySuccessRate": 0,
    "staleVerdicts": 0,
    "failingIndependentHosts": 0,
    "receiptVerified": false,
    "multiHostVerified": false,
    "soakSatisfied": false
  },
  "authorityChanged": false,
  "receiptVerified": false,
  "productionDone": false,
  "fullAuthorityDone": false
}
```

Diff note: matches expected fail-closed behavior. Local diagnostics did not
manufacture production authority or receipt-backed DONE evidence.

## Result

User-visible behavior matches the planned outcome for B-92e2: Baseline 2-5
local commands exist, but proof and claim unlock remain sequential and
fail-closed.
