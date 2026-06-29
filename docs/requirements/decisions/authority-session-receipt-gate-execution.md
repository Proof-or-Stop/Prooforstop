# Authority Receipt Gate End-to-End Plan

> **Retired legacy note:** Authority Server and server-backed receipt semantics in this document are retired/out-of-core for the active Proofbound CLI. Current implementation baselines are local proof admissibility (`admissibilityStatus`, `assuranceLevel`, `evidenceScope`), gate-consumed local evidence, signed/offline receipt bundles, and local review quorum assurance. Do not use this document as active Authority Server implementation guidance.

> Status: execution plan with current server and CLI/gate baseline noted.
> Scope: cross-repo Authority Server + Runner + Proofbound CLI + lifecycle gates.
> Trigger: current local Proofbound has receipt verification and gate-consumption
> primitives, but the complete live Authority job -> receipt -> consumed gate
> chain still needs production rollout validation.

## Purpose

This document is the top-level plan for the future production strong-evidence
chain:

```text
Authority env/config
  -> runner session identity
  -> Authority job / run
  -> signed evidence envelope
  -> server-accepted evidence record
  -> server-signed gate_decision receipt
  -> verified receipt ref persisted on story artifacts
  -> REVIEW / TEST / DONE gate predicate consumes the verified gate receipt
```

The key distinction is deliberate:

- An evidence receipt proves that the Authority Server accepted an evidence
  envelope.
- A `gate_decision` receipt proves that the Authority Server evaluated current
  story state, policy, evidence, hashes, and target phase and returned a gate
  verdict.
- Proofbound lifecycle gates must consume the verified `gate_decision` receipt as
  the authority conclusion. Evidence receipts can support that conclusion, but
  they cannot replace it.

This plan therefore covers a cross-repo implementation, not a single CLI patch.

## Document Set

This document is the overview. Execution details live in smaller owner-specific
documents:

- [Proofbound Authority Receipt Contract](lattice-authority-receipt-contract.md)
- [Authority Runner Session and Evidence Envelope](authority-runner-session-evidence-envelope.md)
- [Proofbound CLI Authority Client and Receipt Ref](lattice-cli-authority-client-receipt-ref.md)
- [Lifecycle Gate Receipt Consumption](lifecycle-gate-receipt-consumption.md)
- [Authority Receipt Cross-Repo Live Smoke](authority-receipt-cross-repo-live-smoke.md)

## Current Boundary

Current Orchestrate/Lattice behavior remains conservative:

- `authority_status`, `conduit_status`, and `conduit_explain` are diagnostics.
- `LATTICE_AUTHORITY_URL`, actor key config, runner id, and session id config are
  readiness inputs, not authority evidence by themselves.
- Local lifecycle gates do not require Authority receipts by default. In
  Authority shadow/enforce mode, TEST/DONE gate paths can consume verified
  production `gate_decision` receipt refs.
- Local receipts, handoff receipts, Parallel Wave refs, fake receipts,
  contract-only receipts, and transport `accepted=true` cannot set
  `receiptVerified=true`, `productionDone=true`, or
  `strongEvidenceConsumed=true`.
- A session id is an identity binding field, not the strong-evidence chain.

Every future implementation must preserve this boundary: only a server-signed
receipt verified against trusted Authority public key material and consumed by a
lifecycle gate predicate can derive production Authority completion facts.

## Current Server and CLI Baseline

As of the staging/API and Orchestrate source checks on 2026-06-10, the baseline
is no longer missing the proof route, receipt subject fields, or local
receipt-ref consumption primitives:

- `GET /v1/receipts/{receipt_id}/proof` exists and returns an
  `AuthorityReceiptProof` bundle.
- `AuthorityReceipt` exposes `subjectKind`, `subjectId`, `subjectDigest`, and
  `authorityActorId`.
- `GateDecision` exposes `decisionId`, `storyId`, `repo`, `stateVersion`,
  `evidenceDigests`, `producerRunIds`, `verifierRunIds`, and
  `runnerSessionIds`.
- staging advertises `productionEnforceAuthority=true` with a configured,
  non-ephemeral, non-production-inert server key.
- Proofbound CLI exposes `authority_receipt_verify` / `lattice authority receipt
  verify`.
- `AuthorityClient.fetchGateReceiptProof()` fetches a server-relative proof path.
- `authority-receipt-refs.json` has store APIs and an L4 process fact registry
  entry.
- TEST/DONE gate paths can read and consume verified production refs in
  Authority mode, and receipt consumption is idempotent for the same gate
  context.

The remaining work is production rollout alignment: exercise the current
server/CLI/gate baseline against the deployed staging service, wire explicit
actor/runner/session enforcement policy, and keep negative controls fail-closed.

## Host-Neutral Invariant

Authority evidence must be host-neutral. Claude CLI, Codex CLI, Mac Runner,
Runner CLI, CI, and human review are execution or attestation hosts; none is the
authority by brand. Production authority comes only from signed server receipts
whose payloads bind actor, runner/session, run, evidence, story, policy, and gate
facts. Host-specific integrations may collect transcripts or execute jobs, but
the receipt/gate contracts must not depend on a particular host product.

## Terms

| Term | Meaning |
| --- | --- |
| Local Proofbound session | Local workflow/session identity such as owner lease, activity log, or `session_brief` context. Useful for local audit, not Authority evidence. |
| Authority runner session id | Identity for one runner session under an Authority URL, actor key, runner id, and repo root. It must be bound through heartbeat, claim, evidence, and receipt verification. |
| Run id | Authority job/run binding used by evidence, such as `producerRunId`, `verifierRunId`, or `JobSpec.runId`. L2+ requires producer and verifier run independence. |
| Evidence envelope | Structured evidence payload bound to story, repo snapshot, command/transcript/diff hashes, run ids, provider/model/vendor, nonce, timestamp, and actor signature. |
| Evidence receipt | Server-signed acknowledgement that a specific evidence envelope was accepted. It is supporting evidence for gate evaluation. |
| Gate decision receipt | Server-signed `gate_decision` receipt issued after evaluating a gate input against current server state and policy. This is the receipt local lifecycle gates consume. |
| Receipt ref | Structured story artifact reference that stores a verified server receipt plus the binding facts a local gate can re-check. |
| Contract-only receipt | Test fixture or local fake used for deterministic contract tests. It must never satisfy production authority. |
| `receipt-backed-l2-plus` | Existing evidence-level classification for an envelope that has independent run bindings and a verified evidence receipt. It is not itself a lifecycle gate pass. |
| `production-gate-decision` | New receipt-ref classification for a verified production `gate_decision` receipt that may be consumed by lifecycle gates. |

## Non-Goals

This plan does not claim the ordinary CLI is already a production authority
client. It also does not require one story to implement the whole stack.

Out of scope for this documentation-only sync:

- implementing Python Authority Server endpoints;
- implementing runner provider execution;
- generating or registering actor keys;
- signing evidence envelopes;
- verifying `AuthorityReceipt` signatures in production gates;
- changing REVIEW, TEST, or DONE gate behavior;
- treating fake/local/server-ish test objects as production receipts.

Those behaviors require implementation or validation stories with mechanical
evidence; this sync only corrects stale plan status.

## Cross-Repo Streams

| Stream | Owner | Primary deliverables | Hard prerequisite for live pass |
| --- | --- | --- | --- |
| Authority Server | Proofbound Authority Python server | stable receipt contract, subject/digest fields or documented mapping, server public key discovery, actor/key registry, runner registry, job queue, evidence acceptance, gate decision receipts | deployed server with stable schema and trusted public key distribution |
| Runner / host execution plane | Mac Runner, Runner CLI, host integrations | runner identity, heartbeat, job claim, provider execution, transcript/diff capture, signed evidence envelope, evidence submission, receipt retrieval | registered actor key and server-accepted runner/session/job contract |
| Proofbound CLI | Orchestrate / Proofbound CLI repo | env/config loader, authority client, receipt fetch/verify, receipt-ref artifact writer, fake/contract-only classifier, status output | server and runner contracts available, or local contract server explicitly marked fake/contract-only |
| Lifecycle gates | Orchestrate / Proofbound CLI repo | receipt-ref gate predicate, process fact registry updates, REVIEW/TEST/DONE consumption, stale/revoked/mismatched diagnostics | real receipt verification path and reviewed receipt-ref schema |
| Cross-repo validation | release/e2e coordination | live server + registered runner + story-scoped job + evidence + gate_decision receipt + consumed receipt ref | real Authority URL, actor key, runner id, session id, server public key, and story-scoped job |

## Contract Decisions and Baseline

Do not expand REVIEW consumption, live enforcement, or production rollout policy
until these decisions are explicit and reflected in the concrete server/CLI
contracts.

### 1. Receipt Subject Model

The server now exposes first-class receipt subject fields. Clients still need to
verify the semantics mechanically through the proof bundle and decision payload.

Current contract fields:

- `receipt.kind`
- `subjectKind`
- `subjectId`
- `subjectDigest`
- `inputDigest`
- `decisionDigest`
- `serverKeyId`
- `issuedAt`
- `signature`

For `gate_decision`, `subjectKind` should be `"gate_decision"` and
`subjectId` should be the server gate decision id, not the receipt id. The
signed payload must also bind the evaluated story id, target phase, policy mode,
authority mode, repo head/material hash, evidence digests, and decision verdict.

### 2. Evidence Receipt vs Gate Decision Receipt

Gate consumption must use a verified `gate_decision` receipt. Evidence receipts
are supporting inputs only.

Required model:

```text
evidence envelope -> server accepted evidence record / evidence receipt
evidence records + story state + policy -> gate_decision receipt
local lifecycle gate -> verifies and consumes gate_decision receipt
```

This prevents a client from taking one accepted evidence envelope and treating it
as a complete gate pass under a different phase, policy, story state, or material
hash.

### 3. Authority Session Field

The contract needs one canonical Authority runner session field.

Preferred decision:

- use `sessionId` in server runner/job APIs;
- define it as the Authority runner session id;
- expose it in docs and CLI config as `LATTICE_AUTHORITY_SESSION_ID`;
- do not introduce a second first-class `authoritySessionId` unless the server
  rejects this mapping.

The session id must be bound at minimum through:

- runner registration or heartbeat metadata;
- job claim request;
- server-issued job spec or run metadata;
- evidence envelope metadata or signed payload;
- gate decision input digest, directly or through accepted evidence records;
- receipt-ref artifact consumed by Proofbound gates.

### 4. Freshness Binding

The verified gate decision must bind at least:

- `storyId`;
- target phase;
- current `HEAD` / commit hash;
- material hash;
- dirty state policy or clean-worktree assertion;
- `producerRunId`;
- `verifierRunId`;
- provider/model/vendor where policy requires diversity;
- `commandDigest`;
- `transcriptHash`;
- `diffHash` for mutating producer runs;
- `verificationContextPackId` and `verificationContextPackDigest` when a VCP is used;
- evidence record digests consumed by the server decision;
- server policy mode and authority mode.

### 5. Gate Storage

Story artifacts need a structured receipt-ref file or equivalent structured
field. It must not be free prose.

Static receipt eligibility and actual gate consumption are separate facts. The
consumer must be able to answer:

- which receipt was verified;
- which Authority public key verified it;
- which server key id issued it;
- which server state version issued it;
- which gate input digest and decision digest it binds to;
- which story/head/material hash it covers;
- which target phase and policy mode it covers;
- which evidence digests the server decision consumed;
- which gate consumption events happened locally;
- whether the evidence is still fresh.

## Receipt-Backed Gate Predicate

`strongEvidenceConsumed=true` must be a derived fact, not a field a caller can
set directly.

The predicate should pass only when all conditions below are true:

1. A receipt ref exists in the current story artifact.
2. The referenced `gate_decision` receipt exists and parses under the expected
   schema.
3. The receipt signature verifies against pinned or trusted Authority Server
   public key material.
4. The server key id matches the trusted key or accepted key rotation metadata.
5. The receipt kind/subject maps to `gate_decision`.
6. The gate input digest and decision digest match the verified server payloads.
7. The server state version is present; if the current server state version is
   known, it matches the receipt context.
8. The decision verdict is `pass`.
9. The decision target phase matches the local gate currently being evaluated.
10. The decision story id, repo head hash, and material hash match the current
   story gate context.
11. The decision authority mode is acceptable for the current product setting.
12. The decision consumed evidence records that satisfy configured policy,
    including producer/verifier run independence where required.
13. The referenced receipt has not expired, been revoked, or been superseded by
    a newer required decision.
14. The gate records that it consumed this verified receipt for the current
    REVIEW, TEST, or DONE decision.

If any condition fails, the gate must report a specific fail-closed reason and
keep local workflow semantics intact unless the story explicitly requires
Authority-backed evidence.

## Receipt-Ref Projection

The exact file name can be decided during implementation, but a receipt-ref
projection should be structured like this:

```json
{
  "schemaVersion": "lattice.authority_receipt_refs.v1",
  "storyId": "B-xxxx",
  "updatedAt": "2026-06-10T00:00:00.000Z",
  "refs": [
    {
      "receiptRef": "authority://receipts/...",
      "receiptId": "AR-...",
      "receiptKind": "gate_decision",
      "authorityUrl": "https://authority.example",
      "authorityKeyId": "akid-...",
      "authorityPublicKeyDigest": "sha256:...",
      "serverKeyTrust": "pinned",
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
      "sessionId": "asess-...",
      "evidenceDigests": ["sha256:..."],
      "verifiedAt": "2026-06-10T00:00:00.000Z",
      "verifiedBy": "lattice authority receipt verify",
      "classification": "production-gate-decision",
      "eligibleGates": ["TEST"],
      "consumptionEvents": [
        {
          "gate": "TEST",
          "consumedAt": "2026-06-10T00:00:00.000Z",
          "consumer": "lattice validate",
          "decisionId": "B-xxxx:validation:...",
          "result": "pass"
        }
      ]
    }
  ]
}
```

Fields that are not in the final server contract must be removed or explicitly
mapped. The implementation must not keep undocumented compatibility fields that
look authoritative but are ignored by gates.

## Phased Rollout

### Phase 0: Contract Freeze

Deliverables:

- signed-off server receipt schema or mapping;
- `sessionId` / `LATTICE_AUTHORITY_SESSION_ID` decision;
- receipt-ref artifact schema;
- gate predicate specification;
- fake/contract-only labels that cannot be mistaken for live receipts.

Acceptance:

- docs and contract tests prove fake receipts cannot set production authority;
- ordinary `authority_status` and `conduit_status` still report diagnostics only;
- the Authority Server contract document marks every field as Done / Partial /
  Missing.

### Phase 1: Server Contract Alignment

This is not a server rewrite. The Python Authority Server already owns much of
the baseline: policy discovery, actor keys, runner registry, jobs, evidence
records, server public key discovery, and gate decision receipts.

Deliverables:

- document current vs missing server fields;
- verify receipt subject/digest field mapping against CLI verification needs;
- ensure `gate_decision` receipts expose enough binding metadata for CLI
  verification;
- ensure runner `sessionId` is bound to heartbeat, claim, job/evidence, and gate
  digest chain;
- add server tests for wrong story/run/session/job binding.

Acceptance:

- server tests reject unsigned envelopes;
- server tests reject wrong story/run/session/job binding;
- server signs gate receipts only after policy and schema checks pass;
- server exposes enough receipt metadata for Proofbound to verify subject binding.

### Phase 2: Runner / Host Execution Plane

Deliverables:

- runner identity config;
- Authority session id generation or reuse;
- actor-key signing;
- heartbeat;
- job claim;
- provider execution;
- transcript and diff capture;
- evidence envelope signing;
- evidence submission and receipt retrieval.

Acceptance:

- runner cannot claim a job for a different runner id;
- runner cannot reuse a stale session for a mismatched Authority URL, actor, or
  runner;
- same-run producer/verifier evidence is rejected or classified non-L2+;
- failed provider execution produces a failed envelope/receipt path, not a
  production completion claim.

### Phase 3: Proofbound CLI Authority Client

Hard prerequisite: this phase must not start as ordinary CLI work. It requires
explicit enforce-mode product approval and must stay inside an isolated
Authority client path described by the authority-client role decision. Server
and runner readiness alone are not approval to make ordinary Proofbound CLI a
production authority client.

Deliverables:

- env/config loader for Authority URL, actor key, runner id, session id, server
  public key, and timeout;
- session id generation/reuse/validation;
- job submit/fetch/verify commands or APIs where CLI owns those actions;
- receipt fetch/verify primitive wired to real Authority public key material;
- receipt-ref writer;
- evidence freshness checker;
- status output that distinguishes diagnostic readiness from verified receipt
  consumption.

Acceptance:

- missing server/key/session/runner config fails closed for Authority operations;
- manual `LATTICE_AUTHORITY_SESSION_ID` alone cannot produce a receipt ref;
- verified receipt refs include story/head/material/run/session binding;
- fake server outputs are labeled contract-only and cannot satisfy gates.

### Phase 4: Proofbound Lifecycle Gate Consumption

Hard prerequisite: this phase requires explicit enforce-mode product approval,
a reviewed receipt-ref schema, and a real receipt verification path. It must not
be implemented as a normal REVIEW/TEST/DONE relaxation or as prose-based
promotion of local evidence.

Deliverables:

- REVIEW gate option for receipt-backed evidence where required;
- TEST validation consumption of receipt refs;
- DONE pre-check consumption of verified receipt refs;
- stale/revoked/mismatched receipt diagnostics;
- process fact registry updates for any gate-consumed receipt fact;
- process fact contract verification updates.

Acceptance:

- gates derive `strongEvidenceConsumed=true` only from verified `gate_decision`
  receipt refs;
- deleting or corrupting the receipt ref blocks the Authority-required path;
- changing source material after verification makes the receipt stale;
- local workflow remains usable for stories that do not require Authority
  evidence.

### Phase 5: Cross-Repo Live Validation

Deliverables:

- one deployed staging Authority Server instance;
- one registered runner;
- one story-scoped job;
- one signed evidence envelope;
- one server gate evaluation;
- one verified `gate_decision` receipt;
- one story artifact with receipt refs;
- one gate pass that names the consumed receipt.

Acceptance transcript:

```text
Authority readiness: PASS
Authority job: PASS jobId=<id> runId=<id>
Authority evidence: PASS evidenceDigest=<sha256>
Authority gate decision: PASS receiptVerified=true receiptId=<id>
Gate consumption: PASS strongEvidenceConsumed=true story=<storyId> gate=<TEST|DONE>
```

This transcript is only valid when backed by the structured artifacts above.

## Fail-Closed Matrix

| Condition | Required result |
| --- | --- |
| Missing Authority URL | Authority runner operations fail closed; local workflow remains available. |
| Missing actor key | No signed envelope; no receipt-backed gate pass. |
| Missing runner id | No job claim; no receipt-backed gate pass. |
| Missing or invalid session id | Generate only in approved runner path, otherwise fail closed. |
| Missing server public key | Receipt verification fails. |
| Transport `accepted=true` only | Classification remains transport-accepted, not receipt-backed. |
| Evidence receipt without gate decision receipt | Supporting evidence only; no local lifecycle gate pass. |
| Fake/local receipt | Contract/local-only classification; no production authority. |
| Receipt subject mismatch | Receipt rejected. |
| Receipt signature invalid | Receipt rejected. |
| Story id mismatch | Gate rejects receipt ref. |
| Target phase mismatch | Gate rejects receipt ref. |
| HEAD/material hash drift | Gate reports stale evidence and rejects receipt ref. |
| `producerRunId === verifierRunId` where L2+ is required | Not L2+; gate rejects strong evidence claim. |
| Report prose says pass but artifact missing | Gate rejects; prose is not evidence. |

## Suggested Story Split

1. Server: receipt subject/digest and gate decision metadata alignment.
2. Server: session/job/evidence binding tests.
3. Runner host: claim/execute/sign/submit path.
4. Proofbound CLI: Authority env loader and session identity lifecycle.
5. Proofbound CLI: receipt fetch/verify primitive against real server public keys.
6. Proofbound CLI: receipt-ref story artifact writer.
7. Proofbound CLI: REVIEW/TEST/DONE gate predicate consumption.
8. Cross-repo validation: live server + runner + Proofbound gate proof.

The Proofbound CLI stories may use a local contract server for deterministic tests,
but the story title, artifact names, and validation notes must say
`contract-only` until a real Authority Server and runner produce a verified
receipt.

## Verification Checklist

Before claiming completion of the end-to-end chain, answer all questions with
structured evidence:

- Which Authority URL issued the job?
- Which actor key signed the envelope?
- Which runner id claimed the job?
- Which Authority session id was bound?
- Which job id and run id were used?
- Which producer and verifier run ids are independent?
- Which story id, HEAD, and material hash were covered?
- Which evidence digest was accepted?
- Which gate input digest was evaluated?
- Which gate decision receipt was issued?
- Which Authority public key verified the receipt?
- Which story artifact stores the receipt ref?
- Which gate consumed that ref?
- What command proves the gate would fail if the receipt ref were removed or
  corrupted?

If any answer is "not available", the correct result is blocked or
contract-only, not production done.

## Maintenance Rule

Any future change that makes a gate consume Authority receipt facts must update
the process fact registry, process fact levels, relevant gate tests, and the
process fact contract verification script in the same story. A prompt or README
change alone is not enough for a gate-consumed process fact.
