# B-1995 — Wave 1 acceptance topology schema and diagnostics

## Delivery boundary

Implement only Wave 1 from the approved execution plan. Planned-path declarations remain owned by checklist verificationIntent; verificationTopology is optional and reference-only on each ProofStory acceptance binding; acceptance_matrix is a deterministic read-only, non-evidentiary projection. Wave 1A coverage-basis discovery/signing and all lifecycle enforcement are excluded.

## CHK-001 — Implement verificationIntent-owned planned-path declaration schema

Add the versioned planned-path and endpoint types to core types and extend the shared verificationIntent item schema. Normalize stable IDs, one producer, one-or-more consumers, producer_to_consumer relation, expected artifact kind/file/symbol-or-fact, checklist fileDeclarationRef, and outputFactRef. Reject duplicates, invalid roles, empty refs, unsafe/unresolved file declaration refs, and malformed schema versions. Preserve the existing PLAN-only verificationIntent write/freeze boundary rather than creating a new writer.

Verification: schema round-trip through the real checklist_update flow in PLAN; reject mutation after PLAN; invalid and duplicate endpoint/declaration IDs fail; legacy intent items without declarations remain readable.

## CHK-002 — Implement reference-only acceptance topology v1 normalization and structural diagnostics

Extend ProofStoryAcceptanceBinding with optional proofstory.acceptance_topology.v1. The topology stores references to canonical existing sources or frozen planned declaration/endpoint IDs and must not copy claims, edge prose, observed results, or verdicts. Add deterministic observe-only diagnostics for schema/version, duplicate IDs, unresolved checklist/intent/milestone/declaration/endpoint refs, producer/consumer role mismatch, missing positive/mutation/transcript/command reference groups, and attempted topology self-authorship. Normalize missing topology as legacy_missing without changing existing ProofStory gate reports.

Verification: valid topology resolves; malformed/unresolved/self-authored references produce stable codes; input permutations normalize identically; existing contract round-trips unchanged.

## CHK-003 — Implement derived read-only acceptance matrix rendering

Add dedicated lattice acceptance_matrix --storyId=<id> [--json]. Register it as ownershipClass readOnly and in the shared activity/hook read-only classification. Derive every row from milestone ledger, ProofStory acceptance bindings, checklist verificationIntent/planned declarations, and current evidence. Text starts with the Story ID and explicitly states observe/read-only/non-evidentiary mode. JSON exposes canonical source IDs, topologyState, deterministic diagnostics, and no persisted result. Disagreement is displayed, never repaired by choosing a value.

Verification: real CLI transcript for topology-enabled and legacy stories; repeated/permuted input gives byte-stable output; before/after filesystem and process-event checks prove no write; unsupported write/apply/evidence flags are rejected by schema.

## CHK-004 — Prove Wave 1 compatibility and non-gating boundaries

Create a focused topology smoke using a temporary repository and real handlers/CLI where appropriate. Cover valid round-trip, legacy_missing, invalid references, topology-self-authorship mutation, deterministic ordering, derived matrix IDs, read-only behavior, docs-only applicability, and unchanged lifecycle transitions. Include a negative assertion that Wave 1 cannot produce a signed coverage basis, classify coverage complete, satisfy review evidence, or alter PLAN→DEV / DEV→REVIEW decisions.

Run the focused smoke, main TypeScript build, existing ProofStory intent-hardening smoke, process-fact contract check when relevant, and standard TEST validation. Bump the CLI patch version because a new runtime command is added.

## Expected user transcript

lattice acceptance_matrix --storyId=B-1995 prints:

Acceptance matrix for B-1995
Mode: observe (read-only, non-evidentiary)
Topology state: configured | legacy_missing
Rows: <deterministically sorted canonical source rows>
Diagnostics: <stable codes or none>

The command exits without changing the Story phase, evidence, process events, or any matrix artifact.
