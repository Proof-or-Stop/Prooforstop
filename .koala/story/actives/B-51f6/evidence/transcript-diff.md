# B-51f6 User-Value Transcript Diff

## User Request

Run the formal staging Authority receipt gate smoke against:

- `https://stagging.hostneutral.net/docs`

Use real verification and preserve the Lattice host-neutral rule: host-local judgments from Codex or Claude may review evidence, but cannot substitute for an Authority production `gate_decision` receipt/ref consumed by the gate.

## Expected Outcome From Plan

The plan allowed exactly two user-visible outcomes:

- `PASS`: staging is production-capable, a TEST `gate_decision` receipt proof is verified, a structured `authority-receipt-refs.json` is written, and the TEST gate consumes that receipt with `strongEvidenceConsumed=true`.
- `BLOCKED`: staging does not satisfy the production smoke contract, and the exact readiness blockers are recorded. If blocked, no fake receipt ref is written and the positive production smoke is skipped.

## Actual Transcript

Primary staging probes:

```text
curl -fsSL https://stagging.hostneutral.net/health | jq -c .
{"status":"ok","service":"lattice-authority"}

curl -fsSL https://stagging.hostneutral.net/openapi.json | jq '{apiTitle:.info.title, apiVersion:.info.version, hasReceiptProofEndpoint:(.paths | has("/v1/receipts/{receipt_id}/proof")), hasReceiptFetchEndpoint:(.paths | has("/v1/receipts/{receipt_id}")), hasGateEvaluateEndpoint:(.paths | has("/v1/gates/evaluate"))}'
{
  "apiTitle": "Lattice Authority API",
  "apiVersion": "0.1.0",
  "hasReceiptProofEndpoint": false,
  "hasReceiptFetchEndpoint": true,
  "hasGateEvaluateEndpoint": true
}

curl -sS -o /tmp/lattice-proof-probe.json -w 'http_status=%{http_code}\n' https://stagging.hostneutral.net/v1/receipts/readiness-probe/proof
http_status=404
```

Policy/readiness transcript:

```text
curl -fsSL https://stagging.hostneutral.net/v1/authority/policy | jq '{productionEnforceAuthority, requiredAuthorityMode, serverKey:{keyId:.serverKey.keyId, profile:.serverKey.profile, ephemeral:.serverKey.ephemeral, isDefaultTestKey:.serverKey.isDefaultTestKey, productionInert:.serverKey.productionInert, algorithm:.serverKey.algorithm}, commandCatalogDigest, evidenceSchemaDigest}'
{
  "productionEnforceAuthority": false,
  "requiredAuthorityMode": "enforce",
  "serverKey": {
    "keyId": "dev-server-key",
    "profile": "local-test",
    "ephemeral": true,
    "isDefaultTestKey": true,
    "productionInert": true,
    "algorithm": "ed25519"
  },
  "commandCatalogDigest": "e3a6f3f3d2c6493d2d6d993b5931b7864f7887d901b58a4e8e82b1ef2f17e258",
  "evidenceSchemaDigest": "09f4f255c5a7b0a95b423f802068f7d6100f659abf88201fed034432f353593f"
}
```

CLI authority status:

```text
lattice authority_status --json --authorityMode=enforce --authorityURL=https://stagging.hostneutral.net
```

Observed key fields:

- `receiptVerified=false`
- `productionDone=false`
- `productionAuthorityUsable=false`
- customer API key was not configured
- actor key was not configured
- runner id/session/project/pin source were not configured

Receipt-ref check:

```text
find . -name authority-receipt-refs.json -print
```

Observed output: no files were returned.

Formal validation after TEST:

```text
lattice validate --story=B-51f6 --json
```

Observed result:

- `status=pass`
- `allPass=true`
- verification intent coverage `9/9`
- local fallback command `npm test` passed
- all B-51f6 checklist evidence is covered

Local fail-closed regressions also passed:

```text
npm run test:authority-receipt-proof
npm run test:authority-gate-receipts
npm run test:authority-gate-consumption
```

## Outcome Diff

The real-machine result is `BLOCKED`, not production `PASS`.

Difference from the production-pass path:

- Staging is reachable and `/health` is healthy.
- The OpenAPI document does not expose `/v1/receipts/{receipt_id}/proof`.
- The proof probe returns `404`.
- The server key is `dev-server-key` with `profile=local-test`, `ephemeral=true`, `isDefaultTestKey=true`, and `productionInert=true`.
- `productionEnforceAuthority=false`.
- Required local identity/secret/pin sources are absent, without printing secret values.
- No `authority-receipt-refs.json` was written.
- No production TEST `gate_decision` receipt was consumed.

This matches the plan's blocked branch exactly. The blocked result is therefore the correct user-facing outcome for this environment state.

## Host-Neutral Boundary

Codex and Claude were used as independent reviewers over the same serialized anchor payload. Their judgments are review evidence only. They did not and cannot replace a production Authority receipt proof, a structured receipt ref, or gate consumption evidence.

## Final Classification

`BLOCKED`: staging is not currently production-ready for the formal Lattice Authority TEST receipt smoke.
