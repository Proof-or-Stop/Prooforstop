# Claim-Admissibility Adapter Pack Framework

Status: decision draft
Scope: framework contract for claim-admissibility packs and future domain capabilities
Created: 2026-07-02

## Purpose

This document defines the adapter-pack framework that should sit above the
existing Proofbound proof-admissibility base.

The goal is to let future domains add claim-specific schemas, verifiers, gate
policies, and benchmark controls without creating a second proof manager,
storage system, ledger, or lifecycle gate stack.

The framework claim is narrow:

```text
Proofbound can decide whether a claim is admissible for a lifecycle consumer.
Proofbound cannot claim that a domain result is scientifically true.
```

## Current Base

The existing base is the local proof-admissibility runtime. It already provides
the shared vocabulary and the gate-facing enforcement path that packs must use.

Implemented base capabilities:

- `proof-admissibility` vocabulary:
  `admissibilityStatus`, `assuranceLevel`, `evidenceScope`,
  `EvidenceScope`, `TemporalRole`, `ArtifactRole`, `ClaimKind`,
  `ArtifactConsumerKind`, `ProofProducerBoundary`, and
  `AdmissibilityReasonCode`.
- `ProofSurfaceDefinition` registry entries for known proof-looking artifacts,
  including schema versions, producer boundary, strict-shape requirements,
  semantic-digest requirements, signature or receipt binding requirements,
  material binding requirements, allowed consumers, allowed claims, and
  remediation text.
- `ProofClaimPolicy` for deciding which claims a surface may satisfy for which
  consumers, while keeping `productionDoneEligible` false in the local CLI core.
- Strict shape and semantic digest helpers in the proof binding layer, including
  digest input over gate-consumed semantic fields such as story, head/material
  hashes, claim, verdict, and reason.
- Gate-facing diagnostics that normalize evaluator output into blocking or
  warning results for configured high-risk consumers.
- Local consumers for DONE, REVIEW, and HANDOFF paths:
  `DONE_REQUIRED` local gate evidence, review-assurance/quorum evidence, and
  handoff proof-ref separation.
- Read-only `AdmissibilityWaterline` projection for diagnostics. The waterline
  is diagnostic-only and cannot satisfy DONE or mint production completion.
- Compatibility re-export through
  `packages/main/src/core/evidence/admissibility/index.ts`, which avoids
  duplicating registries or proof definitions.

The current base is intentionally not a production truth engine. It classifies
proof-looking material, checks supported versions and bindings, reports reasons,
and blocks configured local consumers when policy is in enforce mode.

## Framework Boundary

The adapter-pack framework adds extensibility points around the existing base.
It does not replace the base.

Pack names and statuses:

- `ClaimAdmissibilityPack`: the generic interface for a pack.
- `DomainPack`: a pack specialized for a domain such as PINNs or computational
  quantum mechanics.
- `Proofbound code runtime pack`: the mature existing path for code/runtime
  lifecycle claims.

Boundary rules:

- The Proofbound code runtime pack is the existing, mature path.
- PINN remains a design contract for a future domain pack.
- Quantum M0-M3 is implemented and registered by default as a read-only
  descriptor/normalization plus local gate-policy projection. It exposes scoped
  claim/evidence schema descriptors, read-receipt-only verifier adapter
  descriptors for normalized local receipts, and a `quantum_claim_check`
  diagnostic that maps existing evaluator output to local
  `advance`/`repair`/`degrade`/`escalate`/`stop` decisions without mutating
  lifecycle state.
- Full future domain-pack capabilities such as command-backed verifier
  execution, global lifecycle gate integration, benchmark harnesses, and
  benchmark reporting remain pending. Theory, hardware, production, and
  Authority claims remain non-goals.
- Future packs may claim only claim admissibility. They must not claim
  scientific truth, mathematical proof, physical reality, solver quality, or
  experimental validation.
- A pack can define that evidence is strong enough for a lifecycle transition.
  It cannot define that the underlying scientific result is true.
- A pack must use the existing proof-admissibility vocabulary, evaluator,
  diagnostics, and EvidenceRuntime storage conventions.
- A pack must fail closed when evidence is missing, stale, mismatched, unsafe,
  unsupported, or unverifiable.

## Proposed Pack Interface

`ClaimAdmissibilityPack` is a declarative contract plus adapter hooks. It should
be loadable without giving the pack control over core lifecycle gates.

Minimal interface shape:

```ts
interface ClaimAdmissibilityPack {
  id: string;
  version: string;
  domain: string;
  displayName: string;
  proofSurfaces: ProofSurfaceDefinition[];
  claimSchemas: DomainClaimSchema[];
  evidenceSchemas: DomainEvidenceSchema[];
  verifierAdapters: VerifierAdapterDefinition[];
  gatePolicies: GatePolicyAdapterDefinition[];
  benchmarkHarnesses?: BenchmarkHarnessDefinition[];
}
```

The exact TypeScript names can change during implementation, but the contract
must preserve these responsibilities:

- declare claim and evidence identities;
- register proof surfaces with the existing proof-admissibility evaluator;
- load domain schemas for strict validation;
- resolve verifier adapters that produce machine-readable evidence;
- expose gate policy adapters that map domain claims to existing consumers;
- optionally expose benchmark harnesses for failure-injection evaluation.

## Pack Registry

The pack registry is the lookup layer for installed packs.

Responsibilities:

- load enabled packs from project configuration or built-in defaults;
- validate pack ids, versions, and supported contract versions;
- reject duplicate artifact kinds, aliases, claim ids, or schema ids unless an
  explicit compatibility override exists;
- merge pack `ProofSurfaceDefinition` entries into the existing registry path
  without allowing caller-writable metadata to become proof;
- expose read-only pack inventory for diagnostics and CLI reporting.

The registry must not create separate proof storage. It should only describe
what can be evaluated by the existing proof-admissibility evaluator and related
adapters.

## Domain Schema Loader

The domain schema loader validates the shape of claim and evidence payloads
before verifier output can be considered for admissibility.

Responsibilities:

- load pack-owned JSON schemas or equivalent typed schemas;
- bind schemas to pack id, pack version, and schema version;
- validate required identity fields for the active claim;
- report deterministic reason codes for missing fields, unexpected fields, or
  unsupported schema versions;
- feed strict-shape results into proof-admissibility checks.

Examples of domain identity fields:

- PINN: PDE spec hash, domain hash, BC/IC hashes, collocation point hash,
  evaluation grid hash, training config hash, seed, checkpoint hash, code hash,
  verifier script hash, environment hash, and output digest.
- Quantum: Hamiltonian hash, potential hash, domain hash, boundary condition
  hash, initial state hash, basis/grid/discretization hashes, timestep hash,
  tolerance policy hash, seed, checkpoint hash, reference data hash, plot script
  hash, code hash, solver config hash, verifier script hash, environment hash,
  and output digest.

These fields are admissibility identities. They are not scientific truth
claims.

## Verifier Adapter Loader

Verifier adapters run or read domain-specific checks and normalize their output.

Responsibilities:

- declare supported verifier versions and command specs;
- require deterministic, machine-readable output;
- bind verifier output to the active story, claim, material, command, and
  domain identity;
- reject unsafe, missing, unreadable, stale, or mismatched verifier receipts;
- produce evidence compatible with EvidenceRuntime and proof-admissibility
  checks;
- surface `checker_error` as non-admissible warning-only recovery, never as
  accepted proof.

The adapter loader should not decide lifecycle advancement by itself. It
produces verified evidence inputs for the gate policy adapter.

## Gate Policy Plugin

Gate policy adapters map domain claims to existing Proofbound lifecycle
consumers.

Responsibilities:

- map domain claim ids to `ClaimKind` and `ArtifactConsumerKind`;
- define which evidence identities are required for each transition;
- decide `advance`, `repair`, `degrade`, `escalate`, or `stop` results;
- pass final checks through the proof-admissibility evaluator;
- preserve existing lifecycle gates and configured enforce/warn behavior;
- keep local CLI `productionDone` and release-readiness claims out of domain
  packs.

Gate policy adapters must not weaken DONE, REVIEW, TEST, HANDOFF, or
DONE_REQUIRED requirements. They may add stricter domain requirements.

## Benchmark Harness Plugin

Benchmark harnesses evaluate whether a pack reduces unsupported claim
advancement.

Responsibilities:

- define control regimes such as self-report, checklist-only, verifier-only,
  and pack-gated workflows;
- define failure-injection cases for stale, mismatched, missing, forged, or
  over-upgraded evidence;
- report unsupported-advance rate, stale-evidence acceptance rate,
  claim-boundary violation rate, reproducibility success, false-stop rate,
  repair success, human-intervention rate, and wall-time overhead;
- report confidence intervals where benchmark results are used for
  paper-grade claims;
- keep benchmark outputs diagnostic unless a gate policy explicitly consumes a
  specific benchmark artifact through proof-admissibility.

Benchmark harnesses prove control effectiveness, not domain truth.

## Flow

```text
Domain files / verifier receipts / benchmark runs
              |
              v
      ClaimAdmissibilityPack
              |
              +--> domain schema loader
              |
              +--> verifier adapter loader
              |
              +--> gate policy plugin
              |
              +--> benchmark harness plugin
              |
              v
      pack registry
              |
              v
      ProofSurfaceDefinition + ProofClaimPolicy
              |
              v
      proof-admissibility evaluator
              |
              v
      gate-facing diagnostics
              |
              v
      DONE / REVIEW / TEST / HANDOFF / DONE_REQUIRED consumers
```

## Minimal Implementation Slice

### M0: Document Contract

Deliver this framework document and treat it as the pack boundary contract.

Acceptance:

- current base and future framework are separated;
- PINN and full Quantum domain-pack capabilities are described as future
  domain-pack contracts;
- Quantum M0-M3 is distinguished as the current read-only
  descriptor/normalization plus local gate-policy projection implementation;
- non-goals prevent second proof systems and scientific truth claims.

### M1: Pack Interface And Registry

Add a typed `ClaimAdmissibilityPack` interface and a registry that can list,
validate, and expose enabled packs.

Acceptance:

- built-in code runtime pack can be represented as a pack descriptor;
- duplicate ids, schema ids, artifact kinds, and aliases are rejected;
- unknown pack entries fail closed with clear diagnostics.

### M2: Domain Schema Loader And Quantum Read-Only Pack

Add a schema loader for pack-owned claim and evidence schemas. The current
Quantum M0-M3 slice also delivers the default-registered read-only quantum
descriptor/normalization pack and local gate-policy projection: scoped
claim/evidence descriptors, read-receipt-only verifier adapter descriptors,
normalization of supplied local receipts, and `quantum_claim_check` output for
local claim-admissibility decisions.

Quantum M3 does not execute external commands, create storage, create ledgers,
create global lifecycle gates, add benchmark harnesses or reporting, claim
production completion, act as Authority, validate hardware, or prove quantum
mechanics. Its local gate-policy projection is read-only and keeps
`productionDone=false` and `authorityDone=false`.

Acceptance:

- schemas are bound to pack id, pack version, and schema version;
- required identity fields are validated deterministically;
- strict-shape failures map to existing admissibility reason codes.
- the default registry includes the read-only quantum descriptor/normalization
  and local gate-policy projection without adding lifecycle gate authority.

### M3: Verifier Adapter Contract

Define verifier adapter inputs, outputs, versioning, and failure behavior.

Acceptance:

- adapters declare command specs and verifier versions;
- adapter output binds story, claim, material, command, and domain identity;
- missing, stale, mismatched, unsafe, or checker-error cases cannot become
  admissible proof.

### M4: Gate Policy Adapter

Map pack claims into existing lifecycle consumers through a gate policy adapter.

Acceptance:

- policies call the shared proof-admissibility evaluator;
- domain policies can strengthen but not weaken lifecycle gates;
- local CLI production completion remains false unless a separate external
  production adapter proves its own policy outside the local core.

### M5: Benchmark Adapter

Add an optional benchmark harness plugin for failure-injection evaluation.

Acceptance:

- benchmark cases can compare self-report, checklist-only, verifier-only, and
  pack-gated regimes;
- unsupported advancement and stale acceptance are reported explicitly;
- benchmark outputs remain diagnostic unless consumed by a registered gate
  policy.

## Non-Goals

- Do not create a second proof manager.
- Do not create a second proof storage root.
- Do not create a second proof ledger.
- Do not bypass or duplicate EvidenceRuntime.
- Do not edit story or fixture JSON directly for pack state.
- Do not weaken lifecycle gates.
- Do not let caller-writable metadata become admissible proof.
- Do not let local diagnostics, waterline rows, handoff packs, or benchmark
  reports mint production completion.
- Do not claim PINN correctness, quantum-mechanics truth, numerical exactness,
  solver quality, physical validation, quantum advantage, or experimental
  validation.
- Do not treat old plan documents as stronger than current code, current
  evidence, and fresh proof-admissibility diagnostics.

## Open Design Questions

- Whether pack manifests should live in code, configuration, or both.
- Whether schemas should be JSON Schema, TypeScript-first, or a constrained
  internal schema format.
- Whether verifier adapters should execute commands directly or only normalize
  receipts produced by existing command runners.
- How much of the existing code/runtime proof path should be re-described as a
  built-in pack before adding PINN packs or expanding Quantum beyond the M2
  read-only descriptor/normalization slice.
