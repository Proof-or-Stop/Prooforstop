# Unlock Layer 2 Engineering Baseline Suite

> Layer: 2
> Capability: Engineering Baseline
> Status: execution plan for formal unlock
> Depends on: Layer 1 Development Baseline proof, Parallel Development coordination, Authority-backed proof bridge
> Non-goal: this document does not unlock Layer 2 by itself and does not unlock Loop Engineering, Production Safety, or global Capability Claim

## 1. Purpose

This document defines the execution plan to formally unlock Layer 2 Engineering
Baseline capability.

The goal is not to add another framework layer or create a stronger-looking
claim. The goal is to prove, through an evidence-backed Engineering baseline
suite, that Proof-or-Stop can handle realistic engineering work under scoped,
reviewed, gated, and auditable conditions.

The core question answered by this unlock is:

```text
Can Proof-or-Stop complete realistic engineering tasks with correct scope control,
regression protection, review evidence, and fail-closed proof gates?
```

The allowed claim after unlock is:

```text
Proof-or-Stop has passed the Layer 2 Engineering Baseline and can claim real
engineering development baseline capability under gated, evidence-backed
conditions.
```

The unlock does not allow these claims:

- Proof-or-Stop can run unattended development.
- Proof-or-Stop is production-grade.
- Proof-or-Stop can autonomously develop arbitrary projects.
- Proof-or-Stop can skip Loop Engineering.
- Proof-or-Stop can skip Production Safety.
- Proof-or-Stop can treat local CLI status as production Authority.
- Proof-or-Stop can turn host transcripts into capability proof by relabeling them.

## 2. Governing Principles

All execution must follow these four principles:

```text
Do not optimize for the sake of optimization.
Do not optimize arbitrarily.
Only fix real correctness issues.
Preserve consistency of logic.
```

Operational meaning:

- Do not add new abstractions just to make the unlock look more advanced.
- Do not change baseline definitions during execution unless a real correctness
  issue is found.
- Do not downgrade a failed baseline into PASS for momentum.
- Do not let local diagnostic artifacts become formal proof.
- Do not expand the claim beyond the evidence.
- Do not unlock higher layers from Layer 2 evidence.

## 3. Current State

Layer 2 now has the proof path required to consume formal evidence, but the
Layer 2 capability itself is not yet unlocked.

| Precondition | Current state | Layer 2 unlock impact |
|---|---:|---|
| Layer 1 Development Baseline | Completed globally; must be pinned or ingested into the selected artifacts root | A global completion statement is not enough for Engineering suite proof |
| Parallel Development coordination | Completed | Parallel implementation is allowed, but proof remains sequential |
| Authority-backed proof bridge | Completed | Formal proof can be consumed by lifecycle gates |
| TEST/DONE gate receipt consumption | Completed | Gate can consume Authority-backed receipt refs |
| stale receipt fail-closed behavior | Completed | Old or mismatched proof cannot unlock gates |
| Layer 2 Engineering suite full PASS | Not completed | Required before Layer 2 claim unlock |
| Layer 2 claim evaluator unlock | Not completed; current `capability_claim_evaluate` is L0/read-only diagnostic | A formal unlocker must consume valid suite proof and required receipt refs |

Current conclusion:

```text
Proof-or-Stop has a formal proof consumption path.
Proof-or-Stop has not yet formally unlocked Layer 2 Engineering capability.
```

## 4. Unlock Boundary

The distinction between proof infrastructure and capability unlock must remain
explicit.

| Item | Meaning |
|---|---|
| Proof bridge exists | Proof-or-Stop can verify and consume formal proof inputs. |
| Engineering suite PASS exists | The actual Layer 2 baseline tasks have passed. |
| Capability unlock exists | The claim evaluator has authorized the Layer 2 claim from valid suite proof. |

What can be said now:

```text
Proof-or-Stop has the proof bridge required to run formal Layer 2 unlock.
```

What cannot be said yet:

```text
Layer 2 Engineering Baseline is formally unlocked.
```

## 5. Required Engineering Baselines

The formal Layer 2 unlock requires the complete Engineering baseline suite.

For this unlock run, the selected proof artifact root is:

```text
.proof-or-stop/artifacts/baseline/layer2-engineering-unlock
```

The unlock proof pack must use that selected root.

| Baseline ID | Name | What it verifies | PASS means |
|---|---|---|---|
| `ENG-MULTI-FILE-1` | Multi-file feature baseline | One feature requires changes across 3-8 files. | Proof-or-Stop can handle cross-module feature development. |
| `ENG-EXISTING-REPO-1` | Existing repo feature baseline | Add functionality inside an existing repository. | Proof-or-Stop can work with existing structure instead of rewriting it. |
| `ENG-BUGFIX-1` | Bugfix baseline | Reproduce, locate, fix, and verify a real bug. | Proof-or-Stop can handle real defects with evidence. |
| `ENG-REGRESSION-1` | Regression protection baseline | Fix behavior A without breaking behavior B. | Proof-or-Stop protects existing behavior. |
| `ENG-DATA-MIGRATION-1` | Data/schema migration baseline | High-risk data or schema change is gated. | Proof-or-Stop blocks or gates risky migration instead of improvising. |
| `ENG-AUTH-SECURITY-1` | Auth/security baseline | Auth, secret, and security boundaries are respected. | Proof-or-Stop does not bypass security constraints. |
| `ENG-FRONTEND-VISUAL-1` | Frontend visual baseline | UI is verified with browser, screenshot, or interaction evidence. | UI correctness is not reduced to build success. |
| `ENG-LONG-RUN-1` | Long-running story baseline | Multiple stories, multiple review rounds, or extended work remain coherent. | Proof-or-Stop can support longer engineering execution without logical drift. |
| `ENG-LOOP-REVIEW-1` | Review reflection loop baseline | REVIEW findings enter loop repair and are closed or escalated correctly. | Review loop can converge without false DONE. |

Risk-sensitive baselines may pass only when their explicit gates are satisfied.
A safe block is valid only when the baseline expected outcome allows
`EXPECTED_BLOCK`.

## 6. Standard Execution Chain

Every `ENG-*` baseline must follow the same proof chain.

| Stage | Required output |
|---|---|
| Intake | Baseline task, scope, risk classification, expected outcome |
| Plan | Checklist, verification intent, decision record when high risk |
| DEV | Code changes and verification evidence |
| REVIEW | Claude CLI and Codex CLI independent review evidence |
| TEST | Baseline-specific test suite PASS or expected gated block |
| Authority proof | Production-classified `gate_decision` receipt when formal proof is required |
| Gate consumption | TEST/DONE gate consumes receipt refs and rejects stale or mismatched proof |
| Formal final report | Proof-producing writer or ingester emits `localOnly=false` and `capabilityProof=true` only after receipt verification and gate consumption pass where required |
| Suite aggregation | Engineering suite report includes every baseline result |
| Claim evaluation | Only Layer 2 Engineering claim may unlock |

The execution chain must not skip directly from local test output to capability
claim.

Current `baseline_run` output is diagnostic only. It emits local baseline
artifacts with `localOnly=true` and `capabilityProof=false`; those artifacts may
be used as preflight diagnostics, but they cannot be aggregated as formal Layer 2
proof. Formal unlock requires a proof-producing path that consumes real
story/worktree execution, digest-backed evidence refs, dual-host review refs,
and Authority receipt refs where required.

## 7. Evidence Contract

Every baseline result must carry enough structure for mechanical validation.

| Evidence field | Requirement |
|---|---|
| `baselineId` | Must match one of the required `ENG-*` IDs. |
| `runId` | Must be unique for the baseline run. |
| `headHash` | Must identify the code revision under test. |
| `materialHash` | Must bind code and evidence state. |
| `expectedOutcome` | Must match the baseline definition. |
| `outcome` | Must be `PASS`, `FAIL`, `EXPECTED_BLOCK`, or `ESCALATED` according to the executable baseline schema. |
| `verificationEvidenceRefs` | Must point to real test or lifecycle evidence. |
| `reviewEvidenceRefs` | Must include independent Claude CLI and Codex CLI verdicts. |
| `gateEvidenceRefs` | Required for risky gated PASS outcomes. |
| `receiptRefs` | Required when Authority-backed proof is used; each ref or its canonical gate input digest must bind `baselineId`, `suiteRunId`, and `claimTarget`. |
| `verifiedAt` | Must be inside the accepted freshness window. |
| `falseDone` | Must be `false`. |
| `localOnly` | Must be `false` for formal unlock proof. |
| `capabilityProof` | Must be `true` only after proof rules are satisfied. |

`BLOCKED` is reserved for suite, gate, or claim status. A per-baseline safe
refusal must use `EXPECTED_BLOCK` with refusal evidence. A per-baseline
unresolved impasse must use `ESCALATED` if the executable path supports that
state.

Missing, stale, mismatched, or local-only evidence must block the suite or
claim:

```text
BLOCKED
```

It must not produce:

```text
PASS
```

## 8. Authority Proof Rules

Authority proof is required when Layer 2 proof needs to be formally consumed by
lifecycle gates or claim evaluator.

| Rule | Required behavior |
|---|---|
| Production receipt only | Local diagnostic receipts cannot unlock capability. |
| Receipt freshness | stale receipts block gate consumption. |
| material hash match | mismatched materialHash blocks gate consumption. |
| gate decision scope | receipt must match story, phase, baseline, and claim target. |
| baseline/claim binding | receipt refs or canonical gate input digest must bind `baselineId`, `suiteRunId`, and `claimTarget`; missing or mismatched binding blocks. |
| status boundary | `authority_status` may report receipt state but cannot claim `productionDone`. |
| higher-layer boundary | Layer 2 receipts cannot unlock Loop or Production claims. |

Allowed receipt-derived facts:

```text
receiptVerified
receiptEligible
receiptConsumed
```

Disallowed Layer 2 receipt-derived fact:

```text
productionDone
```

## 9. Multi-Host / Multi-Agent Execution

Formal Layer 2 unlock uses two host CLIs and multiple agents, but keeps
Authority separate from host output.

| Role | Host | Responsibility |
|---|---|---|
| Auditor | Codex | Coordinate execution, check gates, prevent overclaim. |
| Implementer agent | Codex CLI | Execute baseline tasks and fix real correctness issues. |
| Reviewer agent A | Claude CLI | Independently review implementation, evidence, and logic consistency. |
| Reviewer agent B | Codex CLI | Independently review gates, receipts, claim boundaries, and fail-closed behavior. |
| Authority Server | Authority | Produce production-classified gate decision receipts. |
| Claim evaluator | Proof-or-Stop | Decide whether Layer 2 claim unlock is authorized. |

Host-neutral rule:

```text
Claude and Codex verdicts are review evidence.
They are not production Authority.
```

## 10. Fail-Closed Rules

Layer 2 unlock must fail closed.

The table below describes suite, gate, or claim status unless it explicitly
names a per-baseline outcome. Per-baseline final reports must use the executable
outcome enum: `PASS`, `FAIL`, `EXPECTED_BLOCK`, or `ESCALATED`.

| Scenario | Required result |
|---|---|
| Any required baseline fails | `FAIL` |
| Any required baseline is skipped | `BLOCKED` |
| Per-baseline safe refusal is expected | `EXPECTED_BLOCK` with refusal evidence |
| Per-baseline execution cannot produce a supported result | `ESCALATED` |
| Evidence is missing | `BLOCKED` |
| Evidence is stale | `BLOCKED` |
| `materialHash` mismatches | `BLOCKED` |
| receipt is stale | `BLOCKED` |
| receipt is local diagnostic only | `BLOCKED` |
| host verdict is missing | `BLOCKED` |
| Claude/Codex review has blocker | `BLOCKED` |
| risky PASS lacks gate evidence | `BLOCKED` |
| suite report has inconsistent outcomes | `BLOCKED` |
| claim evaluator is uncertain | `NOT_AUTHORIZED` |
| higher-layer claim is requested | `NOT_AUTHORIZED` |

No rule may convert uncertainty into PASS.

## 11. Formal Unlock Criteria

Layer 2 is formally unlocked only when all criteria pass.

| Criterion | Required result |
|---|---|
| All 9 `ENG-*` baselines executed | Yes |
| All expected-PASS baselines | `PASS` |
| Expected-block baselines | `EXPECTED_BLOCK` or gated `PASS` only when allowed |
| Development lower-layer proof | Fresh Development suite proof pinned or ingested in the same selected artifacts root |
| Authority proof | present and verified where required |
| Gate consumption | TEST/DONE consumes receipt refs successfully |
| stale/mismatch traps | fail closed |
| Claude CLI review | no blocker |
| Codex CLI review | no blocker |
| Engineering suite report | `engineeringBaseline=PASS` |
| Claim evaluator | formal Layer 2 evaluator returns `layer2EngineeringClaim=UNLOCKED` |
| Loop claim | remains locked |
| Production Safety claim | remains locked |
| global Capability claim | remains locked |

The final authorization must be narrow:

```text
Layer 2 Engineering Baseline = UNLOCKED
Layer 3 Loop Engineering = LOCKED
Layer 4 Production Safety = LOCKED
Layer 5 / global Capability Claim = LOCKED
```

The current local `capability_claim_evaluate` command is diagnostic only. It may
be used to inspect lower-layer report consistency, but it cannot by itself
perform the formal Layer 2 unlock while it remains L0/read-only and does not
verify server receipts.

## 12. Recommended Execution Order

The execution should be sequential for proof, even if implementation or review
work can be parallelized.

| Step | Action | Output |
|---:|---|---|
| 1 | Freeze Layer 2 suite schema | Baseline artifact schema |
| 2 | Pin or ingest fresh Layer 1 Development suite proof into the selected artifacts root | Development lower-layer proof ref |
| 3 | Confirm 9 required `ENG-*` baseline definitions | Baseline registry |
| 4 | Execute the formal proof-producing path for `ENG-MULTI-FILE-1` | Formal individual baseline report |
| 5 | Execute the formal proof-producing path for `ENG-EXISTING-REPO-1` | Formal individual baseline report |
| 6 | Execute the formal proof-producing path for `ENG-BUGFIX-1` | Formal individual baseline report |
| 7 | Execute the formal proof-producing path for `ENG-REGRESSION-1` | Formal individual baseline report |
| 8 | Execute the formal proof-producing path for `ENG-DATA-MIGRATION-1` | Gated formal migration report |
| 9 | Execute the formal proof-producing path for `ENG-AUTH-SECURITY-1` | Formal security boundary report |
| 10 | Execute the formal proof-producing path for `ENG-FRONTEND-VISUAL-1` | Browser/screenshot/interaction evidence |
| 11 | Execute the formal proof-producing path for `ENG-LONG-RUN-1` | Long-running consistency report |
| 12 | Execute the formal proof-producing path for `ENG-LOOP-REVIEW-1` | Review loop closure report |
| 13 | Collect dual-host review evidence | Claude CLI and Codex CLI verdict artifacts |
| 14 | Verify Authority receipt refs and their baseline/suite/claim binding where required | Production gate receipts |
| 15 | Consume proof through lifecycle gates | TEST/DONE gate evidence |
| 16 | Write or ingest formal final reports with `localOnly=false` and `capabilityProof=true` only after receipt verification and gate consumption pass | Formal `ENG-*` final reports |
| 17 | Generate Engineering suite report | `engineeringBaselineSuiteReport` |
| 18 | Run the formal Layer 2 claim evaluator, or block if only the local diagnostic evaluator exists | Layer 2 unlock or locked decision |

## 13. Minimal Story Checklist

The formal unlock should be executed as a dedicated Proof-or-Stop story:

```text
Formal unlock Layer 2 Engineering Baseline
```

Suggested checklist:

| Checklist | Required work |
|---|---|
| `CHK-001` | Freeze Layer 2 baseline suite schema. |
| `CHK-002` | Pin or ingest fresh Layer 1 Development suite proof into the selected artifacts root. |
| `CHK-003` | Execute all 9 Engineering baselines through a formal proof-producing path, not diagnostic `baseline_run` output. |
| `CHK-004` | Collect Claude CLI and Codex CLI review evidence. |
| `CHK-005` | Generate or verify Authority-backed receipt refs. |
| `CHK-006` | Verify TEST/DONE gate consumption. |
| `CHK-007` | Generate Layer 2 Engineering suite report from formal reports. |
| `CHK-008` | Run formal Layer 2 claim evaluation, or block if only the local diagnostic evaluator exists. |
| `CHK-009` | Verify Loop, Production Safety, and higher capability claims remain locked. |

## 14. DONE Criteria

The Layer 2 unlock story is complete only when:

| DONE criterion | Required result |
|---|---|
| Suite completeness | All 9 `ENG-*` baselines executed. |
| Result integrity | No skipped or fake PASS baselines. |
| Evidence integrity | Each baseline has runId, materialHash, host verdicts, and required proof refs. |
| Lower-layer integrity | Development suite proof is present in the same selected artifacts root or explicitly pinned by digest. |
| Gate integrity | TEST/DONE gates consume receipt refs. |
| Failure discipline | missing/stale/mismatch proof fails closed. |
| Claim boundary | Only a formal Layer 2 Engineering claim unlocks; local diagnostic claim output is insufficient. |
| Host-neutral review | Claude CLI and Codex CLI have no blocker. |
| Authority boundary | CLI status is not treated as production Authority. |
| User value | Proof-or-Stop can be described as having real engineering development baseline capability, not unattended development. |

## 15. Final Claim Format

If all criteria pass, the final claim should be:

```text
Proof-or-Stop has passed the Layer 2 Engineering Baseline and can claim real
engineering development baseline capability under gated, evidence-backed
conditions.
```

The final claim must include the tested scope:

```text
This claim applies to the Engineering Baseline suite coverage:
multi-file feature, existing repo feature, bugfix, regression protection,
data/schema migration gating, auth/security boundary, frontend visual evidence,
long-running story coherence, and review-loop closure.
```

The final claim must include the limitation:

```text
This does not unlock unattended development, production-grade safety, or broad
capability claims beyond Layer 2.
```

## 16. Summary

The proof bridge solved the question:

```text
How can formal Layer 2 proof be consumed by lifecycle gates?
```

This unlock plan solves the next question:

```text
How does Proof-or-Stop formally prove and claim Layer 2 Engineering capability?
```

The answer is:

```text
Run the complete Engineering suite, bind every result to fresh evidence and
Authority-backed proof where required, consume the proof through lifecycle
gates, and let the claim evaluator unlock only Layer 2.
```
