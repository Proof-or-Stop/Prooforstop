# Proofbound Authority Receipt Contract

> **Retired legacy note:** Authority Server and server-backed receipt semantics in this document are retired/out-of-core for the active Proofbound CLI. Current implementation baselines are local proof admissibility (`admissibilityStatus`, `assuranceLevel`, `evidenceScope`), gate-consumed local evidence, signed/offline receipt bundles, and local review quorum assurance. Do not use this document as active Authority Server implementation guidance.

> Status: execution subdocument for
> [Authority Receipt Gate End-to-End Plan](authority-session-receipt-gate-execution.md).
> Owner: Proofbound Authority Python server.

## Purpose

This document defines the server-side contract Proofbound CLI uses to verify server
receipts and that lifecycle gates need before they can consume them.

The server work is contract alignment, not a rewrite. The Python Authority
Server already owns core primitives: policy discovery, actor key registration,
runner registry, jobs, evidence records, server key discovery, and
`gate_decision` receipts. The receipt proof route and receipt subject fields are
now current baseline; the remaining work is freezing the runner/session/gate
policy semantics tightly enough for another process to verify mechanically.

## Current Capability Baseline

| Capability | Status | Notes |
| --- | --- | --- |
| `GET /v1/authority/policy` | Done | Publishes compatibility, evidence requirements, server key, and trust posture. |
| Actor/key registry | Done | Server validates signed actor envelopes and key bindings. |
| Runner registry + heartbeat | Done/Partial | Runner identity and `sessionId` exist; contract must freeze how this becomes Authority runner session identity. |
| Job submit/claim/fetch/release | Done/Partial | Server owns job and lease state; final receipt chain must bind job/run/session. |
| Evidence envelope receive/validate | Done/Partial | Server validates evidence records, run bindings, adequacy, and policy. Receipt subject mapping is explicit on receipts; evidence-to-decision binding still needs CLI/gate verification. |
| Server public key discovery | Done/Partial | `serverKey` is published; CLI pinning and production trust rules must be stable. |
| `gate_decision` receipt | Done/Partial | Server signs gate decisions; receipt payload must expose enough binding metadata for remote verification. |
| Receipt subject fields | Done | `AuthorityReceipt` exposes `subjectKind`, `subjectId`, `subjectDigest`, and `authorityActorId`. |
| Receipt proof bundle | Done | `GET /v1/receipts/{receipt_id}/proof` returns `AuthorityReceiptProof` with input and decision digest material. |
| Receipt ref schema | CLI/gate-owned baseline | `authority-receipt-refs.json` belongs to CLI/gate; server fields must continue to support it. |

## Current Contract Decision: Receipt Subject

The server exposes a stable subject model. Current shape:

```json
{
  "receiptId": "AR-...",
  "kind": "gate_decision",
  "subjectKind": "gate_decision",
  "subjectId": "GD-...",
  "subjectDigest": "sha256:...",
  "projectId": "project-1",
  "storyId": "B-xxxx",
  "stateVersion": 42,
  "policyVersion": "authority-policy.v1",
  "inputDigest": "sha256:...",
  "decisionDigest": "sha256:...",
  "issuedAt": "2026-06-10T00:00:00.000Z",
  "serverKeyId": "akid-...",
  "signature": "ed25519:..."
}
```

The official mapping for CLI verification is:

| Meaning | Current field / mapping |
| --- | --- |
| receipt id | `receiptId` |
| receipt kind | `kind` |
| subject kind | `subjectKind`; for gate consumption it must equal `gate_decision` |
| subject id | `subjectId`, matching the gate decision id stored in the signed decision payload or associated record |
| subject digest | `subjectDigest`, expected to bind the gate decision digest |
| input binding | `inputDigest` |
| server key | `serverKeyId` + discovered server public key |
| signature payload | canonical JSON of receipt without `signature` |

The mapping must stay documented in server OpenAPI/docs and covered by tests.

## Gate Decision Receipt Requirements

A `gate_decision` receipt must allow a client to verify these facts without
trusting prose:

- receipt signature verifies against trusted Authority public key material;
- receipt was issued by the expected `serverKeyId`;
- receipt kind/subject is `gate_decision`;
- gate input digest matches the signed input payload;
- decision digest matches the signed decision payload;
- decision target phase matches the gate being consumed;
- decision verdict is `pass`;
- decision story id matches local story id;
- decision repo head/material hash matches local gate context;
- policy mode and authority mode are visible;
- consumed evidence digests are visible;
- authority actor id or equivalent actor-binding evidence is visible where
  policy requires actor binding;
- producer/verifier run ids used by the decision are visible where policy
  requires L2+ independence;
- runner session ids or equivalent runner session binding are visible where
  policy requires runner/session enforcement;
- policy discovery explicitly advertises when actor binding, runner heartbeat,
  or session lifecycle checks are hard requirements.

Recommended server-side gate decision payload:

```json
{
  "decisionId": "GD-...",
  "projectId": "project-1",
  "storyId": "B-xxxx",
  "authorityActorId": "actor-...",
  "targetPhase": "TEST",
  "verdict": "pass",
  "policyMode": "balanced",
  "authorityMode": "enforce",
  "repo": {
    "headHash": "...",
    "materialHash": "..."
  },
  "stateVersion": 42,
  "evidenceDigests": ["sha256:..."],
  "producerRunIds": ["run-producer-..."],
  "verifierRunIds": ["run-verifier-..."],
  "runnerSessionIds": ["session-..."],
  "diagnostics": {
    "maxPassingTrustLevel": 2,
    "hasPassingL3OrL4": false,
    "adequacy": "pass"
  }
}
```

The exact shape can differ, but every semantic above needs a stable field or
stable digest mapping.

## State Version Freshness

`stateVersion` is a server-state freshness guard, not a replacement for
head/material hash checks.

Rules:

- every gate decision receipt must carry the server story `stateVersion` used for
  evaluation;
- receipt refs must persist that `stateVersion`;
- if the local consumer has a current server `stateVersion`, it must reject a
  receipt ref whose stored version differs;
- if the local consumer is offline or lacks a current server `stateVersion`, it
  must still enforce head/material hash checks and follow the configured offline
  policy for revocation/supersession;
- policy or evidence changes that increment server state without changing
  head/material hash must make older gate receipts stale for Authority-required
  gates.

## Session Identity Contract

Preferred decision: server `sessionId` is the Authority runner session id.

Rules:

- `sessionId` is scoped to Authority URL + actor id + runner id + repo root.
- Runner heartbeat establishes the current session id.
- Job claim must include the current session id and must match runner registry
  state.
- Job spec or run metadata must expose the session id, directly or through
  signed metadata.
- Evidence submitted for runner-backed work must bind the session id directly or
  through server-owned job/run records.
- Gate decision diagnostics must expose enough run/session metadata for CLI
  receipt-ref projection.

Avoid introducing a second first-class `authoritySessionId` unless server API
review rejects `sessionId` as the canonical field.

## Public Key Discovery and Trust

The server must distinguish production-capable keys from local/dev keys.

Required discovery fields:

- `keyId`;
- `algorithm`;
- `encoding`;
- `publicKeyHex`;
- `profile`, such as `local-test` or `configured`;
- `ephemeral`;
- `productionInert`;
- optional rotation metadata.

CLI production verification must reject:

- ephemeral keys;
- bundled default test key ids;
- missing public key;
- unsupported algorithm declared in `serverKey.algorithm`, even if the raw verification material could otherwise be parsed;
- receipt `serverKeyId` mismatch;
- key material that does not match pinned digest or accepted discovery policy.

## Server Tests

Minimum acceptance tests:

- unsigned evidence is rejected;
- signed evidence with wrong actor key is rejected;
- runner heartbeat with mismatched runner id/session id is rejected;
- job claim with stale or mismatched session id is rejected;
- evidence with wrong story id is rejected;
- evidence with stale head/material hash is rejected;
- evidence with `producerRunId === verifierRunId` cannot satisfy L2+ policy;
- `gate_decision` receipt verifies against discovered server public key;
- corrupting gate input payload changes `inputDigest`;
- corrupting gate decision payload changes `decisionDigest`;
- default/local-test server key is advertised as production-inert.

## Out of Scope

This document does not implement CLI receipt refs, local gate predicates, or
runner provider execution. Those belong to the companion documents.
