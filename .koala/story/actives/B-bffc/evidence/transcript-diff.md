# B-bffc User-Value Transcript Diff

Timestamp: 2026-06-02T12:20Z
Story: B-bffc - Productize Lattice CLI 0.3.5 and migrate Mac App capabilities into CLI-first surfaces

## Expected Outcome

From `plan.md`, the user-facing release path should satisfy these outcomes:

- Lattice CLI 0.3.5 is the primary product surface.
- `koala` remains a compatibility alias, not the main product identity.
- Third-party hosts such as Codex, Claude Code, and Gemini remain coding runners.
- Mac App / `desktop-app` is optional dashboard/archive only, not an edit/test/evidence/receipt authority.
- Lattice Conduit is a thin diagnostics/handoff surface, not a model runner.
- Local CLI output cannot claim production DONE or verified authority receipts without Server Authority receipt verification.
- Missing optional providers and missing authority URL degrade visibly and non-fatally.

## Actual Transcript

Command:

```bash
node packages/main/dist/cli.js --version
```

Observed:

```text
Lattice CLI 0.3.5 (lattice; legacy alias: koala)
```

Command:

```bash
node packages/main/dist/cli.js help
```

Observed excerpts:

```text
Lattice CLI 0.3.5 - CLI-first project workflow and host migration surface
Primary entrypoint: lattice
Legacy alias:       koala
Current Story: B-bffc  Phase: TEST
host_list ... Alias: lattice host list
lattice_config_doctor ... Mac App demotion status
authority_status ... without submitting evidence or verifying receipts
conduit_status ... without provisioning a runner or production authority
```

Command:

```bash
node packages/main/dist/cli.js host_list --format=json
```

Observed excerpts:

```json
{
  "schemaVersion": "lattice.host_list.v1",
  "product": { "name": "Lattice CLI", "version": "0.3.5" },
  "migration": {
    "cliFirst": true,
    "macAppRequired": false,
    "macAppRole": "optional-dashboard-archive"
  },
  "authority": {
    "productionDoneRequiresReceipt": true,
    "handoffCanManufactureProductionDone": false,
    "productionDone": false,
    "receiptVerified": false
  }
}
```

Command:

```bash
node packages/main/dist/cli.js host_probe --host=desktop-app --format=json
```

Observed excerpts:

```json
{
  "schemaVersion": "lattice.host_probe.v1",
  "productionDone": false,
  "receiptVerified": false,
  "probe": {
    "host": "desktop-app",
    "profile": {
      "label": "Desktop app (dashboard/archive)",
      "summary": "Optional dashboard/archive surface for displaying artifacts, collecting visible approval, and browsing historical handoff context; Lattice CLI commands remain the editing, test, authority, and receipt surfaces."
    }
  }
}
```

The `desktop-app` profile reports these operational capabilities as unavailable:

```text
file-edit
patch-apply
shell/pty
test-execution
browser-automation
evidence-submit
receipt-verify
multimodal-research
```

The `desktop-app-receipt-verify` degradation is visible and has `authorityImpact: "blocks-production-done"`.

Command:

```bash
node packages/main/dist/cli.js host_probe --host=codex --format=json
```

Observed excerpts:

```json
{
  "schemaVersion": "lattice.host_probe.v1",
  "productionDone": false,
  "receiptVerified": false,
  "probe": {
    "host": "codex",
    "degradations": [
      { "id": "codex-browser-automation", "visible": true, "authorityImpact": "verification-evidence-limited" },
      { "id": "codex-evidence-submit", "visible": true, "authorityImpact": "evidence-local-only" },
      { "id": "codex-receipt-verify", "visible": true, "authorityImpact": "blocks-production-done" }
    ]
  }
}
```

Command:

```bash
node packages/main/dist/cli.js lattice_config_doctor --format=json
```

Observed excerpts:

```json
{
  "schemaVersion": "lattice.config_doctor.v1",
  "ok": true,
  "status": "pass",
  "migration": {
    "cliFirst": true,
    "macAppRequired": false,
    "macAppRole": "optional-dashboard-archive",
    "legacyKoalaAliasPreserved": true
  },
  "versions": { "root": "0.3.5", "main": "0.3.5", "expected": "0.3.5" },
  "authority": {
    "productionDone": false,
    "receiptVerified": false
  }
}
```

Command:

```bash
node packages/main/dist/cli.js authority_status --format=json
```

Observed:

```json
{
  "schemaVersion": "lattice.authority_status.v1",
  "authorityMode": "off",
  "baseURLConfigured": false,
  "baseURL": null,
  "serverReachability": "not-probed",
  "receiptVerified": false,
  "productionDone": false,
  "canClaimProductionDone": false,
  "status": "not-configured",
  "note": "Receipt-aware status only: no receipt is verified, no evidence is submitted, and productionDone remains false."
}
```

Command:

```bash
node packages/main/dist/cli.js conduit_explain --format=json
node packages/main/dist/cli.js conduit_status --format=json
```

Observed excerpts:

```json
{
  "conduitAvailable": true,
  "conduitRole": "cli-diagnostics-and-handoff",
  "runnerProvisioned": false,
  "modelRunnerCreated": false,
  "productionDone": false,
  "receiptVerified": false,
  "authorityChanged": false,
  "warnings": [
    "The CLI conduit coordinates diagnostics and handoff projections only.",
    "It does not provision a new model runner, sign envelopes, verify receipts, or grant production authority."
  ]
}
```

Command:

```bash
node packages/main/dist/cli.js host_install --host=desktop-app --format=json
```

Observed excerpts:

```json
{
  "schemaVersion": "lattice.host_install.v1",
  "host": "desktop-app",
  "dryRun": true,
  "executed": false,
  "thirdPartyInstallsExecuted": false,
  "productionDone": false,
  "receiptVerified": false,
  "summary": "The Mac App is optional dashboard/archive surface only for this migration."
}
```

## Diff

| Expected | Actual | Result |
| --- | --- | --- |
| Lattice CLI 0.3.5 is primary. | Version/help identify `Lattice CLI 0.3.5` and `Primary entrypoint: lattice`. | Match |
| `koala` remains legacy compatibility. | Version/help state `legacy alias: koala`. | Match |
| Mac App is optional/dashboard/archive only. | `host_list` reports `macAppRequired=false`; `host_probe desktop-app` labels it `Desktop app (dashboard/archive)`. | Match |
| Mac App is not edit/test/evidence/receipt authority. | `desktop-app` edit, shell, test, evidence-submit, and receipt-verify capabilities are unavailable. | Match |
| Third-party hosts remain coding runners with visible limits. | `host_probe codex` shows editing/test capability plus visible browser/evidence/receipt degradations. | Match |
| Missing authority URL is non-fatal and does not overclaim. | `authority_status` returns `status=not-configured`, `baseURLConfigured=false`, `serverReachability=not-probed`, `productionDone=false`. | Match |
| Conduit is not a model runner or authority. | `conduit_*` returns `runnerProvisioned=false`, `modelRunnerCreated=false`, `authorityChanged=false`. | Match |
| Install guidance is dry-run only. | `host_install desktop-app` returns `dryRun=true`, `executed=false`, `thirdPartyInstallsExecuted=false`. | Match |

## Conclusion

The actual CLI behavior matches the story plan. A user can understand and use the Lattice CLI 0.3.5 path without opening or relying on the Mac App, while local CLI surfaces remain conservative about production authority and receipt verification.
