# B-ea92 Milestone 1 Validation And Handoff

Story: B-ea92
Phase at handoff: DEV
Milestone: 1 - read-only authority enforce policy discovery

## Delivery Summary

Milestone 1 completed read-only policy discovery only. The TS CLI can discover and display the Python authority server's `/v1/authority/policy` contract through:

- `authority_enforce_policy`
- `koala authority enforce policy`

The command is discovery-only and prints the boundary disclaimer: `Authority policy discovery only: no receipt, no gate pass, no evidence submission.`

## Implemented Scope

- Added typed authority policy contract parsing for `authority-policy.v1`.
- Added `AuthorityClient.discoverPolicy()` as a read-only `GET /v1/authority/policy` path.
- Added a read-only CLI handler for policy discovery.
- Registered the command as read-only and available in all Koala phases.
- Added smoke coverage for valid policy parsing, malformed policy responses, HTTP failures, empty 2xx bodies, and overclaim keys.
- Documented the M1 boundary in `docs/requirements/decisions/authority-client-role.md`.

## Not Implemented In M1

M1 does not implement production authority, server receipts, L2+ gate evidence, actor keys, signed handshakes, job claim, provider execution, runner behavior, EvidenceEnvelope submission, evidence receipt verification, or gate promotion.

Future work must keep those capabilities behind explicit later milestones and Koala scope contracts.

## Validation Commands

Codex supervisor verification ran the following after Claude implementation:

- `npm --prefix packages/main run build` - pass
- `npm --prefix packages/main run test:authority-enforce-policy` - pass
- `npm --prefix packages/main run test:authority-client` - pass
- `npm --prefix packages/main run test:command-ownership-contract` - pass
- `npm --prefix packages/main run test:authority-boundary-smoke` - pass
- `npm --prefix packages/main run test:authority-evidence-flow` - pass

Manual CLI verification used a temporary local HTTP server and confirmed:

- `node packages/main/dist/cli.js authority_enforce_policy --authorityURL=<server>` exits 0 and prints `contractVersion: authority-policy.v1`, `requiredAuthorityMode: enforce`, and `evidencePolicy.preset: anti-hallucination`.
- `node packages/main/dist/cli.js authority enforce policy --authorityURL=<server>` exits 0 with the same discovery output.
- missing authority URL exits non-zero and still includes the discovery-only disclaimer.
- all successful policy discovery calls are `GET /v1/authority/policy`; no evidence POST endpoint is called.

`koala validate --story=B-ea92 --json` was run before this handoff and showed project fallback validation passed while CHK-005 coverage was missing. This file and the linked CHK-005 evidence close that handoff coverage gap.

## TEST Phase User-View Validation

Expected user-visible outcome:

- `authority_enforce_policy --authorityURL=<server>` succeeds against a reachable authority server.
- `authority enforce policy --authorityURL=<server>` succeeds through the nested alias.
- both successful commands print the discovery-only disclaimer and the parsed authority-policy fields.
- a missing authority URL fails non-zero and still prints the discovery-only disclaimer.
- the fake authority server only receives `GET /v1/authority/policy`; no evidence endpoint is called.

Actual transcript from the TEST phase:

```text
manual TEST validation passed
calls=GET /v1/authority/policy,GET /v1/authority/policy
flat-status=0 nested-status=0 missing-url-status=nonzero
```

Diff against expected: no product behavior mismatch. The command output used aligned field formatting such as `contractVersion:        authority-policy.v1`; the verifier accepted that as equivalent to the expected field/value pair.

## Next Safe Milestone

The next safe milestone should be actor identity and signed authority handshake only, after explicit approval. It should prove the CLI can identify the actor, bind it to authority policy requirements, and fail closed on missing or invalid handshake data.

Do not skip directly from policy discovery to evidence submission or receipt-backed gate promotion. Any later work on production evidence must separately implement and test signed actor binding, job identity, runner heartbeat expectations, EvidenceEnvelope construction, server receipt verification, and gate consumption.

## Handoff To Next Agent

- Do not rework the policy discovery contract unless the Python `/v1/authority/policy` response changes.
- Treat Python authority server semantics as authoritative; TS CLI is a consumer in M1.
- Preserve the discovery-only disclaimer on all `authority enforce policy` outputs.
- Preserve overclaim rejection for top-level `receipt`, `receiptId`, `gatePassed`, and `accepted` fields.
- Preserve thin-client behavior for existing `verification_evidence_add` flows until a later milestone explicitly implements receipt-backed enforcement.
