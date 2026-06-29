# Authority Receipt Cross-Repo Live Smoke

> **Retired legacy note:** Authority Server and server-backed receipt semantics in this document are retired/out-of-core for the active Proofbound CLI. Current implementation baselines are local proof admissibility (`admissibilityStatus`, `assuranceLevel`, `evidenceScope`), gate-consumed local evidence, signed/offline receipt bundles, and local review quorum assurance. Do not use this document as active Authority Server implementation guidance.

> Status: execution subdocument for
> [Authority Receipt Gate End-to-End Plan](authority-session-receipt-gate-execution.md).
> Owner: release / cross-repo validation.

## Purpose

This document defines the final live proof that the Authority receipt chain works
across the deployed staging Authority Server, Runner, and Proofbound CLI.

The smoke is valid only when it uses a real Authority Server, a registered
runner, real signed envelopes, a verified `gate_decision` receipt, and a local
gate that consumes the receipt ref.

## Required Environment

- deployed staging production-capable Proofbound Authority Server;
- non-ephemeral server private key;
- non-default server key id;
- trusted server public key or pinned digest;
- registered actor key;
- registered runner id;
- valid runner session id;
- repo with a story requiring Authority-backed evidence;
- clean or policy-accepted dirty state;
- Proofbound CLI build containing receipt verification and gate consumption.

Fake server fixtures and local contract servers can run earlier contract tests,
but this live smoke must label them invalid for production authority. A local
server is not an acceptable substitute for the final deployed staging smoke.

## Smoke Flow

```text
1. Use deployed staging Authority Server
2. Discover policy and server public key
3. Register or verify actor key
4. Register runner heartbeat with session id
5. Create story-scoped job
6. Runner claims job
7. Runner executes provider work
8. Runner signs evidence envelope
9. Server accepts evidence
10. Server evaluates gate
11. Server issues gate_decision receipt
12. CLI fetches and verifies receipt
13. CLI writes receipt-ref artifact
14. TEST or DONE gate consumes receipt ref
15. Negative control corrupts/removes receipt ref and gate fails
```

## Required Transcript

The final transcript must include these lines or structured equivalents:

```text
Authority readiness: PASS authorityUrl=<url> serverKeyId=<id>
Runner session: PASS runnerId=<id> sessionId=<id>
Authority job: PASS jobId=<id> runId=<id>
Evidence submission: PASS evidenceDigest=<sha256>
Gate decision: PASS receiptId=<id> targetPhase=<TEST|DONE>
Receipt verification: PASS receiptVerified=true classification=production-gate-decision
Receipt ref: PASS path=<path> decisionDigest=<sha256>
Gate consumption: PASS strongEvidenceConsumed=true story=<storyId> gate=<TEST|DONE>
Negative control: PASS corruptedReceiptBlocked=true
```

The transcript is not sufficient by itself. It must be backed by structured
artifacts and reproducible commands.

## Structured Evidence Required

Store or attach:

- Authority Server version and commit;
- Proofbound CLI version and commit;
- Runner version and commit;
- server policy response;
- server public key digest;
- actor key id;
- runner id;
- session id;
- job id;
- run id;
- signed evidence envelope digest;
- gate decision input payload digest;
- gate decision payload digest;
- gate decision receipt id;
- receipt-ref artifact path;
- gate output naming consumed receipt;
- negative-control output.

## Negative Controls

The smoke must prove that bypass attempts fail:

- remove receipt ref -> Authority-required gate fails;
- corrupt receipt signature -> verification fails;
- change story id -> gate rejects;
- change target phase -> gate rejects;
- change head hash -> stale receipt;
- change material hash -> stale receipt;
- use local-test server key -> not production-gate-decision;
- use evidence receipt without gate decision receipt -> no lifecycle gate pass;
- use transport `accepted=true` only -> no receipt verification.

## Pass Criteria

The smoke passes only when:

- all positive flow steps pass;
- all negative controls fail closed;
- the final consumed receipt is a verified `gate_decision` receipt;
- the receipt ref is structured;
- the gate names the consumed receipt id;
- `productionDone=true`, if emitted, is derived from gate consumption and not set
  by caller input.

## Failure Classification

| Failure | Classification |
| --- | --- |
| server unreachable | environment failure |
| server key production-inert | invalid production authority |
| actor key missing | setup failure |
| runner heartbeat missing | runner readiness failure |
| job claim rejected | runner/server contract failure |
| evidence rejected | evidence contract failure |
| gate decision fail | policy/evidence failure |
| receipt verification fail | trust/signature failure |
| receipt ref not written | CLI artifact failure |
| gate does not consume ref | lifecycle gate failure |
| negative control passes | release blocker |

## Release Rule

Do not claim the end-to-end Authority receipt chain is production-ready until
this smoke passes on real components and produces the required structured
evidence.
