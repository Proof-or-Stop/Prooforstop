# Lifecycle Gate Receipt Consumption

> **Retired legacy note:** Authority Server and server-backed receipt semantics in this document are retired/out-of-core for the active Proofbound CLI. Current implementation baselines are local proof admissibility (`admissibilityStatus`, `assuranceLevel`, `evidenceScope`), gate-consumed local evidence, signed/offline receipt bundles, and local review quorum assurance. Do not use this document as active Authority Server implementation guidance.

> Status: execution subdocument for
> [Authority Receipt Gate End-to-End Plan](authority-session-receipt-gate-execution.md).
> Owner: Orchestrate / Proofbound CLI lifecycle gates.

## Purpose

This document defines how REVIEW, TEST, and DONE gates consume verified
Authority receipt refs. The current local baseline wires TEST/DONE consumption in
Authority shadow/enforce mode; REVIEW consumption remains policy-dependent.

The core rule is simple: local lifecycle gates may derive
`strongEvidenceConsumed=true` only from a verified production `gate_decision`
receipt ref whose binding facts match the current gate context.

## Gate Inputs

Gate consumption needs:

- current story id;
- current target phase;
- current head hash;
- current material hash;
- current gate policy;
- authority requirement mode for this story/project;
- receipt-ref artifact;
- process fact registry entry for receipt-backed authority;
- optional live refetch policy for revocation/supersession.

Policy must state which actor/runner/session bindings are hard requirements.
Compatibility field names alone are not enough to make actor key binding or
runner heartbeat checks gate-enforced.

## Receipt Eligibility Predicate

A receipt ref is eligible only when:

1. `schemaVersion` is supported.
2. `classification === "production-gate-decision"`.
3. `receiptKind === "gate_decision"`.
4. `receiptId` is present.
5. Authority public key digest and key id are present.
6. `stateVersion` is present; if the current server state version is known, it
   matches.
7. `gateInputDigest`, `decisionDigest`, and `decisionVerdict === "pass"` are
   present.
8. `storyId` matches current story.
9. `targetPhase` matches current gate.
10. `headHash` matches current head.
11. `materialHash` matches current material hash.
12. `policyMode` and `authorityMode` are acceptable.
13. `verifiedAt` is present and within allowed freshness policy.
14. actor binding and `runnerSessionIds` or equivalent session binding are
    present when policy marks actor/runner/session checks as hard requirements.
15. no stale/revoked/superseded marker blocks it.

Eligibility is not consumption. A receipt can be eligible but not yet consumed by
a particular gate decision.

## Gate Consumption Predicate

A gate consumes a receipt ref only when:

1. the receipt is eligible;
2. the gate requires or allows Authority-backed evidence;
3. local gate context exactly matches the receipt binding facts;
4. the receipt decision verdict is known to be pass;
5. required evidence digests and run ids are present;
6. producer/verifier independence is visible where the policy requires it;
7. actor binding and runner session binding are visible where the policy
   requires them;
8. the gate records a consumption event for this decision.

The derived gate fact should look like:

```json
{
  "fact": "strongEvidenceConsumed",
  "value": true,
  "source": "authority_gate_decision_receipt",
  "receiptId": "AR-...",
  "stateVersion": 42,
  "targetPhase": "TEST",
  "storyId": "B-xxxx",
  "headHash": "...",
  "materialHash": "...",
  "decisionDigest": "sha256:..."
}
```

No caller can set this fact directly.

## REVIEW Gate

REVIEW consumption is optional unless a story/project policy requires
Authority-backed review evidence.

When enabled, REVIEW may consume a server gate decision that says review
requirements passed. It must not use a raw reviewer pass, local finding status,
or accepted evidence receipt as equivalent to a `gate_decision` receipt.

Fail-closed reasons:

- `authority_receipt_missing`;
- `authority_receipt_not_gate_decision`;
- `authority_receipt_phase_mismatch`;
- `authority_receipt_story_mismatch`;
- `authority_receipt_stale_material`;
- `authority_receipt_not_production_classified`;
- `authority_receipt_signature_unverified`.

## TEST Gate

TEST is the first primary consumer for receipt-backed authority.

When Authority-backed TEST is required:

- `lattice validate` must verify or read a fresh verified receipt ref;
- local validation pass alone is not enough;
- changing material after receipt verification makes the receipt stale;
- deleting/corrupting the ref blocks the Authority-required path;
- the validation output must name the consumed receipt id.

Local workflow remains usable for stories that do not require Authority-backed
evidence.

## DONE Gate

DONE is stricter than TEST because it changes lifecycle completion state.

When Authority-backed DONE is required:

- a passing TEST receipt may be insufficient unless policy says TEST receipt can
  cover DONE;
- preferred model is a distinct DONE `gate_decision` receipt;
- DONE must re-check current head/material hash immediately before merge/finish;
- stale receipt refs block DONE;
- gate consumption must be recorded before local `productionDone=true` can be
  derived.

## Local Review Escalation Gate

Review escalation is a local DONE gate, not Authority Server receipt completion.
Documentation and decision-doc audit changes follow ordinary REVIEW by default.
Direct edits under `docs/requirements/decisions/*.md` are
classification/diagnostic only; they do not by themselves require 3 rounds x 2
hosts at DONE.

Local DONE requires review escalation only when the first lifecycle REVIEW round
records at least two countable reviewer problems:

- the finding agent is a `lattice-review-*` reviewer;
- severity is `critical`, `high`, or `medium`;
- `evidenceState` is `verified`, or the legacy field is missing.

Suspected findings, disproven findings, low-severity findings, non-reviewer
findings, and later-round findings do not trigger the escalation requirement.
When triggered, full local quorum requires:

- 3 distinct `runId` rounds over the current material hash;
- at least 2 independent PASSing hosts in each round;
- host verdict binding fields for host, session, key, material, validation, and
  prompt;
- stale material, duplicate host/session/key identity, FAIL/BLOCKED decisions,
  and missing binding fields fail closed.

`autopilot_review_submit` records local `host_verdict` workflow evidence consumed
by this local review escalation gate. The write is a host/reviewer evidence
write, not a story owner self-certification path, so it is exempt from story
owner lease while remaining local and non-authority. `review_escalation_status`
reports the actual DONE requirement read-only. `decision_doc_quorum_check`
remains a decision-doc diagnostic only; it must not claim that every decision-doc
edit requires quorum. Neither command verifies a server `gate_decision` receipt,
nor may either command derive Authority receipt completion, `authorityDone`,
`fullAuthorityDone`, or `productionDone`.

An explicit degraded fallback may satisfy local DONE only as
`assuranceLevel=degraded-single-host`: allowed eligibility/reason, evidence or
approval, fresh material binding, and 3 rounds with at least 1 PASS host. The
degraded path must never be reported as full 3x2 or Authority completion.

## Process Fact Registry Updates

Any gate-consumed receipt fact must be represented in process fact registry
code, not just prompt text.

Required registry concepts:

- receipt-ref artifact schema;
- receipt classification;
- receipt eligibility predicate;
- receipt consumption event;
- `strongEvidenceConsumed`;
- `productionDone`;
- stale/revoked/mismatched fail reasons.

The process fact contract verification script must fail if a gate-consuming fact
is documented but not registered.

## Stale / Revoked / Superseded Rules

Receipt refs become unusable when:

- story id differs;
- target phase differs;
- known current server state version differs;
- head hash differs;
- material hash differs;
- server key id/digest differs from trusted key policy;
- receipt has expired;
- server revocation check marks it revoked;
- a newer required receipt supersedes it;
- evidence digests referenced by the decision are no longer accepted under
  current policy.

Revocation and supersession may require live server checks. If offline, the gate
must follow configured policy: fail closed for Authority-required stories, or
fall back to local-only behavior for stories that do not require Authority.

## Tests

Minimum acceptance tests:

- no receipt ref means `strongEvidenceConsumed=false`;
- fake/contract-only receipt is ignored by production gate;
- evidence receipt without gate decision receipt is ignored by lifecycle gate;
- corrupt receipt ref fails;
- target phase mismatch fails;
- story mismatch fails;
- head hash drift fails;
- material hash drift fails;
- local validation pass without receipt fails when Authority is required;
- deleting receipt ref after validation makes Authority-required DONE fail;
- valid `gate_decision` receipt ref is consumed and named in gate output;
- process fact registry verification fails if the gate fact is missing.
