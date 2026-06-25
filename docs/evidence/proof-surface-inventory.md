# Proof Surface Inventory

Status: B-0985 M0/M1 classification-only inventory.
Date: 2026-06-24.
Scope: proof-looking Evidence Runtime, lifecycle, review, handoff, and Authority surfaces.

This inventory records the current proof-looking surfaces before any hard gate
integration. It does not create a new storage root and does not make a
non-Authority artifact admissible for production completion.

Machine-readable mirror: `docs/evidence/proof-surface-inventory.json`.
Shared registry implementation: `packages/main/src/core/proof-admissibility.ts`.

## Canonical Scope Rule

Only `production-gate-decision` can be eligible for a production completion
claim, and only when the artifact consumer and claim match the policy being
evaluated. `authority-receipt` is evidence input. It is not a production claim
until it has been consumed by the matching gate decision path.

| Scope | productionDone allowed? | Boundary |
|---|---:|---|
| `audit-note` | No | Human-readable context only. |
| `legacy-observed` | No | Historical readable evidence missing the current contract. |
| `legacy-local-only` | No | Old local evidence with local-only trust. |
| `legacy-unknown-producer` | No | Old evidence with unknown producer boundary. |
| `evidence-candidate` | No | Intake/planning candidate evidence. |
| `local-diagnostic` | No | Local/shadow/diagnostic runtime evidence. |
| `local-key-single-host` | No | Offline local key bundle from one host. |
| `local-gate-evidence` | No | Strong local lifecycle readiness evidence, not production authority. |
| `local-review-quorum` | No | Local review escalation evidence only. |
| `authority-receipt` | No | Verified receipt input, not a gate-consumed decision. |
| `production-gate-decision` | Yes, policy-matching only | Matching gate-consumed decision evidence. |

## Inventory

| Surface | Artifact kind | Scope | Producer boundary | Consumers | Allowed claims | productionDone | Status | Why not stronger |
|---|---|---|---|---|---|---:|---|---|
| DONE-required evidence | `done-required-evidence` | `local-gate-evidence` | `local-runtime-owned` | `DONE_REQUIRED`, `DONE` | `done-readiness` | No | strong local gate evidence | It can satisfy local DONE readiness policy but is not an Authority production completion claim. |
| Delivery check / final report | `delivery-check` | `local-diagnostic` | `local-runtime-owned` | `REVIEW`, `TEST`, `DONE` | `done-readiness` | No | needs scope label | Local report text can guide review but cannot establish production authority. |
| Review runs / review passes / findings | `review-run` | `local-review-quorum` | `trusted-reviewer-owned` | `REVIEW` | `review-pass` | No | strong local review evidence | It satisfies local review escalation only, not production completion. |
| Authority receipt refs | `authority-receipt-ref` | `production-gate-decision` | `authority-owned` | `AUTHORITY_GATE_DECISION`, `TEST`, `DONE` | `production-completion`, `done-readiness` | Yes, only for matching production claim | strong-proof-ready | This is the only current production completion eligible surface when all bindings match. |
| Raw Authority receipt | `authority-receipt` | `authority-receipt` | `authority-owned` | `AUTHORITY_GATE_DECISION` | `diagnostic-status` | No | needs consumer decision | A receipt is input evidence; the gate decision/ref establishes whether it is consumable. |
| Offline receipt bundle | `offline-receipt-bundle` | `local-key-single-host` | `local-runtime-owned` | `REVIEW`, `TEST`, `DONE` | `diagnostic-status` | No | must remain diagnostic | Single-host local key evidence is not Authority-owned. |
| Handoff pack / receipt / dispatch report / host verdict | `handoff-pack` | `local-diagnostic` | `local-runtime-owned` | `HANDOFF`, `PLAN`, `REVIEW` | `handoff-context`, `diagnostic-status` | No | must remain diagnostic | Handoff transfers context and candidates; worker output does not complete production. |
| Usage-ledger Authority evidence | `usage-ledger-authority-evidence` | `local-diagnostic` | `local-runtime-owned` | `REVIEW`, `TEST` | `diagnostic-status` | No | must remain diagnostic | Privacy-preserving local evidence is not a gate-consumed Authority decision. |
| Repro probe from B-0aa1 | `repro-probe` | `evidence-candidate` | `caller-writable` | `STORY_INTAKE`, `PLAN` | `historical-failure` | No | candidate-only | It records a historical/problem observation, not current verification. |
| Repro review from B-0aa1 | `repro-review` | `evidence-candidate` | `trusted-reviewer-owned` | `STORY_INTAKE`, `PLAN` | `historical-failure` | No | candidate-only | It validates intake framing, not story completion. |
| Spike record from B-0aa1 | `spike-record` | `evidence-candidate` | `caller-writable` | `STORY_INTAKE`, `PLAN` | `historical-failure` | No | candidate-only | It is disposable exploration and may contain bootstrap/environment noise. |
| Spike review from B-0aa1 | `spike-review` | `evidence-candidate` | `trusted-reviewer-owned` | `STORY_INTAKE`, `PLAN` | `historical-failure` | No | candidate-only | It supports planning confidence only. |
| Red/green relation | `red-green-relation` | `evidence-candidate` | `local-runtime-owned` | `STORY_INTAKE`, `PLAN` | `red-green-equivalence` | No | candidate-only | It links baseline/current command intent for intake. |
| Red/green relation evaluation | `red-green-relation-evaluation` (alias `red-green-evaluation`) | `evidence-candidate` | `local-runtime-owned` | `STORY_INTAKE`, `PLAN` | `red-green-equivalence` | No | candidate-only | It records the evaluator-derived relation outcome before planning handoff. |
| Regression matrix review | `regression-matrix-review` | `evidence-candidate` | `trusted-reviewer-owned` | `STORY_INTAKE`, `PLAN` | `red-green-equivalence` | No | candidate-only | It reviews coverage intent before gate-consumed verification exists. |
| Story evidence binding | `story-evidence-binding` | `evidence-candidate` | `local-runtime-owned` | `STORY_INTAKE`, `PLAN` | `handoff-context` | No | candidate-only | It links candidate artifacts to a story without creating `verificationEvidence`. |
| Legacy observed evidence | `legacy-evidence` | `legacy-observed` | `legacy-unknown` | `PLAN`, `REVIEW` | `diagnostic-status` | No | legacy-only | Missing current schema, producer, digest, signature, or material contract. |

## Negative Controls

- `evidence-candidate` artifacts can inform intake and planning only.
- `local-diagnostic` artifacts can explain status but cannot set
  `productionDone`, even if they contain `accepted=true`.
- `local-key-single-host` artifacts are local/offline evidence and cannot be
  promoted to Authority proof.
- `local-gate-evidence` artifacts can satisfy their local lifecycle readiness
  claim but cannot satisfy `production-completion`.
- `local-review-quorum` can satisfy local review escalation only.
- `legacy-observed` artifacts remain audit-readable but are not strong proof.
- `authority-receipt` must not be confused with `production-gate-decision`.
- `production-gate-decision` is admissible only for a matching consumer and
  claim, with current schema, shape, digest, receipt/signature, subject, and
  temporal/material bindings.

## Producer Boundary Notes

`caller-writable` surfaces are never trusted for completion claims. `local-runtime-owned`
surfaces can be useful current-state or diagnostic evidence but are not
Authority-owned. `trusted-reviewer-owned` surfaces can satisfy local REVIEW
policies. `authority-owned` surfaces can become production eligible only after
the matching gate decision/ref path has classified and consumed them.
