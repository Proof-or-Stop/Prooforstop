# B-51f6 Staging Readiness Audit

Date: 2026-06-10
Authority URL: `https://stagging.hostneutral.net`
Target gate: `TEST`
Story branch HEAD during first smoke run: `67633ebb01ef4d419295f3a6f63f7d44f70681be`
Lattice CLI version: `0.3.5`

## Final Classification

`BLOCKED`

This is not a production Authority TEST receipt smoke PASS. The staging server is
reachable, and local fail-closed receipt/gate regression tests pass, but staging
does not meet the story's production receipt criteria:

- server key id is `dev-server-key`;
- server key profile is `local-test`;
- server key is `ephemeral=true`;
- server key is `isDefaultTestKey=true`;
- server key is `productionInert=true`;
- `productionEnforceAuthority=false`;
- OpenAPI does not expose `/v1/receipts/{receipt_id}/proof`;
- probing `/v1/receipts/readiness-probe/proof` returns `404`;
- local environment has no configured customer API key, actor key, runner id,
  session id, project id, or trusted server public-key pin source.

Host verdicts are local execution evidence only. They do not substitute for a
production `gate_decision` receipt proof and cannot derive `productionDone` or
`strongEvidenceConsumed`.

## Exact Codex Commands And Outputs

### Health

Command:

```bash
curl -fsSL https://stagging.hostneutral.net/health | jq -c .
```

Observed output:

```json
{"status":"ok","service":"lattice-authority"}
```

### OpenAPI Path Probe

Command:

```bash
curl -fsSL https://stagging.hostneutral.net/openapi.json | jq -r '.paths | keys[]'
```

Relevant observed paths:

```text
/health
/v1/authority/policy
/v1/gates/evaluate
/v1/receipts/{receipt_id}
```

Relevant absent path:

```text
/v1/receipts/{receipt_id}/proof
```

Structured OpenAPI command:

```bash
curl -fsSL https://stagging.hostneutral.net/openapi.json \
  | jq '{apiTitle:.info.title, apiVersion:.info.version, hasReceiptProofEndpoint:(.paths | has("/v1/receipts/{receipt_id}/proof")), hasReceiptFetchEndpoint:(.paths | has("/v1/receipts/{receipt_id}")), hasGateEvaluateEndpoint:(.paths | has("/v1/gates/evaluate"))}'
```

Observed output:

```json
{
  "apiTitle": "Lattice Authority API",
  "apiVersion": "0.1.0",
  "hasReceiptProofEndpoint": false,
  "hasReceiptFetchEndpoint": true,
  "hasGateEvaluateEndpoint": true
}
```

### Policy Probe

Command:

```bash
curl -fsSL https://stagging.hostneutral.net/v1/authority/policy \
  | jq '{productionEnforceAuthority, requiredAuthorityMode, serverKey:{keyId:.serverKey.keyId, profile:.serverKey.profile, ephemeral:.serverKey.ephemeral, isDefaultTestKey:.serverKey.isDefaultTestKey, productionInert:.serverKey.productionInert, algorithm:.serverKey.algorithm}, commandCatalogDigest, evidenceSchemaDigest}'
```

Observed output:

```json
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

Public key digest command:

```bash
curl -fsSL https://stagging.hostneutral.net/v1/authority/policy \
  | jq -r '.serverKey.publicKeyHex' \
  | node -e "const fs=require('fs'),crypto=require('crypto'); const hex=fs.readFileSync(0,'utf8').trim(); const digest=crypto.createHash('sha256').update(Buffer.from(hex,'hex')).digest('hex'); console.log('sha256:'+digest);"
```

Observed output:

```text
sha256:d07cae2ab856cb6aa173d3fdf23c44600f5e0e789b83853eaa47220ad3493d6b
```

### Proof Endpoint Probe

Command:

```bash
curl -sS -o /tmp/lattice-proof-probe.json -w 'http_status=%{http_code}\n' \
  https://stagging.hostneutral.net/v1/receipts/readiness-probe/proof
```

Observed output:

```text
http_status=404
```

Response body:

```json
{
  "detail": "Not Found"
}
```

### Local Secret/Identity Source Presence Check

Command:

```bash
node - <<'NODE'
const names = [
  'LATTICE_AUTHORITY_CUSTOMER_API_KEY',
  'LATTICE_AUTHORITY_CUSTOMER_API_KEY_PATH',
  'LATTICE_AUTHORITY_ACTOR_KEY',
  'LATTICE_AUTHORITY_ACTOR_KEY_PATH',
  'LATTICE_AUTHORITY_RUNNER_ID',
  'LATTICE_AUTHORITY_SESSION_ID',
  'LATTICE_AUTHORITY_PROJECT_ID',
  'LATTICE_AUTHORITY_SERVER_PUBLIC_KEY',
  'LATTICE_AUTHORITY_LIVE_PUBLIC_KEY',
  'LATTICE_AUTHORITY_BOOTSTRAP_TOKEN'
];
const out = Object.fromEntries(names.map((name) => [
  name,
  Boolean(process.env[name] && process.env[name].trim())
]));
console.log(JSON.stringify(out, null, 2));
NODE
```

Observed output:

```json
{
  "LATTICE_AUTHORITY_CUSTOMER_API_KEY": false,
  "LATTICE_AUTHORITY_CUSTOMER_API_KEY_PATH": false,
  "LATTICE_AUTHORITY_ACTOR_KEY": false,
  "LATTICE_AUTHORITY_ACTOR_KEY_PATH": false,
  "LATTICE_AUTHORITY_RUNNER_ID": false,
  "LATTICE_AUTHORITY_SESSION_ID": false,
  "LATTICE_AUTHORITY_PROJECT_ID": false,
  "LATTICE_AUTHORITY_SERVER_PUBLIC_KEY": false,
  "LATTICE_AUTHORITY_LIVE_PUBLIC_KEY": false,
  "LATTICE_AUTHORITY_BOOTSTRAP_TOKEN": false
}
```

No secret values were printed.

### Lattice Authority Status

Command:

```bash
lattice authority_status --json --authorityMode=enforce --authorityURL=https://stagging.hostneutral.net
```

Relevant observed output:

```json
{
  "schemaVersion": "lattice.authority_status.v1",
  "product": {
    "name": "Lattice CLI",
    "version": "0.3.5"
  },
  "authorityMode": "enforce",
  "baseURLConfigured": true,
  "baseURL": "https://stagging.hostneutral.net",
  "receiptVerified": false,
  "productionDone": false,
  "canClaimProductionDone": false,
  "customerApiKeyConfigured": false,
  "actorKeyConfigured": false,
  "serverPublicKeyPinned": false,
  "runnerConfigured": false,
  "sessionConfigured": false,
  "productionAuthorityUsable": false
}
```

### Receipt Ref Absence Check

Command:

```bash
find . -name authority-receipt-refs.json -print
```

Observed output:

```text

```

No `authority-receipt-refs.json` file exists in the story worktree. The blocked
readiness path did not write a fake `production-gate-decision` receipt ref.

### Local Fail-Closed Regression Smokes

Commands:

```bash
npm run build
npm run test:authority-receipt-proof
npm run test:authority-gate-receipts
npm run test:authority-gate-consumption
```

Observed outputs:

```text
> koala@0.3.5 build
> cd packages/main && npm run build

> @koala-agent/core@0.3.5 build
> tsc

authority receipt proof smoke passed
authority gate receipts smoke passed
authority gate consumption smoke passed
```

These local tests support fail-closed behavior only. They are not staging
production receipt evidence.

## Exact Claude Prompts And Corrected Output

## Same-Anchor Payload

Codex and Claude judgments are tied to this same anchor payload. Fields that
would exist only after a production receipt path are explicitly marked
`unavailable_readiness_blocked`.

```json
{
  "storyId": "B-51f6",
  "targetPhase": "TEST",
  "authorityUrl": "https://stagging.hostneutral.net",
  "authorityHealth": {
    "status": "ok",
    "service": "lattice-authority"
  },
  "authorityApi": {
    "apiTitle": "Lattice Authority API",
    "apiVersion": "0.1.0",
    "hasReceiptFetchEndpoint": true,
    "hasReceiptProofEndpoint": false,
    "hasGateEvaluateEndpoint": true,
    "proofProbePath": "/v1/receipts/readiness-probe/proof",
    "proofProbeStatus": 404
  },
  "authorityPolicy": {
    "productionEnforceAuthority": false,
    "requiredAuthorityMode": "enforce",
    "serverKeyId": "dev-server-key",
    "serverKeyProfile": "local-test",
    "serverKeyEphemeral": true,
    "serverKeyIsDefaultTestKey": true,
    "serverKeyProductionInert": true,
    "serverKeyAlgorithm": "ed25519",
    "serverPublicKeyDigest": "sha256:d07cae2ab856cb6aa173d3fdf23c44600f5e0e789b83853eaa47220ad3493d6b",
    "commandCatalogDigest": "e3a6f3f3d2c6493d2d6d993b5931b7864f7887d901b58a4e8e82b1ef2f17e258",
    "evidenceSchemaDigest": "09f4f255c5a7b0a95b423f802068f7d6100f659abf88201fed034432f353593f"
  },
  "localContext": {
    "latticeCliVersion": "0.3.5",
    "headHash": "4c2ba5c8c51a3f5aee16003efc2608d7297a4f16",
    "materialHash": "a9421651d41f770be0e89a2a646d289c132b69bbbd096e536427a8a6ead900a3",
    "customerApiKeyConfigured": false,
    "actorKeyConfigured": false,
    "runnerConfigured": false,
    "sessionConfigured": false,
    "projectIdConfigured": false,
    "serverPublicKeyPinned": false
  },
  "receiptPath": {
    "receiptRefPath": "authority-receipt-refs.json",
    "receiptRefStatus": "unavailable_readiness_blocked",
    "consumedReceiptId": null,
    "consumedReceiptStatus": "unavailable_readiness_blocked",
    "receiptVerified": false,
    "productionDone": false,
    "productionAuthorityUsable": false,
    "strongEvidenceConsumed": false
  },
  "jobRunEvidenceAnchors": {
    "jobId": null,
    "jobIdStatus": "unavailable_readiness_blocked",
    "runId": null,
    "runIdStatus": "unavailable_readiness_blocked",
    "signedEvidenceDigest": null,
    "signedEvidenceDigestStatus": "unavailable_readiness_blocked",
    "gateInputDigest": null,
    "gateInputDigestStatus": "unavailable_readiness_blocked",
    "decisionDigest": null,
    "decisionDigestStatus": "unavailable_readiness_blocked"
  },
  "finalClassification": {
    "classification": "BLOCKED",
    "reason": "staging readiness does not satisfy production gate_decision receipt proof criteria"
  }
}
```

### Claude Prompt 1

```text
You are an independent host reviewer for Lattice story B-51f6. Review the same authority anchors and decide whether the formal staging Authority TEST receipt smoke can be classified PASS or BLOCKED. Anchors: authorityUrl=https://stagging.hostneutral.net; health={status:ok, service:lattice-authority}; OpenAPI info version=0.1.0; has /v1/receipts/{receipt_id}=true; has /v1/receipts/{receipt_id}/proof=false; proof probe GET /v1/receipts/readiness-probe/proof returned 404 Not Found; policy serverKey.keyId=dev-server-key; serverKey.profile=local-test; ephemeral=true; isDefaultTestKey=true; productionInert=true; serverPublicKeyDigest=sha256:d07cae2ab856cb6aa173d3fdf23c44600f5e0e789b83853eaa47220ad3493d6b; productionEnforceAuthority=false; commandCatalogDigest=e3a6f3f3d2c6493d2d6d993b5931b7864f7887d901b58a4e8e82b1ef2f17e258; evidenceSchemaDigest=09f4f255c5a7b0a95b423f802068f7d6100f659abf88201fed034432f353593f; Lattice CLI version=0.3.5; story branch HEAD=67633ebb01ef4d419295f3a6f63f7d44f70681be; authority_status reports receiptVerified=false, productionDone=false, productionAuthorityUsable=false, customerApiKeyConfigured=false, actorKeyConfigured=false, runnerConfigured=false. Local regression smokes passed: authority receipt proof, authority gate receipts, authority gate consumption. Scope: TEST gate only, no DONE, no server deployment, no credential provisioning. Please output: Verdict PASS/BLOCKED, blocker list, and whether any host verdict can substitute for a production gate_decision receipt.
```

Claude initially returned `PASS` using a weaker staging-health meaning, while
also stating that a host verdict cannot substitute for a production
`gate_decision` receipt.

### Claude Prompt 2

```text
Re-evaluate your previous verdict for Lattice story B-51f6 under the story's explicit pass criteria. Criteria: PASS only if a production-capable gate_decision receipt proof is verified, written as a structured receipt ref, and consumed by the TEST gate. BLOCKED if staging uses default/dev/local-test/ephemeral/productionInert key, lacks /v1/receipts/{receipt_id}/proof, lacks required identity/pin sources, or only has transport/readiness/local regression evidence. Anchors: authorityUrl=https://stagging.hostneutral.net; OpenAPI hasReceiptProofEndpoint=false; proof probe 404; serverKey.keyId=dev-server-key; profile=local-test; ephemeral=true; isDefaultTestKey=true; productionInert=true; productionEnforceAuthority=false; authority_status receiptVerified=false, productionDone=false, productionAuthorityUsable=false, customerApiKeyConfigured=false, actorKeyConfigured=false, runnerConfigured=false; local regression smokes passed but they are not production Authority receipts. Scope remains TEST only, no DONE, no server deployment, no credential provisioning. Output exactly: Verdict PASS or BLOCKED, blockers, and a one-sentence correction if your prior PASS was using a weaker staging-health meaning.
```

Corrected Claude output:

```text
Verdict: BLOCKED

Blockers:
1. Default/dev key in use: serverKey.keyId=dev-server-key, isDefaultTestKey=true,
   productionInert=true — not a production-capable key
2. No receipt proof endpoint: OpenAPI hasReceiptProofEndpoint=false,
   /v1/receipts/{receipt_id}/proof returns 404
3. Ephemeral local-test profile: profile=local-test, ephemeral=true — no durable
   authority binding
4. No production authority: productionEnforceAuthority=false,
   receiptVerified=false, productionDone=false, productionAuthorityUsable=false
5. No identity/pin sources configured: customerApiKeyConfigured=false,
   actorKeyConfigured=false, runnerConfigured=false
6. Authority URL is staging: https://stagging.hostneutral.net is not a
   production authority endpoint

Correction: If a prior PASS was issued, it was using a weaker
"staging-health/transport-readiness" meaning — confirming the server responds
and local regression smokes run green — which does not satisfy the story's
explicit pass criteria requiring a production-capable gate_decision receipt proof
verified through a structured receipt ref and consumed by the TEST gate.
```

## Original Dirty Baseline Before Story Worktree

The worktree was intentionally created to avoid mixing unrelated main work into
B-51f6. Before story worktree creation, the main checkout had these pre-existing
dirty files:

```text
M docs/requirements/decisions/story-lifecycle.md
M packages/main/src/cli-engine.ts
M packages/main/src/core/command-policy.ts
M packages/main/src/core/config.ts
M packages/main/src/core/managed-assets.ts
M packages/main/src/core/process-fact-levels.ts
M packages/main/src/handlers/phase-gates.ts
M scripts/verify-process-fact-contract.mjs
```

After merging current `main` into `story/B-51f6`, this branch's diff against
`main` contains only B-51f6 story metadata:

```bash
git merge-base --is-ancestor main HEAD
git diff --name-only main..HEAD
```

Observed post-merge result:

```text
merge_base_status=0
.koala/story/actives/B-51f6/checklist.json
.koala/story/actives/B-51f6/decision.json
.koala/story/actives/B-51f6/findings.json
.koala/story/actives/B-51f6/index.json
.koala/story/actives/B-51f6/plan.md
.koala/story/actives/B-51f6/process-events.jsonl
.koala/story/actives/B-51f6/process-metrics.json
.koala/story/actives/B-51f6/review-passes.json
.koala/story/actives/B-51f6/review-runs.json
.koala/story/actives/B-51f6/review.json
.koala/story/actives/B-51f6/scope-check.json
.koala/story/actives/B-51f6/understanding.json
```

At the time of this evidence update, the main checkout also had an unrelated new
untracked file:

```text
?? unlock-layer2-ENG-suite.md
```

That file is outside this story and was not copied into the B-51f6 worktree.
