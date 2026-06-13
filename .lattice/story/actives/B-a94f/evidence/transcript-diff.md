# B-a94f User-Visible Transcript Diff

## Expected

- `authority_trust.env` exists at the Lattice CLI root and remains untracked/ignored.
- `authority_status --authorityMode=enforce --json` can use the root trust file for Authority readiness inputs.
- The trust file only improves local readiness diagnostics; it does not claim Authority receipt verification or production DONE.
- In `mode=off`, status surfaces do not read `authority_trust.env` or any referenced customer-key file.

## Actual Transcript

Command:

```bash
node packages/main/dist/cli.js authority_status --authorityMode=enforce --json | node -e '<non-sensitive projection>'
```

Observed non-sensitive projection:

```json
{
  "authorityMode": "enforce",
  "authorityTrustEnvLoaded": true,
  "urlSource": "authority_trust_env",
  "baseURLConfigured": true,
  "customerApiKeyConfigured": true,
  "customerApiKeySource": "authority_trust_env",
  "serverPublicKeyPinned": true,
  "actorKeyConfigured": false,
  "runnerConfigured": false,
  "receiptVerified": false,
  "productionDone": false,
  "canClaimProductionDone": false,
  "status": "configured-no-verified-receipt",
  "readinessWarningCount": 2
}
```

Command:

```bash
node --input-type=module '<authority_status + conduit_status off-mode read probe>'
```

Observed non-sensitive projection:

```json
{
  "authority_status": {
    "reads": [],
    "mode": "off",
    "productionDone": false,
    "receiptVerified": false,
    "customerApiKeyConfigured": false,
    "customerApiKeySource": "missing"
  },
  "conduit_status": {
    "reads": [],
    "mode": "off",
    "productionDone": false,
    "receiptVerified": false,
    "customerApiKeyConfigured": null,
    "customerApiKeySource": null
  }
}
```

Command:

```bash
git status --short --ignored -- authority_trust.env
```

Observed:

```text
!! authority_trust.env
```

## Outcome Diff

Actual matches expected. The root trust file is loaded for enforce-mode readiness, remains ignored, and does not create any receipt-backed Authority claim. Both `authority_status` and `conduit_status` preserve off-mode zero trust-file/secret-file I/O.

## Authority Boundary

This transcript is local Non-authority CLI evidence only. It does not verify an Authority Server receipt, does not submit evidence, and does not claim production DONE.
