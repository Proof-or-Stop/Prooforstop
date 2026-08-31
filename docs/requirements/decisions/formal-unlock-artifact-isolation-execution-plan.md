# Formal Unlock Artifact Isolation Execution Plan

> Status: implemented (B-9d6c)
> Scope: Layer 2 Engineering, Layer 3 Loop Engineering
> Non-goal: Layer 4 Production Safety unlock, Authority receipt verification, converting host verdicts into Authority evidence

## 1. Purpose

This document describes the formal proof-root invariant guard implemented for
Layer 2 Engineering and Layer 3 Loop Engineering baseline suite aggregation.

The invariant prevents stale, mixed, local-only, wrong-target, or
authority-overclaim final-report artifacts from polluting a formal unlock proof
root.

## 2. Governing Principles

All changes in B-9d6c follow these four principles:

```text
Do not optimize for the sake of optimization.
Do not optimize arbitrarily.
Only fix real correctness issues.
Preserve consistency of logic.
```

The invariant exists because mixed or stale artifacts in a formal proof root are
a real correctness issue: they can produce a false PASS suite report.

## 3. Root Invariant

The root invariant is applied during formal baseline suite aggregation for
`engineering` and `loop-engineering` layers. It inspects every parsed
`final-report.json` inside the selected layer root, not only reports that match
accepted baselines.

A formal suite aggregation is BLOCKED when any parsed final report in the
selected root violates any of the following conditions:

| Condition | Required value | Violation meaning |
|---|---|---|
| `layer` | Must match the expected layer (`engineering` or `loop-engineering`) | Mixed-layer artifact in the root |
| `materialHash` | Must match the current material hash | Stale evidence state |
| `suiteRunId` | Must be present and identical across all reports in the root | Mixed or missing suite run identity |
| `claimTarget` | Must match the expected claim target (`engineering` or `loop-engineering`) | Wrong proof target |
| `localOnly` | Must be `false` | Local-only artifact posture |
| `capabilityProof` | Must be `true` | Non-proof artifact in proof root |
| `formalProof` | Must be `true` | Non-formal artifact in formal root |
| `falseDone` | Must be `false` | False DONE artifact |
| `authority.authorityDone` | Must be `false` for Layer 2/3 CLI proof | Authority overclaim |
| `authority.receiptVerified` | Must be `false` for Layer 2/3 CLI proof | Authority overclaim |
| `authority.productionDone` | Must be `false` for Layer 2/3 CLI proof | Authority overclaim |
| `authority.fullAuthorityDone` | Must be `false` for Layer 2/3 CLI proof | Authority overclaim |

`headHash` remains a source binding on generated final reports and suite
reports, but it is not a current-HEAD root invariant. Formal proof artifacts may
be generated against a source HEAD and then committed as artifact material,
which legitimately changes git HEAD while preserving the same proof material
hash. The mechanical stale gate therefore uses `materialHash` plus stored-vs-
rebuilt accepted report bindings for this story.

When the invariant blocks, the suite report emits explicit blocked reasons
naming the specific field and mismatch (e.g. `suiteRunId`, `claimTarget`,
`materialHash`, `localOnly`) so that auditors can distinguish failure modes.

## 4. Stale-Trap Negative Root Separation

Stale-trap and negative-control artifacts (mixed `suiteRunId`, wrong
`claimTarget`, `localOnly=true`, Authority overclaim posture) must not exist
inside the selected formal PASS root. They belong in a separate negative-check
root used only by smoke tests and negative coverage.

The separation is:

| Root | Purpose | Contents |
|---|---|---|
| Selected formal PASS root (e.g. `.proof-or-stop/artifacts/baseline/layer2-engineering-unlock`) | Formal proof aggregation | Only clean, current-run, single-`suiteRunId`, correct-`claimTarget` final reports |
| Negative-check root (smoke test fixtures) | Prove fail-closed behavior | Stale `materialHash`, mixed `suiteRunId`, wrong `claimTarget`, `localOnly=true`, Authority overclaim artifacts |

The root invariant scans only the selected formal PASS root. Negative-check
artifacts outside that root do not pollute formal suite aggregation. Historical
audit artifacts from previous runs also do not pollute the current formal root
as long as they are not placed inside the selected root directory.

## 5. Layer 4 Production Safety Boundary

Layer 4 Production Safety remains a precondition-only consumer of the artifact
isolation invariant. The invariant implemented in B-9d6c does not unlock
Production Safety and does not enable any Production Safety claims.

Layer 4 unlock requires capabilities that do not exist in this story:

| Missing capability | Why it matters |
|---|---|
| Production-safety evaluator | A formal evaluator that can authorize `production-safety` claims does not exist. The current `capability_claim_evaluate` is L0/read-only diagnostic for Layer 2/3 only. |
| Authority proof chain | Production Safety requires real Authority Server receipts (`receiptVerified=true`, `productionDone=true`). Proof-or-Stop CLI cannot produce these. |
| Soak evidence | Production Safety baselines require `soak-summary.json` and `recovery-log.jsonl` from real sustained operation. |
| Multi-host authority verification | Production Safety requires verified independent multi-host proof, not just independent review verdicts. |

Until a production-safety evaluator and Authority-backed proof chain exist,
Layer 4 may only consume the artifact isolation invariant as a precondition
check. It cannot use the invariant to claim production readiness.

The formal claim boundary after B-9d6c:

```text
Layer 2 Engineering Baseline    = can be formally unlocked (invariant guard active)
Layer 3 Loop Engineering        = can be formally unlocked (invariant guard active)
Layer 4 Production Safety       = LOCKED (no evaluator, no Authority proof chain)
Layer 5 / global Capability     = LOCKED (requires all lower layers)
```

## 6. What This Invariant Does Not Do

- Does not verify Authority Server receipts. Proof-or-Stop CLI remains non-authority.
- Does not convert Claude or Codex host verdicts into Authority evidence.
- Does not implement `reportFiles` or `reportRoot` selection API.
- Does not add new capability layers or broader runner rewrites.
- Does not downgrade a blocked suite into PASS for momentum.
- Does not treat local diagnostic artifacts as formal proof.

## 7. Implementation Location

The root invariant guard lives in `packages/main/src/core/proof-or-stop-baseline.ts`
inside the existing suite aggregation path. Negative coverage lives in
`packages/main/src/tasks/proof-or-stop-baseline-smoke.ts`.

## 8. Relation to Existing Decision Documents

This execution plan implements a subset of the proof-root hygiene described in:

- `unlock-layer2-ENG-suite.md` (Section 7: Evidence Contract, Section 10: Fail-Closed Rules)
- `unlock-layer3-loop-engineering-suite.md` (Section 8: Evidence Contract, Section 12: Fail-Closed Rules)

Those documents define the full formal unlock criteria. This document narrows
scope to the artifact isolation invariant guard that mechanically enforces
proof-root cleanliness during suite aggregation.
