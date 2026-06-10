# Authority session identity lifecycle + receipt-backed gate consumption

> Status: execution plan, not implemented behavior.
> Story: B-c5fe.
> Trigger: B-4a53 verified that the current local environment has no real
> Authority URL, actor key, runner id, Authority session id, server public key,
> remote job, verified receipt, or lifecycle gate consumption.

## Purpose

This document is the execution plan for the future end-to-end strong-evidence
chain:

```text
Authority env/config
  -> runner session identity
  -> Authority job
  -> signed evidence envelope
  -> signed AuthorityReceipt
  -> receipt ref persisted on story artifacts
  -> REVIEW / TEST / DONE gate predicate consumes the verified receipt
```

The core point is narrow: a session id is only one identity field. It is not the
strong-evidence chain. It becomes relevant only when the Authority Server, runner
host, Lattice CLI, and lifecycle gates all bind and verify it through structured
artifacts.

## Current boundary

Current Orchestrate/Lattice behavior is intentionally conservative:

- `authority_status`, `conduit_status`, and `conduit_explain` are diagnostics.
- `KOALA_AUTHORITY_SESSION_ID` is presence detection only.
- `KOALA_AUTHORITY_ACTOR_KEY`, `KOALA_AUTHORITY_ACTOR_KEY_PATH`, and
  `KOALA_AUTHORITY_RUNNER_ID` are readiness inputs, not authority evidence.
- Local lifecycle gates do not consume server receipts.
- Local receipts, handoff receipts, Parallel Wave refs, fake receipts, and
  transport `accepted=true` cannot set `receiptVerified=true`,
  `productionDone=true`, or `strongEvidenceConsumed=true`.
- B-4a53 is a blocked/fail-closed verification story, not completion of the
  strong-evidence implementation.

The future implementation must preserve this boundary until a signed receipt is
verified and consumed by a lifecycle gate predicate.

## Terms

| Term | Meaning |
| --- | --- |
| Local Lattice session | Local workflow/session identity such as `KOALA_SESSION_ID`, owner lease, activity log, or `session_brief` context. Useful for local audit, not Authority evidence. |
| Authority runner session id | Identity for one runner session under an Authority URL, actor key, runner id, and job/run context. This is the identity lifecycle this plan covers. |
| Run id | Authority job/run binding used by evidence, such as `producerRunId`, `verifierRunId`, or `JobSpec.runId`. L2+ requires producer and verifier run independence. |
| Evidence envelope | Structured evidence payload bound to story, repo snapshot, command/transcript/diff hashes, run ids, provider/model/vendor, nonce, timestamp, and signature. |
| AuthorityReceipt | Server-signed receipt acknowledging a subject, such as an evidence envelope, with a signature verified against the Authority Server public key. |
| Receipt ref | Story artifact reference that points to a verified receipt and the verified binding facts a gate can re-check. |

## Non-goals

This plan does not say the ordinary CLI is already an authority client. It also
does not require a single story to implement the whole stack.

Out of scope for a Lattice-only documentation story:

- implementing Python Authority Server endpoints;
- implementing runner provider execution;
- generating or registering actor keys;
- signing evidence envelopes;
- verifying `AuthorityReceipt` signatures in production gates;
- changing REVIEW, TEST, or DONE gate behavior;
- treating fake/local/server-ish test objects as production receipts.

Each behavior above needs its own implementation story and evidence.

## Execution streams

The full rollout must be split across four streams. A downstream stream may have
contract tests before its upstream dependency is live, but it must not claim live
completion until the upstream dependency is available.

| Stream | Repository/owner | Primary deliverables | Hard prerequisite for live pass |
| --- | --- | --- | --- |
| Python Authority Server | Authority server repo | policy endpoint, actor/key registry, runner registry, job queue, job claim/release, receipt signing, server public key, gate adequacy checks | deployed server with stable job/evidence/receipt schema and public key distribution |
| Runner / host execution plane | Mac Runner, Koala Runner CLI, Claude/Codex host integration | runner identity, heartbeat, job claim, provider execution, transcript/diff capture, signed evidence envelope, receipt submission/fetch | registered actor key and server-accepted runner/session/job contract |
| Orchestrate / Lattice CLI | this repo | env/config loader, Authority session lifecycle, job submit/fetch/verify client, receipt-ref artifact writer, gate predicate integration | server and runner contracts available, or local contract server explicitly marked fake/contract-only |
| Cross-repo validation | orchestration across repos | live smoke: server + runner + Lattice story produces verified receipt and gate consumes it | real Authority URL, actor key, runner id, session id, server public key, and a story-scoped job |

## Contract decisions required before implementation

Do not start gate implementation until these contract decisions are explicit.

1. Authority session field

   Current TypeScript contracts already have `JobSpec.runId`,
   `EvidenceEnvelopeContract.producerRunId`, and
   `EvidenceEnvelopeContract.verifierRunId`. They do not have a first-class
   `authoritySessionId` field.

   Recommended contract: add `authoritySessionId` as runner/session metadata on
   runner registration, heartbeat, job claim, job spec, and evidence envelope
   metadata, while keeping `producerRunId` and `verifierRunId` as the L2+ run
   independence fields. Do not overload local `KOALA_SESSION_ID`, `storyId`, or
   `runId` to mean all three concepts.

   If the server rejects a first-class `authoritySessionId`, the accepted mapping
   must be documented before implementation. A hidden mapping is not acceptable
   for gate evidence.

2. Receipt subject

   Receipt-backed gate consumption should prefer receipts whose
   `subjectKind === "evidence"` and whose `subjectId` matches the evidence
   envelope id. If the server also issues job or runner receipts, those can be
   supporting evidence, but they cannot replace the evidence-envelope receipt.

3. Freshness binding

   The verified envelope must bind at least:

   - `storyId`;
   - current `HEAD` or commit hash;
   - material hash;
   - dirty state policy;
   - `producerRunId`;
   - `verifierRunId`;
   - provider/model/vendor;
   - `commandDigest`;
   - `transcriptHash`;
   - `diffHash`;
   - `verificationContextPackId` and `verificationContextPackDigest` when a VCP is used.

4. Gate storage

   Story artifacts need a structured receipt-ref file or equivalent structured
   field. It must not be free prose. Static receipt eligibility and actual gate
   consumption must be separate facts. The consumer should be able to answer:

   - which receipt was verified;
   - which Authority public key verified it;
   - which envelope digest it binds to;
   - which story/head/material hash it covers;
   - which gates are eligible to consume it;
   - which gate consumption events actually happened;
   - whether the evidence is still fresh.

## Authority session identity lifecycle

The Lattice CLI stream should implement a small Authority identity lifecycle,
separate from local Lattice owner/session mechanics.

### Inputs

Required live inputs:

- `KOALA_AUTHORITY_URL` or configured equivalent;
- actor id and actor private key path or key provider;
- registered public key or server-side actor key registry;
- `KOALA_AUTHORITY_RUNNER_ID` or configured runner id;
- server public key, pinned key id, or trusted discovery path;
- optional `KOALA_AUTHORITY_SESSION_ID`.

### Generation and reuse

When no Authority session id is configured, the CLI/runner may generate one only
inside the authority-runner path. It must:

- be opaque and non-guessable;
- be scoped to Authority URL + actor id + runner id + local repo root;
- be stable for one runner session;
- not leak into ordinary local workflow as local production authority;
- be persisted only in the approved runtime/session store, not in arbitrary
  story prose.

When `KOALA_AUTHORITY_SESSION_ID` is configured, the CLI must validate shape and
scope before use. Invalid, empty, whitespace-only, or mismatched ids fail closed
for Authority runner operations.

### Binding

The session id must be included in the Authority job/evidence path, not merely
printed in status output.

Minimum binding points:

- runner registration or heartbeat metadata;
- job claim request;
- server-issued job spec or run metadata;
- evidence envelope metadata or first-class field after contract approval;
- receipt metadata or envelope digest that indirectly covers the field;
- receipt-ref artifact consumed by Lattice gates.

### Replay and freshness

A session id cannot be enough to reuse old evidence. Gate consumption must reject
receipt refs when any of these drift:

- story id;
- commit `HEAD`;
- material hash;
- evidence envelope digest;
- receipt subject;
- Authority public key or key id;
- producer/verifier run independence;
- required verification context pack digest.

## Receipt-backed gate predicate

`strongEvidenceConsumed=true` must be a derived fact, not a field a caller can set
directly.

The predicate should pass only when all conditions below are true:

1. A receipt ref exists in the current story artifact.
2. The referenced evidence envelope exists and parses under the expected schema.
3. The envelope has the required story, repo, command, transcript, diff, context
   pack, provider/model/vendor, run, nonce, timestamp, and signature fields.
4. `producerRunId` and `verifierRunId` are both present and different.
5. The envelope signature verifies against the registered actor key.
6. The `AuthorityReceipt` exists.
7. The receipt signature verifies against the pinned or trusted Authority Server
   public key.
8. `receipt.subjectKind === "evidence"`.
9. `receipt.subjectId === envelope.evidenceId`.
10. `receipt.subjectDigest`, when present, matches the canonical envelope digest.
11. The envelope `storyId`, `repo.headHash`, and `repo.materialHash` match the
    current story gate context.
12. The receipt ref has not expired, been revoked, or been superseded by a newer
    required receipt.
13. The gate records that it consumed this verified receipt for the current
    REVIEW, TEST, or DONE decision.

If any condition fails, the gate must report a specific fail-closed reason and
keep local workflow semantics intact unless the story explicitly requires
Authority-backed evidence.

## Story artifact shape

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
      "authorityUrl": "https://authority.example",
      "authorityKeyId": "akid-...",
      "authorityPublicKeyDigest": "sha256:...",
      "evidenceId": "EV-...",
      "envelopeDigest": "sha256:...",
      "storyId": "B-xxxx",
      "headHash": "...",
      "materialHash": "...",
      "producerRunId": "run-producer-...",
      "verifierRunId": "run-verifier-...",
      "authoritySessionId": "asess-...",
      "verifiedAt": "2026-06-10T00:00:00.000Z",
      "verifiedBy": "lattice authority receipt verify",
      "eligibleGates": ["REVIEW", "TEST", "DONE"],
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

## Phased rollout

### Phase 0: contract freeze

Deliverables:

- signed-off server job and receipt schema;
- explicit `authoritySessionId` decision or documented mapping;
- receipt-ref artifact schema;
- gate predicate specification;
- fake/contract server labels that cannot be mistaken for live receipts.

Acceptance:

- docs and contract tests prove fake receipts cannot set production authority;
- ordinary `authority_status` and `conduit_status` still report diagnostics only.

### Phase 1: Python Authority Server

Deliverables:

- `GET /v1/authority/policy`;
- actor/key registry;
- runner registry and heartbeat;
- job submit/claim/fetch/release;
- evidence envelope receive/validate;
- `AuthorityReceipt` signing;
- public key or key id discovery;
- adequacy result for gate consumers.

Acceptance:

- server tests reject unsigned envelopes;
- server tests reject wrong story/run/session/job binding;
- server signs receipts only after policy and schema checks pass;
- server exposes enough receipt metadata for Lattice to verify subject binding.

### Phase 2: runner / host execution plane

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

### Phase 3: Lattice CLI Authority client

Hard prerequisite: this phase must not start as ordinary CLI work. It requires
explicit enforce-mode product approval and must stay inside the isolated
`koala authority enforce` path described by the authority-client role decision.
Server and runner readiness alone are not approval to make the ordinary Lattice
CLI a production authority client.

Deliverables:

- env/config loader for Authority URL, actor key, runner id, session id, server
  public key, and timeout;
- session id generation/reuse/validation;
- job submit/fetch/verify commands or APIs;
- receipt fetch/verify primitive wired to real Authority public key material;
- receipt-ref writer;
- evidence freshness checker;
- status output that distinguishes diagnostic readiness from verified receipt
  consumption.

Acceptance:

- missing server/key/session/runner config fails closed for Authority operations;
- manual `KOALA_AUTHORITY_SESSION_ID` alone cannot produce a receipt ref;
- verified receipt refs include story/head/material/run/session binding;
- fake server outputs are labeled contract-only and cannot satisfy gates.

### Phase 4: Lattice lifecycle gate consumption

Hard prerequisite: this phase requires the same explicit enforce-mode product
approval as Phase 3, plus a reviewed receipt-ref schema and a real receipt
verification path. It must not be implemented as a normal REVIEW/TEST/DONE
relaxation or as prose-based promotion of local evidence.

Deliverables:

- REVIEW gate option for receipt-backed evidence where required;
- TEST validation consumption of receipt refs;
- DONE pre-check consumption of verified receipt refs;
- stale/revoked/mismatched receipt diagnostics;
- process fact registry updates for any gate-consumed receipt fact;
- process fact contract verification updates.

Acceptance:

- gates derive `strongEvidenceConsumed=true` only from verified receipt refs;
- deleting or corrupting the receipt ref blocks the Authority-required path;
- changing source material after verification makes the receipt stale;
- local workflow remains usable for stories that do not require Authority
  evidence.

### Phase 5: cross-repo live validation

Deliverables:

- one live Authority Server instance;
- one registered runner;
- one story-scoped job;
- one signed envelope;
- one verified receipt;
- one story artifact with receipt refs;
- one gate pass that names the consumed receipt.

Acceptance transcript:

```text
Authority readiness: PASS
Authority job: PASS jobId=<id> runId=<id>
Authority receipt: PASS receiptVerified=true receiptId=<id>
Gate consumption: PASS strongEvidenceConsumed=true story=<storyId> gate=<REVIEW|TEST|DONE>
```

This transcript is only valid when backed by the structured artifacts above.

## Fail-closed matrix

| Condition | Required result |
| --- | --- |
| Missing Authority URL | Authority runner operations fail closed; local workflow remains available. |
| Missing actor key | No signed envelope; no receipt-backed gate pass. |
| Missing runner id | No job claim; no receipt-backed gate pass. |
| Missing or invalid session id | Generate only in approved runner path, otherwise fail closed. |
| Missing server public key | Receipt verification fails. |
| Transport `accepted=true` only | Classification remains transport-accepted, not receipt-backed. |
| Fake/local receipt | Contract/local-only classification; no production authority. |
| Receipt subject mismatch | Receipt rejected. |
| Receipt signature invalid | Receipt rejected. |
| Story id mismatch | Gate rejects receipt ref. |
| HEAD/material hash drift | Gate reports stale evidence and rejects receipt ref. |
| `producerRunId === verifierRunId` | Not L2+; gate rejects strong evidence claim. |
| Report prose says pass but artifact missing | Gate rejects; prose is not evidence. |

## Suggested story split

1. Python Authority Server: job/receipt/key/policy endpoints.
2. Runner host: claim/execute/sign/submit path.
3. Lattice CLI: Authority env loader and session identity lifecycle.
4. Lattice CLI: receipt fetch/verify primitive against real server public keys.
5. Lattice CLI: receipt-ref story artifact writer.
6. Lattice CLI: REVIEW/TEST/DONE gate predicate consumption.
7. Cross-repo validation: live server + runner + Lattice gate proof.

The Lattice CLI stories may use a local contract server for deterministic tests,
but the story title, artifact names, and validation notes must say
`contract-only` until a real Authority Server and runner produce a verified
receipt.

## Verification checklist for future implementers

Before claiming completion of the end-to-end chain, answer all questions with
structured evidence:

- Which Authority URL issued the job?
- Which actor key signed the envelope?
- Which runner id claimed the job?
- Which Authority session id was bound?
- Which job id and run id were used?
- Which producer and verifier run ids are independent?
- Which story id, HEAD, and material hash were covered?
- Which envelope digest was signed?
- Which receipt id acknowledged that envelope?
- Which Authority public key verified the receipt?
- Which story artifact stores the receipt ref?
- Which gate consumed that ref?
- What command proves the gate would fail if the receipt ref were removed or
  corrupted?

If any answer is "not available", the correct result is blocked or
contract-only, not production done.

## Maintenance rule

Any future change that makes a gate consume Authority receipt facts must update
the process fact registry, process fact levels, relevant gate tests, and the
process fact contract verification script in the same story. A prompt or README
change alone is not enough for a gate-consumed process fact.
