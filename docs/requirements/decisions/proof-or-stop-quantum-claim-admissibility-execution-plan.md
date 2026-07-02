# Proof-or-Stop for Computational Quantum Mechanics: Claim-Admissibility Execution Plan

Status: formal story source of truth for B-7b4e  
Runtime status: Quantum claim-admissibility runtime status: M0-M1 implemented; M2-M5 pending.  
Created: 2026-07-02  
Scope: local computational quantum-mechanics claim-admissibility controls

## Purpose

This plan defines a bounded Proof-or-Stop domain pack for dry computational
quantum-mechanics workflows. It is a claim-admissibility control layer, not a
quantum-theory proof engine, a quantum solver, an experimental physics validator,
or an external Authority integration.

Proof-or-Stop for computational quantum mechanics proves only whether a reported
quantum-simulation claim has enough admissible, bound, current, and reproducible
evidence to advance across lifecycle stages.

## Current Implementation Slice

B-7b4e implements only Milestones 0 and 1:

- M0: scope, policy, non-goals, claim IDs, boundary semantics, and fail-closed
  reason vocabulary.
- M1: local claim/evidence schema and deterministic identity binding checks for
  stale, missing, mismatched, weak, or unbound evidence.

M2 through M5 remain pending:

- no verifier adapter pack;
- no lifecycle transition engine integration;
- no benchmark harness or failure-injection runner;
- no reporting/governance integration beyond the local smoke task.

## Execution Boundary

### What this controls

- Hamiltonian, potential, domain, basis, grid, discretization, boundary
  condition, initial state, timestep, tolerance, reference data, solver output,
  and figure/table provenance identity binding.
- Whether an evidence receipt is admissible for a specific Quantum Q1-Q12 claim.
- Whether weak computational evidence must degrade to a narrower scoped claim.
- Whether missing, stale, mismatched, or unbound evidence stops advancement.

### What this does not claim

- It does not prove quantum mechanics.
- It does not prove physical reality or validate laboratory measurements.
- It does not prove a numerical solution is mathematically exact.
- It does not improve solver, optimizer, algorithm, ansatz, architecture, or
  approximation quality.
- It does not evaluate quantum hardware or device calibration.
- It does not claim broad quantum advantage.
- It does not create production, external Authority, or terminal completion
  proof.

## Reuse Boundary

This domain pack must not create a second proof manager, storage root, append-only
admissibility ledger, or gate-specific proof system. It reuses the existing
Proof-or-Stop local evidence/admissibility boundary conceptually and remains a
domain-local schema/evaluator for this story slice.

## Core Claim-Admissibility Matrix

| Claim ID | Computational quantum claim | Required proof controls |
|---|---|---|
| Q1 | Hamiltonian / potential is frozen | Hamiltonian definition, potential, domain, units, boundary condition, hash-bound freeze record |
| Q2 | Basis / grid / discretization is frozen | Basis-set or grid hash, resolution, cutoff, discretization method, tolerance policy |
| Q3 | Initial state is frozen | Initial wavefunction/state vector/density matrix hash, normalization check, preparation config |
| Q4 | Solver run completed | Solver config, code hash, seed if stochastic, checkpoint/output hash, environment digest |
| Q5 | Eigenvalue / energy claim passes | Eigenvalue report, residual norm, tolerance, reference comparison if available |
| Q6 | Wavefunction normalization holds | Normalization report, threshold, verifier script hash, output digest |
| Q7 | Unitarity / probability conservation holds | Time-evolution report, norm drift, timestep identity, verifier receipt |
| Q8 | Symmetry / invariant holds | Parity, angular momentum, energy conservation, or relevant invariant-verifier report |
| Q9 | Convergence supported | Grid/basis refinement report, tolerance-bound convergence trend, output digest |
| Q10 | Baseline/reference comparison valid | Same Hamiltonian, units, grid/basis policy, metric definition, statistical/comparison record |
| Q11 | Reproducible result | Rerun receipt and tolerance-bound metric stability |
| Q12 | Figure/table provenance | Source run ID, generation script hash, output digest, plotting config hash |

## Evidence Identity

Every evidence receipt must bind to the active lifecycle state with explicit
identity fields.

### Core identity fields for all claims

- `codeHash`
- `solverConfigHash`
- `verifierScriptHash`
- `environmentHash`
- `outputDigest`

### Conditional identity fields

- `hamiltonianHash` for Hamiltonian/spec-bound claims
- `potentialHash` for potential-dependent claims
- `domainHash` for domain-bound claims
- `boundaryConditionHash` for boundary-conditioned claims
- `initialStateHash` for initial-state-bound claims
- `basisSetHash` for basis-bound claims
- `gridHash` for grid-bound claims
- `discretizationHash` for discretization-bound claims
- `timeStepHash` for time-evolution claims
- `tolerancePolicyHash` for threshold-bound claims
- `randomSeed` when the method is stochastic or seed-sensitive
- `checkpointHash` when the claim depends on a resumed or checkpointed run
- `referenceDataHash` when a baseline or reference comparison is claimed
- `plotScriptHash` when a figure or table provenance claim is made

No lifecycle transition may consume evidence unless all core identity fields are
present and every conditional field that applies to the claim is present.

## Boundary Rules

| Weak evidence | Allowed scoped claim | Blocked stronger claim |
|---|---|---|
| One solver run returns an energy value | Energy reported under configuration X | True ground-state energy proven |
| Low residual on one grid | Grid-specific residual passes | Continuum solution proven |
| Norm drift below threshold in one run | Simulation stable under declared timestep and threshold | Physical system validated |
| One basis-size result | Result under basis/grid X | Convergence established |
| VQE estimate improved under one configuration | Pipeline-specific estimate improved | Quantum advantage shown |
| Figure matches output file | Figure provenance valid | Scientific conclusion proven |
| Reference comparison with different units/grid | No comparative claim allowed | Outperforms baseline/reference |

## M0-M1 Failure Semantics

The local evaluator must fail closed with stable reason codes when:

- the schema version is unsupported;
- the claim ID is unknown;
- any core identity field is missing;
- any claim-required conditional identity field is missing;
- a required receipt is missing;
- duplicate receipts are supplied for a required evidence kind;
- a receipt status fails or exits nonzero;
- evidence is stale;
- active and receipt identities mismatch;
- `hamiltonianHash`, `gridHash`, or `verifierScriptHash` mismatches the active
  claim state;
- solver output is unbound;
- plot/table provenance is unbound;
- weak single-run energy evidence is used to assert ground-state, convergence,
  quantum-advantage, production, Authority, hardware, or theory claims.

The evaluator returns:

- `allowed`: whether the specific scoped claim may advance;
- `nextAction`: `advance`, `repair`, `degrade`, `escalate`, or `stop`;
- `scopedClaim`: whether the surviving claim is explicitly scoped to the bound
  computational identity;
- boundary booleans that remain false for quantum theory, physical validation,
  hardware validation, solver improvement, production, and Authority claims.

## Lifecycle Gates

Recommended future state path:

```text
Model/spec freeze
-> basis/grid/discretization freeze
-> solver/simulation run
-> normalization / invariant checks
-> convergence / error check
-> reference or baseline comparison
-> reproducibility gate
-> result claim
```

Transition policy:

- required evidence must be current, hash-bound, and receipt verified;
- missing, stale, drifted, or unverifiable evidence must not advance;
- weak evidence may allow only a weaker scoped claim;
- stronger claims require stronger gate policies.

## Example Gate Behavior

### Hamiltonian changed, old eigenvalue reused

Claim:

```text
The ground-state energy is E under the current Hamiltonian.
```

Evidence problem:

```text
The eigenvalue report is bound to an old hamiltonianHash.
```

Gate result:

```text
Stop. The energy claim cannot advance until the solver is rerun under the current Hamiltonian identity.
```

### One grid result used as convergence proof

Claim:

```text
The numerical solution is converged.
```

Evidence problem:

```text
Only one grid/basis result exists; no refinement trend or tolerance-bound comparison is present.
```

Gate result:

```text
Degrade. Allow "result under grid/basis X"; block "converged result".
```

### Stale figure provenance

Claim:

```text
Figure 3 reports the current simulation result.
```

Evidence problem:

```text
Figure outputDigest is bound to a previous source run ID or plotting script hash.
```

Gate result:

```text
Stop. Regenerate the figure from the current source run and plotting script.
```

## Future Failure Injection Set

M4 may later implement a benchmark using these deterministic injections:

1. Hamiltonian changed while old eigenvalue reused.
2. Potential changed while old wavefunction reused.
3. Boundary condition changed while old report reused.
4. Basis/grid changed while old convergence report reused.
5. Timestep changed while old unitarity report reused.
6. Wavefunction not normalized.
7. Energy residual above threshold.
8. Symmetry or invariant violated.
9. Reference comparison uses different units.
10. Baseline uses different grid/basis resolution.
11. Solver config changed after checkpoint.
12. Verifier threshold silently changed.
13. Figure generated from stale run.
14. Random seed/config missing for stochastic method.
15. Manually edited table/plot.

## Milestones

### Milestone 0 - Scope and policy lock

Deliverables:

- domain model freeze for quantum claim/admissibility scope;
- schema and boundary definitions for non-goals and failure semantics;
- test plan for future A1-A4 and B1-B15 injections.

Acceptance:

- clear statement of what is and is not claimed;
- local evidence-binding checklist prepared;
- no experimental, hardware, solver-improvement, production, Authority, or
  physical-validation claim is implied.

### Milestone 1 - Evidence/claim schema

Deliverables:

- claim and evidence schemas for quantum lifecycle state;
- deterministic evidence freshness/hash binding checks;
- local TypeScript schema for quantum evidence receipts.

Acceptance:

- stale, missing, mismatched evidence can be detected deterministically;
- schema rejects unbound solver output and unbound plots/tables.

### Milestone 2 - Verifier adapter pack

Pending. Future work may add verifier scripts/adapters for Hamiltonian/spec,
basis/grid, solver output, normalization, invariant checks, convergence,
reference comparison, reproducibility, and provenance.

### Milestone 3 - Gate policy and transition engine updates

Pending. Future work may bind lifecycle transitions to the claim/evidence
registry and expose controlled `repair`, `degrade`, `escalate`, or `stop`
behavior.

### Milestone 4 - Benchmark harness

Pending. Future work may add A1-A4 baseline comparison, B1-B15 failure
injections, rate metrics, confidence intervals, and bounded runtime fixtures.

### Milestone 5 - Reporting and governance integration

Pending. Future work may add artifact indexes, report format, and downstream
non-claim wording.

## Ready-to-Quote Boundary Paragraph

Proof-or-Stop can be extended to computational quantum mechanics as local
claim-admissibility control. It does not prove quantum mechanics, validate a
physical system, improve solvers, prove broad quantum advantage, or create
production/Authority completion. It checks whether a reported quantum-simulation
claim has enough current, bound, admissible evidence to advance across scoped
lifecycle stages such as model/spec freeze, solver execution, invariant checking,
convergence analysis, reference comparison, reproducibility, and result
reporting.
