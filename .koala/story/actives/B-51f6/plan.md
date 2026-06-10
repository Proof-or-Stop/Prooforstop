# B-51f6 Plan: Formal Staging Authority TEST Receipt Smoke

## Objective

Run a formal staging Authority receipt smoke against https://stagging.hostneutral.net for the Lattice TEST gate. The result must be one of two user-visible outcomes:

- PASS: a production-capable gate_decision receipt proof is verified, written as a structured receipt ref, and consumed by the TEST gate.
- BLOCKED: staging readiness does not satisfy the production smoke contract, with exact blockers recorded.

This story intentionally does not attempt DONE semantics.

## CHK-001 Probe staging Authority readiness and structured live-smoke contract

1. Fetch /health, /openapi.json, and /v1/authority/policy from https://stagging.hostneutral.net.
2. Extract and record non-secret anchors: authority URL, health status, OpenAPI path list, serverKeyId, key profile, productionInert, ephemeral, public key digest, command/evidence schema digests, and whether /v1/receipts/{receipt_id}/proof is present.
3. Check local secret/identity source presence without printing values: customer API key, actor key, runner id, session id, project id, and trusted key pin source.
4. Classify readiness:
   - PASS only if the server uses a non-default configured non-ephemeral non-productionInert key, the proof endpoint exists, a trusted pin source exists, and required identity sources are present.
   - BLOCKED otherwise, naming each exact blocker.
5. If BLOCKED, stop before positive production smoke and record verificationEvidence for readiness classification.

## CHK-002 Run TEST gate receipt proof and consumption smoke only after readiness passes

1. Run this item only if CHK-001 readiness is PASS.
2. Create or identify a production gate_decision receipt for targetPhase=TEST with current storyId, headHash, and materialHash.
3. Fetch the proof bundle and verify receipt signature, inputDigest, decisionDigest, storyId, targetPhase, headHash, materialHash, stateVersion, and trusted key digest.
4. Write authority-receipt-refs.json only when classification is production-gate-decision.
5. Run the TEST gate consumption path and require output naming the consumed receipt id and strongEvidenceConsumed=true.
6. If CHK-001 is BLOCKED, record CHK-002 as skipped due to readiness_blocked; do not create a fake receipt ref.

## CHK-003 Run explicit negative-control matrix and same-anchor dual-host review

1. If CHK-001 and CHK-002 pass, run fail-closed negative controls for missing ref, corrupt signature, story mismatch, target phase mismatch, head/material drift, production-inert key, non-gate receipt, transport accepted=true, and duplicate same-host/session attempts where independence is required.
2. If readiness is BLOCKED, record that production-receipt-dependent negative controls were not run because no valid production receipt exists.
3. Ask Claude CLI for an independent same-anchor review of the Codex transcript and classification.
4. Record Codex and Claude judgments over the same anchor set: authorityUrl, policy digest, serverKeyId/keyDigest, headHash, materialHash, receipt-ref path, consumed receipt id if any, targetPhase=TEST, job/run/evidence digests if any, and negative-control outputs.
5. State explicitly that host verdicts are local evidence and cannot replace Authority receipt evidence.

## Verification Commands

- curl -fsSL https://stagging.hostneutral.net/health
- curl -fsSL https://stagging.hostneutral.net/openapi.json
- curl -fsSL https://stagging.hostneutral.net/v1/authority/policy
- lattice authority_status --json --authorityMode=enforce --authorityURL=https://stagging.hostneutral.net
- npm run test:authority-receipt-proof
- npm run test:authority-gate-receipts
- npm run test:authority-gate-consumption

Run the production live positive path only after readiness passes.

## Rollback / Safety

No production state mutation is attempted before readiness PASS. If readiness is BLOCKED, this story writes only local Lattice evidence and review artifacts. Secrets must not be printed or committed.
