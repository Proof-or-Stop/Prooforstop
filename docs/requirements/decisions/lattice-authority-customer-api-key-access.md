# Proofbound Authority Customer API Key Access

> **Retired legacy note:** Authority Server and server-backed receipt semantics in this document are retired/out-of-core for the active Proofbound CLI. Current implementation baselines are local proof admissibility (`admissibilityStatus`, `assuranceLevel`, `evidenceScope`), gate-consumed local evidence, signed/offline receipt bundles, and local review quorum assurance. Do not use this document as active Authority Server implementation guidance.

## Status

Requirements optimization. This document defines the production access model for
customers connecting Proofbound CLI / local runners to a hosted Proofbound Authority
server. It complements, but does not replace, the signed actor-envelope and
receipt requirements in `lattice-authority-live-integration.md`.

Core principle: do not optimize for the sake of optimization. Add only the
minimum access-control machinery required to make customer-to-server authority
usage real, auditable, revocable, and tenant-isolated.

## Problem

The localhost live verification proves that Proofbound CLI can talk to a real
Python Proofbound Authority server with real Ed25519 actor signatures. That is not
enough for a hosted customer service.

In hosted usage, each customer must receive a server access credential before
their CLI, runner, or project can use Proofbound Authority APIs. Without a
customer-scoped API key layer, any client that can register an actor public key
in development mode could become an authority actor. That is acceptable for
local development only, not for a customer-facing service.

## Required Access Model

Production Proofbound Authority access has two distinct credentials:

| Credential | Owner | Purpose | Sent on every request? | Stored by server? |
|---|---|---|---|---|
| Customer API key | Customer / workspace / project | Authenticates the paying or allowed tenant and scopes access to projects / APIs. | Yes for tenant-scoped APIs; policy discovery may stay public or key-optional. | Hash only; never raw. |
| Actor private key | Local CLI, runner, reviewer, main actor, host verifier | Signs the exact command/job/evidence/verdict envelope. Proves which actor performed the action. | Never as raw key; only signatures are sent. | Public key only. |
| Server signing key | Proofbound Authority server | Signs policy and native receipts. | No. Server public key is advertised/pinned. | Private key stays server-side only. |

Both customer API key and actor signature are required for production mutating
operations. The API key answers "which customer/project is allowed to call this
API"; the actor signature answers "which registered actor performed this exact
action."

## Non-Goals

- Do not use provider API keys, OpenAI keys, GitHub tokens, or other third-party
  secrets as Proofbound Authority access keys.
- Do not upload real customer secrets to test redaction. Use canary values and
  prove the server never stores the canary in raw form.
- Do not let a customer API key replace Ed25519 actor signatures. A bearer key
  alone is not a signed command/evidence/receipt boundary.
- Do not let actor key registration in production behave like localhost
  development mode.
- Do not block local non-authority mode. Customers can still run local-only
  Proofbound workflows without an Authority server or API key.

## Canonical Environment And Config

Canonical production variables:

```bash
LATTICE_AUTHORITY_URL=https://authority.example.com/
LATTICE_AUTHORITY_PROJECT_ID=<project-id>
LATTICE_AUTHORITY_SERVER_PUBLIC_KEY=<server-ed25519-public-key-hex-or-base64>

# Customer / tenant access credential. This authenticates the customer to the
# hosted server. Prefer _PATH in automation.
LATTICE_AUTHORITY_CUSTOMER_API_KEY=<customer-api-key>
LATTICE_AUTHORITY_CUSTOMER_API_KEY_PATH=/path/to/customer-api-key

# Actor signing credential. This signs individual envelopes. Prefer _PATH.
LATTICE_AUTHORITY_ACTOR_ID=<actor-id>
LATTICE_AUTHORITY_ACTOR_ROLE=runner|main|reviewer|verifier
LATTICE_AUTHORITY_ACTOR_KEY=<ed25519-private-key>
LATTICE_AUTHORITY_ACTOR_KEY_PATH=/path/to/actor-private-key
LATTICE_AUTHORITY_ACTOR_KEY_ENCODING=hex|base64|auto
LATTICE_AUTHORITY_RUNNER_ID=<runner-id>
LATTICE_AUTHORITY_SESSION_ID=<session-id>
```

Optional local management file:

```yaml
# authority.md (local, secret-aware, gitignored by default)
serverUrl: http://localhost:6789/
projectId: project-live-1
serverKeyId: local-test-server-key
serverPublicKeyEncoding: hex
serverPublicKey: <server-public-key-hex>
customerApiKeyPath: .lattice/secrets/customer-api-key
actorId: runner-live-1
actorRole: runner
actorKeyId: runner-live-1-key
actorKeyEncoding: hex
actorKeyPath: .lattice/secrets/runner-actor-key
runnerId: runner-live-1
sessionId: session-live-1
testKeyProfile: local-test
```

`authority.md` may contain paths or secret references. If it contains inline
secret values for local testing, those values must be redacted from diagnostics,
logs, artifacts, and evidence. Production guidance should prefer file paths or
OS secret-manager references.

## Production Request Flow

### 1. Customer API Key Issuance

An admin or self-service portal creates a customer API key:

- `customerId`
- `workspaceId`
- allowed `projectIds`
- allowed scopes
- expiration / rotation policy
- rate limit / quota policy
- display name / key prefix

The raw key is shown once. The server stores only:

- `keyId`
- `keyPrefix`
- `secretHash`
- `customerId`
- `workspaceId`
- scoped `projectIds`
- scopes
- status: `active | revoked | expired | rotated`
- timestamps: `createdAt`, `lastUsedAt`, `expiresAt`, `revokedAt`

### 2. Policy Discovery

CLI calls:

```text
GET /v1/authority/policy
```

The policy endpoint may remain public because it exposes only server capability
and public signing-key metadata. In production, the client must still pin or
verify the advertised server key before treating receipts as authoritative.

### 3. Actor Key Enrollment

CLI registers a local actor public key:

```text
POST /v1/actors/{actorId}/keys
Authorization: Bearer <LATTICE_AUTHORITY_CUSTOMER_API_KEY>
```

Server requirements:

- missing customer API key -> reject;
- invalid customer API key -> reject;
- revoked / expired key -> reject;
- project not in key scope -> reject;
- role not allowed for key scope -> reject;
- runner actor registration must bind `runnerId` and `projectId`;
- actor public key is stored only after customer authorization passes;
- raw actor private key is never sent.

### 4. Signed Mutating Operations

After actor enrollment, production mutating APIs require both:

1. `Authorization: Bearer <customer API key>` for tenant/project authorization;
2. signed actor envelope for action integrity and replay protection.

Applies to:

- `POST /v1/jobs`
- `POST /v1/runners/register`
- `POST /v1/runners/{runnerId}/heartbeat`
- `POST /v1/runners/{runnerId}/jobs/claim`
- `POST /v1/jobs/{jobId}/heartbeat`
- `POST /v1/jobs/{jobId}/release`
- `POST /v1/runs/{runId}/events`
- `POST /v1/runs/{runId}/provider-events`
- `POST /v1/evidence`
- `POST /v1/evidence/batch`
- `POST /v1/gates/evaluate`
- `POST /v1/jobs/{jobId}/verdicts`

The server must verify:

- API key is active and authorized for `projectId`;
- actor public key belongs to the same customer/project scope or allowed
  workspace scope;
- actor role is allowed for the endpoint;
- signature verifies against the registered actor public key;
- nonce has not been used;
- request project/story/job/run belongs to the same authorized tenant scope.

### 5. Receipts

Customer API keys do not create authority receipts. Only Proofbound Authority
server signing keys mint native receipts.

`authorityDone` requires:

- server-signed native `gate_decision` receipt;
- receipt server key pinned / verified;
- receipt project/story/job/gate digest matches the run;
- multi-host final verification wave satisfied when policy requires it.

## CLI Behavior

`lattice authority status --json` must distinguish:

- `customerApiKeyConfigured`
- `customerApiKeySource`: `env | path | authority_md | missing`
- `customerApiKeyValid`: unknown until live probe; never infer valid from
  presence
- `actorKeyConfigured`
- `actorKeyRegistered`
- `serverPublicKeyPinned`
- `localWorkflowUsable`
- `productionAuthorityUsable`

`lattice authority doctor --json` should run a bounded live check:

1. discover policy;
2. verify/pin server public key;
3. validate customer API key with a non-mutating endpoint if available;
4. register or check actor public key;
5. perform signed heartbeat or dry-run claim depending on role;
6. report exact blocker:
   - `customer_api_key_missing`
   - `customer_api_key_invalid`
   - `customer_api_key_revoked`
   - `customer_api_key_expired`
   - `project_not_authorized`
   - `actor_key_missing`
   - `actor_key_not_registered`
   - `actor_signature_invalid`
   - `server_key_unpinned`

Local non-authority mode must remain usable when any of these fail.

## Redaction Requirements

The customer API key and actor private key are secrets.

Redaction must cover at least:

- `LATTICE_AUTHORITY_CUSTOMER_API_KEY=...`
- `LATTICE_AUTHORITY_CUSTOMER_API_KEY_PATH=...` should not reveal file contents;
- `LATTICE_AUTHORITY_ACTOR_KEY=...`
- `Authorization: Bearer ...`
- `api-key=...`
- `customer-api-key=...`
- `actor-key=...`
- lowercase `bearer` / `basic`
- JSON forms such as `"customerApiKey": "..."` and `"actorKey": "..."`

Live redaction validation must use canary values, not real production keys:

```text
canary = lattice_canary_<uuid>
upload evidence containing customer-api-key=<canary>
query/list server evidence
assert raw canary is absent everywhere
assert redactionSummary is present
assert uploaded value is [REDACTED] or digest-only
```

## Server-Side Enforcement

Client-side redaction is required but not sufficient for hosted service safety.
The server should add a second fail-closed guard for obvious raw secrets:

- reject evidence payloads with raw `Authorization: Bearer ...`;
- reject or quarantine evidence payloads containing customer API key canary
  shapes;
- never log `Authorization` headers;
- never log request bodies before redaction;
- store request audit metadata using key id / actor id / project id, never raw
  key material.

This server guard is defense-in-depth. It must not replace client-side redaction.

## Milestones

| Milestone | Scope | Acceptance |
|---|---|---|
| K1 | Config and status fields | CLI reads env/path/authority.md, reports customer API key presence without printing values. |
| K2 | Server key table | Server stores customer API keys by hash, scope, status, expiry, and rate-limit metadata. |
| K3 | Actor enrollment gate | Production actor key registration requires valid customer API key and project scope. |
| K4 | Mutating API authorization | Jobs, runner control plane, evidence, gate, and verdict endpoints require customer API key + signed actor envelope. |
| K5 | Tenant isolation | Cross-project job/evidence/verdict attempts are rejected even with a valid key for another project. |
| K6 | CLI doctor live probe | Missing/wrong/revoked/expired key and wrong actor signature produce exact machine-readable blockers. |
| K7 | Redaction and logging | Customer key / actor key / authorization headers never appear in logs, artifacts, evidence, or receipts. |
| K8 | Live canary upload proof | Canary evidence upload to real Python Authority proves raw canary absent from server storage. |
| K9 | Rotation and revocation | Old keys can be revoked/rotated; active sessions fail closed after revocation according to policy. |

## Test Matrix

Required tests:

- no customer API key -> actor registration rejected;
- wrong customer API key -> rejected;
- revoked customer API key -> rejected;
- expired customer API key -> rejected;
- valid key but wrong project -> rejected;
- valid key and correct project -> actor registration accepted;
- actor signed with wrong private key -> mutating request rejected;
- valid customer key + valid actor signature -> job create / claim / release
  accepted;
- evidence upload, gate evaluation, and verdict submission reject missing or wrong
  customer API key;
- evidence upload, gate evaluation, and verdict submission reject missing or wrong
  actor signatures;
- evidence upload, gate evaluation, and verdict submission accept only valid
  customer key + valid actor signature for the same project scope;
- valid customer key + actor from another project -> rejected;
- local non-authority mode runs with no server key;
- authority mode fails closed on missing key;
- redaction smoke removes `customer-api-key=...`, `actor-key=...`,
  `Authorization: Bearer ...`, lowercase `bearer/basic`, and
  `LATTICE_AUTHORITY_*_KEY=...`;
- live canary evidence upload proves raw canary absent from server storage.

## Relationship To Existing Localhost Verification

The localhost V1-V6 run remains useful but is not enough for hosted production
access. It proves:

- the Python server can run;
- server key pinning works;
- actor Ed25519 signatures work;
- job create / runner claim / release can happen against a real server.

The customer API key layer adds:

- per-customer authorization before actor enrollment;
- tenant/project scoping for every mutating endpoint;
- revocation and rotation;
- API key redaction and server-side log safety;
- production-like proof that a customer can use the service only through an
  issued server API key.

## Open Implementation Decisions

- Should `GET /v1/authority/policy` remain public, or require an optional
  customer API key in production?
- If short-lived actor sessions are added, should they be an additional
  customer-scoped optimization for repeated calls? They must not replace K4:
  every production mutating endpoint still requires customer authorization and a
  signed actor boundary.
- Should `authority.md` allow inline keys for local testing, or only path /
  secret-manager references?
- Should server-side secret scanning reject evidence immediately, or quarantine
  and mark the job blocked?

These are implementation decisions, not blockers to the core requirement:
production customer access requires a customer-scoped server API key plus signed
actor envelopes.
