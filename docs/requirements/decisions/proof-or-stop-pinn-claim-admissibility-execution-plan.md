# Proof-or-Stop for PINNs: Cross-Domain Claim-Admissibility Execution Plan

Status: implementation-ready design draft
Scope: future-domain extension; not a delivered implementation
Created: 2026-06-27
Short name: Proof-or-Stop PINN Claim-Admissibility Pack

## Current implementation status

- This is a documented design package for a future-domain extension.
- No runtime module changes have been delivered in this story.
- Scope, vocabulary, benchmark design, and governance wording are now fixed as a future implementation contract.

## Purpose

This plan defines how `Proof-or-Stop` can be extended to PINN research workflows as a **claim-admissibility control layer**.

It is not a scientific claim engine.

The optimization is to prevent unsupported or stale PINN claims from advancing across lifecycle stages.

> Proof-or-Stop for PINNs does not prove PDE correctness or improve solver accuracy by itself.  
> It proves whether a PINN claim is admissible enough (with bound evidence) to advance.

## Problem Statement

Research teams often upgrade the strength of a claim from narrative evidence to
stronger claims before evidence is complete (training loss vs residual, or single
checklist success vs actual reproducibility). Proof-or-Stop already has strong
local controls, but this gap is especially visible in scientific domains where
claims are high-value and easy to overstate.

This plan introduces a domain pack so PINN lifecycle transitions are mechanically
bound to reproducible evidence, and unsupported claims are forced to repair,
degrade, or stop.

## Execution Boundary

What we do:

- add a formal PINN domain pack to existing `Proof-or-Stop` core controls;
- define admissibility identity for PINN artifacts (spec/training/config/checkpoint/grid/verifier/evidence bindings);
- define lifecycle gate predicates and failure behavior (`advance`, `repair`, `degrade`, `stop`);
- add a bounded benchmark for admissibility control quality.

What we do not do:

- claim that this proves PDE solutions mathematically;
- improve PINN model quality, architecture, optimization, or scientific validity;
- remove existing Proof-or-Stop gates, evidence requirements, or claim-boundary
  semantics;
- add uncontrolled API changes outside the PINN domain extension.

Stop conditions:

- if evidence binding is ambiguous (missing hash, script mismatch, or stale artifacts), transition must be blocked;
- if verifier receipts are missing/unreadable/unsafe, transition must be blocked;
- if no robust command set can be defined for a phase, that phase remains blocked.

Allowable file modifications:

- `docs/requirements/decisions/proof-or-stop-pinn-claim-admissibility-execution-plan.md` (this plan);
- optional CLI task/code/docs changes only under a future story branch implementing
  this plan.

## Current Status

- No production code changes have been merged for this extension yet.
- No existing story or runtime module implements a PINN-specific domain pack.
- This is a documentation-first decision artifact to drive a future story.

## Boundary and Non-Goals

What this proves:

- lifecycle claims do not advance when required evidence is missing, stale, mismatched, or unverifiable;
- unsupported claims can be downgraded before being promoted to stronger claims;
- claim transitions become reproducible with artifact-bound evidence.

What this does not prove:

- numerical PDE correctness;
- that a PINN is scientifically correct;
- that the method "solves" the problem class.

For all outcomes:

- non-claim-readiness, no-production mode is default unless separate stronger-readiness
  stories explicitly claim those readiness boundaries.

## Core Claim-Admissibility Matrix

PINN lifecycle claims and required checks:

| Claim ID | Claim | Required proof controls |
|---|---|---|
| C1 | Spec is frozen | PDE/domain/BC/IC/threshold declaration, hash-bound freeze record |
| C2 | Training completed | config/code/checkpoint/hash/seed, loss log, environment digest |
| C3 | Residual check passes | residual verifier report, grid hash, verifier script hash |
| C4 | BC pass | BC report and BC point hash |
| C5 | IC pass | IC report and IC point hash |
| C6 | Generalization supported | unseen points, residual distribution, out-of-sample eval set hash |
| C7 | Baseline comparison valid | same PDE/grid/budget/metric definition; statistical comparison record |
| C8 | Reproducible result | rerun receipt and tolerance-bound metric stability |
| C9 | Figure/table provenance | source run ID, generation script hash, output digest |

### Boundary rules (examples)

- Low training loss is not PDE-solution evidence.
- Residual on training points is not full-domain generalization evidence.
- Residual pass is not boundary-condition pass.
- A figure is not a baseline-improvement proof alone.
- Reproducibility requires a rerun/receipt path, not only an original run report.

## Evidence Identity (PINN-specific)

Each evidence item must bind to the lifecycle state with explicit identities:

- `pdeSpecHash`
- `domainHash`
- `boundaryConditionHash`
- `initialConditionHash`
- `collocationPointHash`
- `evaluationGridHash`
- `trainingConfigHash`
- `randomSeed`
- `checkpointHash`
- `codeHash`
- `verifierScriptHash`
- `environmentHash`
- `outputDigest`

No state transition may consume evidence that is not identity-bound to the active
claim state.

## Lifecycle Gates

State path and gating rules:

```text
Spec freeze → Training → Residual check → BC/IC checks → Out-of-sample check
→ Baseline comparison → Reproducibility → Result claim
```

Transition policy:

- required evidence must be current, hash-bound, and command/receipt-verified;
- missing, stale, drifted, or unverifiable evidence must not advance.

## Failure Injection Benchmark

Primary question:

`Does Proof-or-Stop reduce unsupported claim advancement versus other control regimes?`

Control regimes:

- A1 self-report only
- A2 checklist only
- A3 verifier-only, no lifecycle gate
- A4 PINN domain pack with gate control

All arms must use the same PDE specifications, domains, BC/IC definitions, model
architecture, optimizer, training budget, seed policy, collocation-point
generation policy, evaluation grids, verifier scripts, and failure injections.

The only intended difference is the lifecycle control regime.

Failure injection set:

1. spec changed while residual reused;
2. BC changed while BC report reused;
3. checkpoint mismatch;
4. collocation points changed;
5. grid narrowed to easy region;
6. baseline comparison benchmark mismatch;
7. stale figure provenance;
8. seed/config missing;
9. low training loss but high out-of-sample residual;
10. verifier threshold silently changed;
11. BC report missing;
12. IC report missing;
13. code changed after checkpoint;
14. metric changed;
15. manually edited figures/tables.

### Benchmark task set

The first benchmark should use small, reproducible PINN tasks where a high-confidence
numerical reference is available.

- 1D Poisson / elliptic equation
- 1D heat equation
- 1D Burgers-type equation
- Simple 2D Poisson or diffusion task if runtime allows

These tasks are used only to verify whether lifecycle claim advancement is controlled by admissibility evidence, not to claim PINN performance.

### Metrics

- unsupported-advance rate (primary)
- stale-evidence acceptance rate (primary)
- claim-boundary violation rate
- reproducibility success rate
- false-stop / repair-success / human-intervention rate
- wall-time cost overhead

### Success criteria

A first implementation is successful if:

- A4 rejects all intentionally stale or mismatched evidence cases in B1–B15 in the deterministic contract suite;
- A4 has lower unsupported-advance rate than A1, A2, and A3 in the benchmark run;
- A4 has lower stale-evidence acceptance rate than A1, A2, and A3;
- all false-stop cases are reported with explicit reason codes;
- wall-time overhead and human-intervention rate are reported, not hidden;
- first paper-grade results report rates with confidence intervals rather than only pass/fail counts.

## Minimal Implementation Plan

### Milestone 0 — Scope and policy lock

Deliverable:

- Domain model freeze for claim/admissibility scope;
- schema and boundary definitions for non-goals and failure semantics;
- test plan for A1–A4 and B1–B15 injections.

Acceptance:

- clear statement of what is and is not claimed;
- one-command evidence-binding checklist prepared.

### Milestone 1 — Evidence/claim schema

Deliverable:

- claim and evidence schemas for PINN lifecycle state;
- command-set compatibility checks for evidence freshness/hash bindings.

Acceptance:

- stale/missing/mismatched evidence can be detected deterministically.

### Milestone 2 — Verifier adapter pack

Deliverable:

- verifier scripts/adapters for PDE spec, residual, BC, IC, baseline fairness, reproducibility, and provenance;
- each adapter writes machine-readable evidence with deterministic hashes and exit codes.

Acceptance:

- each adapter fails closed on missing/bad inputs.

### Milestone 3 — Gate policy and transition engine updates

Deliverable:

- lifecycle transition policy bound to claim/evidence registry;
- fail-closed behavior (`repair`, `degrade`, `stop`) semantics.

Acceptance:

- no unsupported transition can be completed; command and receipt binding are enforced.

### Milestone 4 — Benchmark harness

Deliverable:

- failure-injection runner and report pipeline for A1–A4;
- analysis script for rate metrics and cost overhead.

Acceptance:

- reproducible comparison tables and confidence intervals for at least each A4-vs-A1/A2/A3.

### Milestone 5 — Reporting and governance integration

Deliverable:

- artifact index, claims-boundary report format, and non-claim wording for papers/docs;
- explicit boundary paragraph for PINN extension text in downstream docs.

Acceptance:

- no statement of PDE correctness is claimed from this system alone;
- claim progression language is mechanically consistent.

## Milestone / delivery status axis

- M0–M5: design artifacts completed in this story.
- M0–M5 acceptance criteria defined; runtime implementation and verification are out of scope of this story.
- This avoids duplicate future work by making completed vs. pending scope explicit.

## Value to Proof-or-Stop

This extension is meaningful even if not scientific verification:

- it reduces false-positive claim escalation in high-value research workflows;
- it gives a reusable cross-domain model for claim control;
- it reduces overclaiming risk without overpromising scientific truth;
- it increases reuse value of existing DONE/review/claim-boundary mechanics by extending
  them into research workflow governance.

## Ready-to-Quote Boundary Paragraph

Potential wording for future docs (non-abstract, non-results section):

> Proof-or-Stop can be extended to PINN research as cross-domain claim-admissibility
> control. It does not solve the PDE or prove numerical correctness. It proves
> whether a reported PINN research claim has enough admissible, bound, and reproducible
> evidence to advance across lifecycle stages such as training, residual verification,
> boundary-condition checking, baseline comparison, reproducibility, and result reporting.

## Publication posture

- Do not place this full execution plan in the current paper body.
- Use a short Future Work paragraph only if helpful, using the boundary paragraph
  above (or a close paraphrase) without claiming PDE performance.
