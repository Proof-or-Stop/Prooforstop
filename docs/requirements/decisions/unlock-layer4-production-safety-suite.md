# Unlock Layer 4 Production Safety Baseline Suite

> **Retired legacy note:** Authority Server and server-backed receipt semantics in this document are retired/out-of-core for the active Proofbound CLI. Current implementation baselines are local proof admissibility (`admissibilityStatus`, `assuranceLevel`, `evidenceScope`), gate-consumed local evidence, signed/offline receipt bundles, and local review quorum assurance. Do not use this document as active Authority Server implementation guidance.

> Layer: 4
> Capability: Production Safety Baseline
> Status: execution plan for formal unlock
> Depends on: fresh Layer 1 Development proof, fresh Layer 2 Engineering proof,
> and fresh Layer 3 Loop Engineering proof
> Non-goal: this document does not unlock global Capability Claim, arbitrary
> production unattended development, or fullAuthorityDone by itself

## 1. Purpose

This document defines the execution plan to formally unlock the Layer 4
Production Safety Baseline.

The goal is not to add another theory layer. The goal is to prove that Proofbound
can consume production-grade Authority evidence without turning local
diagnostics, host transcripts, fake receipts, stale receipts, or prose claims
into production completion facts.

The core question answered by this unlock is:

```text
Can Proofbound safely convert Authority-backed, server-signed, freshness-bound,
multi-host-reviewed evidence into a production safety claim for tested task
classes while failing closed on missing, stale, tampered, or local-only proof?
```

The allowed claim after unlock is:

```text
Proofbound has validated the Layer 4 Production Safety Baseline for the tested
Authority-backed task classes.
```

Plain wording:

```text
Proofbound has validated the Layer 4 Production Safety Baseline for the tested
Authority-backed task classes.
```

The unlock does not allow these claims:

- Proofbound can develop arbitrary projects unattended in production.
- Proofbound is globally production-grade.
- Proofbound has unlocked global Capability Claim.
- Proofbound can skip Layer 1, Layer 2, or Layer 3 proof.
- Proofbound can treat local CLI status as production Authority.
- Proofbound can treat a customer API key as an Authority receipt.
- Proofbound can treat a host transcript as a server-signed receipt.
- Proofbound can claim fullAuthorityDone without the required final certification
  wave policy.

Terminology note:

```text
Layer 3 = Loop Engineering / UDM.
Layer 4 = Production Safety.
```

If an older conversation says "Layer 3 Production Safety", normalize that to
Layer 4 in documents, reports, and claim evaluators.

## 2. Governing Principles

All execution must follow these four principles:

```text
Do not optimize for the sake of optimization.
Do not optimize arbitrarily.
Only fix real correctness issues.
Preserve consistency of logic.
```

Operational meaning:

- Do not add more baselines merely to make the suite look stronger.
- Do not change Authority or receipt semantics unless a real correctness issue
  is found.
- Do not convert an expected block into PASS for schedule momentum.
- Do not use local-only artifacts as production evidence.
- Do not refresh stale proof by editing reports by hand.
- Do not unlock global claims from Layer 4 proof.
- Do not let host reviewers block on optional style, speculative architecture,
  or non-correctness optimization preferences.

## 3. Source Documents

This document consolidates the existing Production Safety and Authority
execution material. It does not replace the source contracts.

| Source document | Production Safety role |
|---|---|
| [Proofbound Unattended Completion Plan](lattice-unattended-completion-plan.md) | Defines the M3-M8, M15, and M16 production completion path. |
| [Authority Receipt Gate End-to-End Plan](authority-session-receipt-gate-execution.md) | Defines the Authority receipt and lifecycle gate end-to-end proof chain. |
| [Proofbound Authority Receipt Contract](lattice-authority-receipt-contract.md) | Defines server receipt fields, signature, proof bundle, freshness, and session binding. |
| [Proofbound CLI Authority Client and Receipt Ref](lattice-cli-authority-client-receipt-ref.md) | Defines CLI-side receipt verification and receipt ref persistence. |
| [Lifecycle Gate Receipt Consumption](lifecycle-gate-receipt-consumption.md) | Defines how lifecycle gates consume verified receipt refs. |
| [Proofbound Authority Customer API Key Access](lattice-authority-customer-api-key-access.md) | Defines customer API key boundaries and credential separation. |
| [Authority Runner Session and Evidence Envelope](authority-runner-session-evidence-envelope.md) | Defines runner/session/evidence envelope binding. |
| [Authority Receipt Cross-Repo Live Smoke](authority-receipt-cross-repo-live-smoke.md) | Defines live staging smoke proof expectations. |
| [Proofbound Authority Remote Evidence Bundle](lattice-authority-remote-evidence-bundle.md) | Defines remote evidence bundle shape. |
| [Proofbound Authority M1-M16 Generated Proof And Live E2E Plan](lattice-authority-m1-m16-generated-proof-and-live-e2e.md) | Provides detailed live E2E implementation sequencing. |

If this document conflicts with a lower-level contract, the lower-level
Authority or gate contract controls the exact field semantics.

## 4. Unlock Boundary

Layer 4 proves production safety controls for tested Authority-backed task
classes. It does not prove a global product claim.

| Layer | Required before Layer 4? | Boundary |
|---|---:|---|
| Layer 1 Development | Yes | Basic development tasks pass with evidence. |
| Layer 2 Engineering | Yes | Real engineering baselines pass with formal proof. |
| Layer 3 Loop Engineering | Yes | Bounded unattended loop model passes without false DONE. |
| Layer 4 Production Safety | Current target | Authority-backed production safety controls pass. |
| Layer 5 Capability Claim | No, remains locked | Controls public/global claims from lower-layer proofs. |

What can be said after Layer 4 passes:

```text
Proofbound has validated Authority-backed Production Safety controls for the
tested task classes.
```

What cannot be said after Layer 4 alone:

```text
Proofbound has unlocked all capability claims.
Proofbound can run arbitrary production unattended development.
Proofbound can claim fullAuthorityDone without the required final certification.
```

## 5. Required Preconditions

Formal Layer 4 execution must not start until all of these are true:

| Precondition | Required state | Fail-closed status if missing |
|---|---|---|
| Target freeze | Target HEAD and material hash are selected and stable. | `LOCKED: unfrozen target` |
| Layer 1 proof | Fresh Development proof is bound to the selected target. | `LOCKED: stale lower-layer proof` |
| Layer 2 proof | Formal Engineering claim is `UNLOCKED` for the selected target. | `LOCKED: stale lower-layer proof` |
| Layer 3 proof | Formal Loop Engineering claim is `UNLOCKED` for the selected target. | `LOCKED: stale lower-layer proof` |
| Artifact root | Formal artifacts are under `.lattice/artifacts/baseline/layer4-production-safety-unlock`. | `BLOCKED: wrong artifact root` |
| Authority server | Real Authority URL is configured and classified as production-capable or staging-production-capable for this run. | `BLOCKED: no live Authority` |
| Server key trust | Trusted Authority public key material is pinned or otherwise verified by the approved profile. | `BLOCKED: untrusted Authority key` |
| Customer credential | Customer API key is available through approved secret loading and is not committed. | `BLOCKED: missing customer credential` |
| Actor key | Actor key is enrolled, scoped, and available through approved secret loading. | `BLOCKED: missing actor key` |
| Runner identity | Runner id and Authority runner session id are established. | `BLOCKED: missing runner/session` |
| Layer 4 evaluator | Formal evaluator can authorize only `production-safety`. | `BLOCKED: missing Layer 4 formal evaluator` |
| Higher-layer lock | Global Capability Claim remains locked unless separately proven. | `BLOCKED: claim boundary violation` |

## 6. Artifact Root

All formal Layer 4 artifacts must be under:

```text
.lattice/artifacts/baseline/layer4-production-safety-unlock
```

Every baseline run must write:

```text
.lattice/artifacts/baseline/layer4-production-safety-unlock/production-safety/<baseline-id>/<run-id>/
```

Required files:

| File | Purpose |
|---|---|
| `input.md` | Baseline task, Authority profile, and expected outcome. |
| `target.json` | Target HEAD, material hash, repo root, story id when applicable, and suite run id. |
| `authority-profile.json` | Redacted Authority URL, key id, runner id, session id, policy mode, and trust posture. |
| `credential-check.json` | Redacted customer key and actor key readiness result. |
| `evidence-envelope.json` | Submitted evidence envelope metadata and digests. |
| `receipt-proof.json` | Authority receipt proof bundle or a redacted verified projection. |
| `receipt-ref.json` | Local receipt ref consumed by lifecycle gates. |
| `gate-consumption.json` | TEST/DONE gate input, consumed receipt ref, and decision. |
| `negative-controls.json` | Tamper, stale, revoked, wrong-run, wrong-material, and fake-receipt controls. |
| `host-verdicts.json` | Independent host review verdicts over the same anchors. |
| `final-report.json` | Machine-readable per-baseline outcome. |
| `final-report.md` | Human-readable per-baseline summary. |

Secret values must never be written to the artifact root. Store only redacted
prefixes, key ids, hashes, receipt ids, or digests.

## 7. Baseline Suite

The first formal Layer 4 unlock requires this suite.

| Baseline ID | Verifies | Expected outcome |
|---|---|---|
| `PROD-AUTH-LIVE-1` | Proofbound talks to a real Authority service and rejects mocked or contract-only service outputs. | `PASS` |
| `PROD-CUSTOMER-KEY-1` | Missing, invalid, revoked, expired, rotated, and out-of-scope customer API keys fail closed. | `PASS` |
| `PROD-ACTOR-RUNNER-SESSION-1` | Actor signature, runner id, heartbeat, job claim, and session id are bound through the job. | `PASS` |
| `PROD-EVIDENCE-BINDING-1` | Evidence upload is bound to story, job/run, producer/verifier run ids, head hash, material hash, and evidence digest. | `PASS` |
| `PROD-GATE-RECEIPT-1` | Server issues a signed `gate_decision` receipt and CLI verifies signature plus binding fields. | `PASS` |
| `PROD-LIFECYCLE-CONSUMPTION-1` | TEST/DONE gate consumes the verified receipt ref and records strong evidence consumption. | `PASS` |
| `PROD-FAIL-CLOSED-1` | Tampered, stale, wrong-project, wrong-run, wrong-material, wrong-policy, revoked, fake, local, or contract-only receipts block. | `EXPECTED_BLOCK` |
| `PROD-NO-LOCAL-AUTHORITY-1` | `authority_status`, local transcripts, local receipts, handoff receipts, and host outputs cannot set production Authority facts. | `EXPECTED_BLOCK` |
| `PROD-SOAK-1` | Repeated suite execution over the configured soak window has zero false DONE and no P0/P1 safety regressions. | `PASS` |
| `PROD-MULTI-HOST-CERT-1` | Claude CLI and Codex CLI independently review the same anchors and agree no correctness blocker remains. | `PASS` |

No additional Layer 4 baselines are required for the first formal unlock unless
one of these IDs cannot mechanically prove its intended safety boundary.

`PROD-SOAK-1` must define its soak window before execution starts. If no
product-approved soak window is available, the suite status is:

```text
BLOCKED: missing soak policy
```

Do not silently replace soak with one local run.

## 8. Standard Execution Chain

Every `PROD-*` baseline must follow the same proof chain.

| Stage | Required output |
|---|---|
| Target freeze | HEAD, material hash, artifacts root, suite run id, and selected lower-layer proof refs. |
| Authority readiness | Authority profile, policy discovery, server public key trust result, and production-capable classification. |
| Credential readiness | Redacted customer API key, actor key, runner id, and session id checks. |
| Job/run creation | Job id, run id, runner claim, heartbeat/session binding, and policy mode. |
| Evidence upload | Signed evidence envelope, accepted evidence digest, producer/verifier run ids, and material binding. |
| Gate evaluation | Gate input digest, server decision payload, and server-signed `gate_decision` receipt. |
| Receipt verification | CLI verification against trusted public key material and receipt proof bundle. |
| Gate consumption | Lifecycle gate consumes the verified receipt ref and records the exact consumed fact. |
| Negative controls | Missing, stale, tampered, fake, local-only, wrong-run, wrong-material, and revoked paths block. |
| Host review | Claude CLI and Codex CLI review the same anchors and produce verdict artifacts. |
| Final report | Per-baseline `final-report.json` with outcome and binding fields. |
| Suite aggregation | Production Safety suite report covers every `PROD-*` baseline. |
| Claim evaluation | Only Layer 4 Production Safety claim may unlock. |

The execution chain must not skip directly from Authority readiness or a host
transcript to capability claim.

## 9. Evidence Contract

Every formal Layer 4 final report must include enough structure for mechanical
validation.

| Evidence field | Requirement |
|---|---|
| `baselineId` | Must match one of the required `PROD-*` IDs. |
| `suiteRunId` | Must be stable across the Layer 4 suite run. |
| `runId` | Must be unique for the baseline run. |
| `claimTarget` | Must equal `production-safety`. |
| `headHash` | Must match the selected target. |
| `materialHash` | Must match the selected target and consumed receipt refs. |
| `authorityUrl` | Must identify the Authority service without leaking credentials. |
| `serverKeyId` | Must match trusted public key material. |
| `customerKeyRef` | Must be redacted and non-secret. |
| `authorityActorId` | Must match the signed actor identity or approved equivalent. |
| `runnerId` | Must match the runner that claimed the job. |
| `authoritySessionId` | Must match runner heartbeat, job claim, evidence, and receipt diagnostics. |
| `jobId` | Must bind the Authority job. |
| `producerRunIds` | Must identify producer run evidence. |
| `verifierRunIds` | Must identify independent verifier run evidence where policy requires it. |
| `evidenceDigests` | Must match accepted Authority evidence. |
| `receiptRefs` | Must include verified production `gate_decision` receipt refs when required. |
| `gateEvidenceRefs` | Must show lifecycle gate consumption of the receipt ref. |
| `negativeControlRefs` | Must show fail-closed controls for the baseline. |
| `reviewEvidenceRefs` | Must include independent Claude CLI and Codex CLI verdict artifacts when required. |
| `verifiedAt` | Must be inside the accepted freshness window. |
| `falseDone` | Must be `false`. |
| `localOnly` | Must be `false` for formal unlock proof. |
| `capabilityProof` | Must be `true` only after receipt verification and gate consumption pass. |

### 9.1 B-3a80 customerKeyRef Scope Note

`customerKeyRef` remains a future Layer 4 evidence requirement. In the B-3a80
`gap_analyze` triage context, the uncovered `customerKeyRef` row is classified
as future/blocked unless a separate Layer 4 implementation story is opened.

That separate implementation story must define the producer, loader, redaction
contract, verifier, evaluator consumption, negative controls, and tests before
any CLI, report, receipt, or claim evaluator may treat `customerKeyRef` as
current implemented support.

This note preserves the future Layer 4 requirement. It does not remove the
field, weaken the redaction rule, implement `customerKeyRef`, set
`receiptVerified=true`, set `productionDone=true`, or unlock Layer 4 Production
Safety.

Missing, stale, mismatched, local-only, or unverifiable evidence must produce:

```text
BLOCKED
```

It must not produce:

```text
PASS
```

## 10. Authority Receipt Rules

Layer 4 production safety depends on a narrow Authority boundary.

| Rule | Required behavior |
|---|---|
| Server-signed receipt only | Only a server-signed `gate_decision` receipt verified against trusted key material can produce production Authority facts. |
| Customer key is not Authority | A valid customer API key authorizes access; it does not itself prove completion. |
| Host is not Authority | Claude CLI, Codex CLI, Gemini, CI, Mac Runner, and humans can execute or review, but none is the Authority by brand. |
| Receipt kind | Gate consumption requires `kind=gate_decision` and subject kind `gate_decision`. |
| Target binding | Receipt must bind story or gate target, head hash, material hash, evidence digests, policy, and run/session metadata. |
| Freshness | Stale receipt refs, stale evidence, stale host verdicts, or old material hash block. |
| Revocation/supersession | Revoked, superseded, or policy-incompatible receipts block. |
| Fake/contract-only | Fake server, local contract server, handoff receipt, accepted transport response, or local text receipt cannot set `receiptVerified=true`. |
| Idempotency | Re-consuming the same valid receipt for the same gate context is idempotent. Reusing it for a different gate, material hash, run, or claim target blocks. |

Required live acceptance transcript shape:

```text
Authority readiness: PASS
Authority job: PASS jobId=<id> runId=<id>
Authority evidence: PASS evidenceDigest=<sha256>
Authority gate decision: PASS receiptVerified=true receiptId=<id>
Gate consumption: PASS strongEvidenceConsumed=true story=<storyId> gate=<TEST|DONE>
```

Until a real Authority Server and runner produce a verified receipt, the chain
must remain:

```text
contract-only
```

## 11. Fail-Closed Matrix

The suite must prove these negative controls.

| Scenario | Required result |
|---|---|
| Authority URL missing | `BLOCKED: missing Authority URL` |
| Server key untrusted | `BLOCKED: untrusted Authority key` |
| Customer API key missing | `BLOCKED: missing customer credential` |
| Customer API key invalid/revoked/expired | `BLOCKED: customer authorization failed` |
| Actor signature missing or invalid | `BLOCKED: actor signature failed` |
| Runner session missing or stale | `BLOCKED: runner session invalid` |
| Evidence upload accepted without material binding | `BLOCKED: weak evidence binding` |
| Receipt signature tampered | `BLOCKED: receipt signature invalid` |
| Receipt proof route unavailable | `BLOCKED: missing receipt proof` |
| Receipt target phase mismatch | `BLOCKED: receipt gate mismatch` |
| Receipt story/project/run mismatch | `BLOCKED: receipt binding mismatch` |
| Receipt material hash mismatch | `BLOCKED: stale material proof` |
| Receipt is fake/local/contract-only | `BLOCKED: non-production receipt` |
| Host verdict anchors differ | `BLOCKED: review anchor mismatch` |
| Host verdict stale after repair | `BLOCKED: stale host verdict` |
| Lower-layer proof stale | `LOCKED: stale lower-layer proof` |
| Global claim unlock attempted | `BLOCKED: claim boundary violation` |

Any implementation that returns PASS for one of these controls has a real
correctness issue and must be fixed before unlock.

## 12. Formal Evaluator Requirements

Layer 4 requires a formal evaluator or evaluator mode that consumes the suite
artifacts and authorizes only the Production Safety claim.

Expected evaluator output:

```json
{
  "claimTarget": "production-safety",
  "layer4ProductionSafetyClaim": "UNLOCKED",
  "layer5CapabilityClaim": "LOCKED",
  "fullAuthorityDone": false,
  "globalCapabilityClaim": "LOCKED"
}
```

The evaluator must independently rebuild the suite from per-baseline
`final-report.json` files. It must not trust a hand-written suite summary.

Evaluator checks:

- all required `PROD-*` baseline ids are covered;
- no required baseline is skipped;
- expected-PASS baselines are true PASS;
- expected-block baselines have structured block evidence;
- lower-layer proof refs are fresh and match the selected target;
- receipt refs bind `baselineId`, `suiteRunId`, and `claimTarget`;
- receipt refs are verified against trusted Authority key material;
- gate consumption evidence exists where required;
- negative controls are present and fail closed;
- host verdicts inspect the same anchors;
- stale, mismatched, local-only, fake, contract-only, or missing proof blocks;
- Layer 5 and global claims remain locked.

If the evaluator command does not exist yet, the first implementation step for
Layer 4 is to add the minimum formal evaluator path. That is a prerequisite for
running this suite, not an optional improvement.

## 13. Multi-Host Review Rule

Layer 4 requires independent host review because production safety cannot be
self-certified by one execution host.

Minimum for Layer 4 unlock:

```text
one Claude CLI host verdict + one Codex CLI host verdict over the same artifacts
```

Each host verdict must include:

- host name and version or source marker;
- artifact root;
- suite run id;
- head hash;
- material hash;
- receipt ids or receipt ref digests reviewed;
- negative controls reviewed;
- verdict;
- blocker list;
- prompt digest containing the four governing principles.

If a material repair happens after host review, both host verdicts become stale
and must be rerun.

Stronger final certification:

```text
fullAuthorityDone requires the final certification wave policy from M16.
```

Layer 4 unlock may prove Production Safety without setting `fullAuthorityDone`
when the final wave policy has not been completed.

## 14. Execution Plan

### Phase 0. Freeze Target And Scope

Actions:

1. Select target branch, HEAD, material hash, artifact root, and suite run id.
2. Confirm no material-producing session is still running against the same
   target.
3. Confirm this plan is the only Layer 4 unlock scope.
4. Confirm `.lattice` is the only formal artifact root.

Success criteria:

```text
target frozen
artifact root selected
scope locked to Layer 4 Production Safety
```

### Phase 1. Refresh Lower-Layer Proof

Actions:

1. Refresh or ingest Layer 1 Development proof for the selected target.
2. Refresh or ingest Layer 2 Engineering proof for the selected target.
3. Refresh or ingest Layer 3 Loop Engineering proof for the selected target.
4. Run the lower-layer formal evaluators.

Success criteria:

```text
Layer 1 proof fresh
Layer 2 Engineering claim UNLOCKED
Layer 3 Loop Engineering claim UNLOCKED
```

Stop condition:

```text
LOCKED: stale lower-layer proof
```

### Phase 2. Build Or Verify Layer 4 Formal Path

Actions:

1. Confirm a production-safety formal evaluator exists.
2. Confirm it rebuilds the suite from final reports.
3. Confirm it cannot unlock Layer 5 or global claim.
4. Add only the missing minimum formal path if it does not exist.

Success criteria:

```text
formal evaluator can return layer4ProductionSafetyClaim=UNLOCKED only from valid proof
higher-layer claims remain LOCKED
```

### Phase 3. Authority Readiness

Actions:

1. Load the approved Authority environment without committing secrets.
2. Discover Authority policy.
3. Verify server public key trust.
4. Register or validate actor key, runner id, and runner session.
5. Confirm service is not fake or contract-only for this run.

Success criteria:

```text
Authority readiness PASS
server key trusted
customer/actor/runner/session ready
```

### Phase 4. Run Positive Production Baselines

Actions:

1. Run `PROD-AUTH-LIVE-1`.
2. Run `PROD-CUSTOMER-KEY-1`.
3. Run `PROD-ACTOR-RUNNER-SESSION-1`.
4. Run `PROD-EVIDENCE-BINDING-1`.
5. Run `PROD-GATE-RECEIPT-1`.
6. Run `PROD-LIFECYCLE-CONSUMPTION-1`.

Success criteria:

```text
all expected-PASS baselines produce formal final-report.json
localOnly=false
capabilityProof=true
falseDone=false
```

### Phase 5. Run Negative Controls

Actions:

1. Run `PROD-FAIL-CLOSED-1`.
2. Run `PROD-NO-LOCAL-AUTHORITY-1`.
3. Verify stale, tampered, wrong-material, wrong-run, fake, local-only, and
   missing receipt controls.
4. Verify host verdict staleness after material change.

Success criteria:

```text
expected-block baselines block with structured evidence
no negative control returns PASS
```

### Phase 6. Run Soak Baseline

Actions:

1. Freeze the product-approved soak policy.
2. Run the suite over the configured N days or N repetitions.
3. Track false DONE, P0/P1 safety findings, flaky Authority failures, and stale
   proof escapes.

Success criteria:

```text
PROD-SOAK-1 PASS
zero false DONE
zero P0/P1 safety regression
```

Stop condition:

```text
BLOCKED: missing soak policy
```

### Phase 7. Run Multi-Host Review

Actions:

1. Send the frozen artifact root to Claude CLI.
2. Send the same frozen artifact root to Codex CLI.
3. Require both hosts to review the same suite run id, head hash, material hash,
   receipt refs, and negative controls.
4. Re-run both reviews after any material repair.

Success criteria:

```text
Claude CLI verdict PASS
Codex CLI verdict PASS
same anchors
no high/critical correctness blocker
```

### Phase 8. Aggregate Suite

Actions:

1. Build `production-safety-baseline-suite-report.json` from per-baseline
   reports.
2. Rebuild the suite independently inside the formal evaluator.
3. Compare stored suite summary to rebuilt evidence.

Success criteria:

```text
productionSafetyBaseline=PASS
covered=10
missing=0
stored summary matches rebuilt evidence
```

### Phase 9. Evaluate Claim Boundary

Actions:

1. Run the formal evaluator for `production-safety`.
2. Confirm Layer 4 unlock result.
3. Confirm Layer 5, global claim, and fullAuthorityDone remain locked unless
   separately proven.
4. Run fail-closed evaluator tests by removing or mutating required evidence.

Success criteria:

```text
layer4ProductionSafetyClaim=UNLOCKED
layer5CapabilityClaim=LOCKED
globalCapabilityClaim=LOCKED
fullAuthorityDone=false unless final certification policy is satisfied
```

### Phase 10. Write Delivery Summary

Actions:

1. Write a human-readable delivery summary.
2. Include artifact root, suite run id, target HEAD/material hash, Authority URL
   classification, receipt ids or redacted refs, host verdict refs, and claim
   boundary.
3. State exactly what is unlocked and what remains locked.

Success criteria:

```text
summary states only Layer 4 Production Safety is unlocked
summary does not claim global capability or arbitrary production unattended development
```

## 15. Parallel Execution Rules

Implementation may proceed in parallel. Capability proof and claim unlock must
remain sequential.

Allowed parallel tracks:

| Track | Scope | Can run in parallel? |
|---|---|---:|
| Authority client/readiness | Profile loading, policy discovery, key trust, receipt verification primitives. | Yes |
| Evidence and receipt artifacts | Evidence envelope, receipt proof, receipt ref projection. | Yes |
| Gate consumption | TEST/DONE receipt-ref gate consumption and stale diagnostics. | Yes, after receipt schema freeze |
| Negative controls | Tamper/stale/fake/local-only tests. | Yes |
| Formal evaluator | Suite rebuild, claim boundary, fail-closed checks. | Yes, after artifact schema freeze |
| Host review ingestion | Verdict schema, anchor binding, stale review detection. | Yes |

Shared contracts that must be frozen before parallel work:

- artifact root;
- suite run id format;
- baseline id set;
- `final-report.json` schema;
- receipt ref schema;
- evidence digest format;
- host verdict schema;
- claim target names.

Stop parallel execution when:

- two tracks need to change the same schema differently;
- a track tries to unlock a claim before lower-layer proof is fresh;
- a track treats a local diagnostic as production Authority evidence;
- a track wants to broaden scope without a real correctness issue.

## 16. DONE Criteria

Layer 4 Production Safety unlock is complete only when all are true:

1. Fresh Layer 1, Layer 2, and Layer 3 proof is bound to the selected target.
2. The Authority service is real for the run and not fake or contract-only.
3. Customer API key failure modes are proven fail-closed.
4. Actor signature, runner id, and runner session binding are proven.
5. Evidence upload binds story/job/run/head/material/digest.
6. Server-signed `gate_decision` receipt verification passes.
7. Lifecycle gate consumes verified receipt refs.
8. Stale, tampered, wrong-run, wrong-material, fake, local-only, and missing
   receipt paths block.
9. `PROD-SOAK-1` passes with the configured soak policy.
10. Claude CLI and Codex CLI review the same anchors and pass.
11. Formal evaluator rebuilds the suite and returns Layer 4 unlocked.
12. Layer 5, global Capability Claim, and fullAuthorityDone remain locked unless
    separately proven.
13. Delivery summary states the exact allowed claim and remaining locked claims.

## 17. Explicit Non-Goals

- Do not redesign the Authority Server.
- Do not build a generic SaaS admin console.
- Do not add a new product theory layer.
- Do not broaden this unlock to arbitrary production unattended development.
- Do not replace signed Authority receipts with host transcripts.
- Do not treat local CI as Authority unless it produces or consumes the same
  verified receipt chain.
- Do not skip the soak policy by running one local smoke.
- Do not unlock global Capability Claim from Layer 4 proof alone.

## 18. Final Claim Template

Use this wording only after the formal evaluator and host reviews pass:

```text
Layer 4 Production Safety Baseline is unlocked for the tested
Authority-backed task classes.

Evidence:
- Layer 1/2/3 proofs are fresh for <headHash>/<materialHash>.
- Production Safety suite <suiteRunId> covers all 10 PROD-* baselines.
- Verified Authority gate_decision receipts were consumed by lifecycle gates.
- Negative controls fail closed.
- Soak policy passed with zero false DONE.
- Claude CLI and Codex CLI reviewed the same anchors and passed.

Still locked:
- Layer 5 global Capability Claim.
- arbitrary production unattended development.
- fullAuthorityDone unless final certification policy is separately satisfied.
```

If any required evidence is missing, stale, or mismatched, use:

```text
Layer 4 Production Safety Baseline remains LOCKED.
```
