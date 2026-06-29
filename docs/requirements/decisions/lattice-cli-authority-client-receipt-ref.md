# Proofbound CLI Authority Client and Receipt Ref

> **Retired legacy note:** Authority Server and server-backed receipt semantics in this document are retired/out-of-core for the active Proofbound CLI. Current implementation baselines are local proof admissibility (`admissibilityStatus`, `assuranceLevel`, `evidenceScope`), gate-consumed local evidence, signed/offline receipt bundles, and local review quorum assurance. Do not use this document as active Authority Server implementation guidance.

> Status: execution subdocument for
> [Authority Receipt Gate End-to-End Plan](authority-session-receipt-gate-execution.md).
> Owner: Orchestrate / Proofbound CLI.

## Purpose

This document defines the Proofbound CLI contract for verifying Authority receipts
and persisting structured receipt refs that lifecycle gates can consume.

The local CLI baseline includes proof verification and receipt-ref writing. The
remaining work is production rollout alignment: live staging verification,
operator key/policy configuration, and explicit actor/runner/session enforcement
where required.

## Boundary

Ordinary Proofbound workflow remains local unless the explicit Authority enforce
path is approved and configured.

These surfaces remain diagnostic unless `authority_receipt_verify` verifies a
production `gate_decision` proof and a lifecycle gate consumes the resulting ref:

- `authority_status`;
- `conduit_status`;
- `conduit_explain`;
- policy discovery;
- transport `accepted=true`;
- local/fake receipts;
- contract-only receipt fixtures.

## Bundle Handoff

Most developers should consume the operator/server-provided handoff files rather
than setting live runner variables by hand. The ordinary pair is
`lattice_authority_trust.env` plus the referenced `lattice_staging-client.env`.
Keep both files together in the target workspace so any relative client-file path
resolves. Advanced/live runner handoff may provide the `lattice_senior_*` pair;
ordinary developers should not need senior files. `LATTICE_AUTHORITY_PROJECT_ID`
and any `LATTICE_AUTHORITY_GATE_ACTOR_*` values are required only for the live
runner / receipt verification / gate-consumption path documented below.

None of them may set:

- `receiptVerified=true`;
- `productionDone=true`;
- `strongEvidenceConsumed=true`;
- `authorityChanged=true`.

## Configuration Loader

The CLI Authority client must load:

- `LATTICE_AUTHORITY_URL`;
- actor id;
- actor private key path or key provider;
- `LATTICE_AUTHORITY_RUNNER_ID`;
- optional `LATTICE_AUTHORITY_SESSION_ID`;
- trusted server public key or pinned key digest;
- server key id;
- timeout and retry policy;
- authority mode, such as `off`, `shadow`, or `enforce`.

Configuration errors must be precise:

| Missing / invalid input | Required behavior |
| --- | --- |
| missing Authority URL | Authority operations fail closed |
| missing actor key | no signed envelope, no receipt ref |
| missing runner id | no job claim, no receipt ref |
| missing server public key in enforce mode | receipt verification fails closed |
| production-inert server key | cannot classify as production-gate-decision |
| manual session id only | status may show configured; no receipt ref |

## Session Lifecycle

The CLI may participate in session lifecycle only inside the approved Authority
client path.

Rules:

- generated session ids are scoped and persisted only in runtime/session storage;
- manual `LATTICE_AUTHORITY_SESSION_ID` is validated for shape and scope;
- ordinary local story commands must not silently create production Authority
  sessions;
- status output must distinguish readiness from verified receipt consumption.

## Receipt Fetch and Verification

The CLI primitive verifies a server receipt without trusting the local cache.

Input:

- Authority URL;
- receipt id or receipt URI;
- expected receipt kind;
- expected story id;
- expected target phase for gate decisions;
- expected head/material hash;
- trusted server public key material or accepted discovery policy.

Verification steps:

1. Fetch the server proof bundle with
   `GET /v1/receipts/{receipt_id}/proof`.
2. Parse receipt under the expected schema.
3. Resolve server public key by pinned material or trusted discovery.
4. Reject production-inert keys.
5. Verify receipt signature over canonical unsigned payload.
6. Recompute `inputDigest` from `inputPayload`.
7. Recompute `decisionDigest` from `decisionDigestPayload`.
8. Confirm receipt kind/subject is `gate_decision` for lifecycle gate use.
9. Confirm verdict is `pass`.
10. Confirm `stateVersion` is present; if the current server state version is
    known, confirm it matches.
11. Confirm story id, target phase, head hash, and material hash match local gate
    context.
12. Confirm consumed evidence digests and run ids satisfy policy fields exposed
    by the server decision.
13. When policy requires actor/runner/session enforcement, confirm
    `authorityActorId`, producer/verifier run bindings, and `runnerSessionIds`
    or equivalent runner session binding satisfy the advertised policy.
14. Return a structured verification result.

The primitive must return machine-readable fail reasons, not just prose.

## Policy Rollout Boundary

Current staging enforces production Authority/key posture, but actor key binding
and runner heartbeat/session lifecycle checks must be treated as rollout policy
until the server policy actively advertises and enforces them for the target
Authority mode. The CLI must not infer hard enforcement from compatibility field
names alone.

When unattended strong evidence requires those bindings, the receipt verifier and
gate consumer must require explicit policy evidence for actor binding,
producer/verifier run bindings, and runner session heartbeat state.

## Classification

Receipt verification returns a gate-ref classification. This is intentionally
separate from the existing evidence-level `receipt-backed-l2-plus`
classification: `receipt-backed-l2-plus` says an evidence envelope has the L2+
bindings and a verified evidence receipt; `production-gate-decision` says the
server evaluated a lifecycle gate and issued a verified production
`gate_decision` receipt.

Gate receipt verification returns one of:

| Classification | Meaning | May satisfy production gate? |
| --- | --- | --- |
| `production-gate-decision` | verified `gate_decision` receipt using trusted production-capable key | Yes |
| `server-receipt-local-test` | cryptographically valid but issued by local/test/ephemeral key | No |
| `contract-only` | deterministic fixture or fake server path | No |
| `transport-accepted` | server accepted a request, but no signed receipt verified | No |
| `invalid` | malformed, mismatched, stale, or bad signature | No |

Only `production-gate-decision` can be written as a gate-consumable receipt ref.
Other classifications can be recorded for diagnostics, but gates must ignore
them for production authority.

## Receipt-Ref Writer

The receipt-ref writer persists verified facts into a structured story artifact.

Recommended schema:

```json
{
  "schemaVersion": "lattice.authority_receipt_refs.v1",
  "storyId": "B-xxxx",
  "updatedAt": "2026-06-10T00:00:00.000Z",
  "refs": [
    {
      "receiptId": "AR-...",
      "receiptKind": "gate_decision",
      "classification": "production-gate-decision",
      "authorityUrl": "https://authority.example",
      "authorityKeyId": "akid-...",
      "authorityPublicKeyDigest": "sha256:...",
      "decisionId": "GD-...",
      "stateVersion": 42,
      "gateInputDigest": "sha256:...",
      "decisionDigest": "sha256:...",
      "decisionVerdict": "pass",
      "storyId": "B-xxxx",
      "targetPhase": "TEST",
      "headHash": "...",
      "materialHash": "...",
      "policyMode": "balanced",
      "authorityMode": "enforce",
      "producerRunIds": ["run-producer-..."],
      "verifierRunIds": ["run-verifier-..."],
      "sessionId": "session-...",
      "evidenceDigests": ["sha256:..."],
      "verifiedAt": "2026-06-10T00:00:00.000Z",
      "verifiedBy": "lattice authority receipt verify",
      "eligibleGates": ["TEST"],
      "consumptionEvents": []
    }
  ]
}
```

The writer must:

- write structured JSON, not prose;
- preserve previous refs unless superseded;
- mark stale refs rather than silently deleting them where audit needs history;
- never write `production-gate-decision` for fake, local-test, or contract-only
  receipts;
- include enough binding data for gates to re-check freshness without refetching
  the whole server state on every local command.

## Status Output

Status commands must separate these facts:

- Authority URL configured;
- actor key configured;
- runner id configured;
- session id configured/generated;
- server policy reachable;
- server public key trusted;
- receipt fetched;
- receipt signature verified;
- receipt classified production-gate-decision;
- receipt consumed by gate.

Readiness alone must not be rendered as authority completion.

## CLI Tests

Minimum acceptance tests:

- missing Authority URL fails Authority operations but leaves local workflow
  usable;
- manual session id alone cannot create receipt ref;
- fake receipt is classified `contract-only`;
- transport `accepted=true` keeps `receiptVerified=false`;
- local-test server key cannot classify as `production-gate-decision`;
- corrupt receipt signature fails verification;
- corrupt input payload fails digest verification;
- corrupt decision payload fails digest verification;
- story id mismatch rejects receipt ref;
- target phase mismatch rejects receipt ref;
- head/material drift marks receipt stale;
- valid production-capable fixture writes receipt ref.
