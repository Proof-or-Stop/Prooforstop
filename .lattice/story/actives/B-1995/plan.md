# B-1995 — Wave 1 acceptance topology schema and diagnostics

## Delivery boundary

Implement only Wave 1 from the approved execution plan. Planned-path declarations remain owned by checklist verificationIntent; verificationTopology is optional and reference-only on each ProofStory acceptance binding; acceptance_matrix is a deterministic read-only, non-evidentiary projection. Wave 1A coverage-basis discovery/signing and all lifecycle enforcement are excluded.

Because Wave 1 has no independent coverage-basis verifier, no topology or matrix row may report structurally-complete, ready-for-review, complete, pass, or equivalent authority. The only Wave 1 result states are legacy_missing, warning, and inconclusive_basis_unverified. Publish acceptance_matrix only; acceptance_topology_check and pre_review_check remain unimplemented.

## CHK-001 — Implement verificationIntent-owned planned-path declaration schema

Add the versioned planned-path and endpoint types to core types and extend the shared verificationIntent item schema. Normalize stable IDs, one producer, one-or-more consumers, producer_to_consumer relation, expected artifact kind/file/symbol-or-fact, checklist fileDeclarationRef, and outputFactRef. fileDeclarationRef has canonical form CHK-NNN:files:modify|create|test:INDEX and must point to the current checklist item, an existing array element, and the exact expectedFileRef. Reject duplicates, invalid roles, empty refs, unsafe/unresolved file declaration refs, and malformed schema versions atomically.

Preserve ordinary legacy verificationIntent writes. Add a declaration-specific reverse guard: any payload containing plannedPathDeclarations must be authored by the registered verification-intent role during PLAN; ordinary callers and all post-PLAN mutation attempts are rejected before persistence. Do not create a new writer.

Verification: schema round-trip through the real verification-intent CLI flow in PLAN; reject an ordinary caller and mutation after PLAN while original bytes remain identical; invalid and duplicate endpoint/declaration IDs fail atomically; legacy intent items without declarations remain readable.

## CHK-002 — Implement reference-only acceptance topology v1 normalization and structural diagnostics

Extend ProofStoryAcceptanceBinding with optional proofstory.acceptance_topology.v1. The topology stores references to canonical existing sources or frozen planned declaration/endpoint IDs and must not copy claims, edge prose, observed results, authority, coverage-completeness, or verdicts. Put pure normalization, ref resolution, intrinsic totality diagnostics, and deterministic projection in a dedicated core module.

Add deterministic observe-only diagnostics for schema/version, duplicate IDs, unresolved checklist/intent/milestone/declaration/endpoint refs, producer/consumer role mismatch, orphan directions, missing positive/mutation/transcript/command reference groups, and attempted topology self-authorship. Normalize missing topology as legacy_missing without changing existing ProofStory gate reports. A structurally coherent topology still reports inconclusive_basis_unverified until Wave 1A independently derives a basis.

Verification: valid references resolve but remain inconclusive_basis_unverified; malformed/unresolved/self-authored references produce stable codes; input permutations normalize identically; existing contract round-trips unchanged. Dormant authority-contract target/evidence/negativeControls vocabulary is not revived as canonical topology ownership.

## CHK-003 — Implement derived read-only acceptance matrix rendering

Add only lattice acceptance_matrix --storyId=<id> [--json]. Register it as ownershipClass readOnly, L0/non-gate-consuming, and in the shared activity/hook read-only classification. Do not expose mode, write, output, apply, result, verdict, or evidence payload arguments. Derive every row from milestone ledger, ProofStory acceptance bindings, checklist verificationIntent/planned declarations, and current evidence. Text starts with the Story ID and explicitly states observe/read-only/non-evidentiary mode. JSON exposes canonical source IDs, topologyState, deterministic diagnostics, and one of legacy_missing, warning, or inconclusive_basis_unverified. Disagreement is displayed, never repaired by choosing a value.

Verification: real CLI transcript for topology-enabled and legacy stories; repeated/permuted input gives byte-stable output; before/after filesystem, process-event, git-status, phase, and evidence checks prove no write; unsupported write-shaped flags are rejected by schema.

## CHK-004 — Prove Wave 1 compatibility and non-gating boundaries

Create a focused topology smoke using a temporary repository and real handlers/CLI where appropriate. Cover valid round-trip, legacy_missing, invalid references, topology-self-authorship mutation, deterministic ordering, derived matrix IDs, read-only behavior, docs-only applicability, and unchanged lifecycle transitions. Include negative assertions that Wave 1 cannot produce a signed coverage basis, classify coverage complete, satisfy review evidence, register a lifecycle gate consumer, or alter PLAN→DEV / DEV→REVIEW decisions.

Do not modify machine.ts or phase-gates.ts. Do not implement discovery adapters, basis receipts/digests, pre_review_check, prompt integration, Authority/freshness decisions, writable output, or topology enforcement.

Run the focused smoke, main TypeScript build, existing ProofStory intent-hardening smoke, process-fact contract check, and standard TEST validation. Update docs/CLI.md. Bump the CLI patch version because a new runtime command is added.

## Expected user transcript

lattice acceptance_matrix --storyId=B-1995 prints:

Acceptance matrix for B-1995
Mode: observe (read-only, non-evidentiary)
Topology state: configured | legacy_missing
Result: inconclusive_basis_unverified | warning | legacy_missing
Rows: <deterministically sorted canonical source rows>
Diagnostics: <stable codes or none>

The command exits without changing the Story phase, evidence, process events, or any matrix artifact.
