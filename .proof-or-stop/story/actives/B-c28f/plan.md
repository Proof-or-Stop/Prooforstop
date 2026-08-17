# B-c28f Plan

## Scope

Implement the candidate-only half of the DONE experience learning path:

- DONE story summary / pitfalls / delivery-check material becomes a stable `done_experience` lineage record.
- `playbook_seed_observe` can expose that lineage as a deduplicated seed.
- Existing digest-guarded proposal and candidate approval flows can turn that seed into an inert candidate playbook.
- DONE success alone still never records `helped`, never activates runtime guidance, and never satisfies gate evidence.

Out of scope: automatic activation, historical backfill, semantic LLM dedup, DONE gate behavior changes, and remote publish.

## CHK-001: Add DONE Experience Source Lineage

1. Extend experience-layer source types with `done_experience`.
2. Add a source-lineage collector that reads DONE stories and extracts bounded summary / delivery-check material.
3. Use a stable story-backed lineage convention for DONE experience so repeated observation produces the same canonical key and canonical key version.
4. Add a `done-experience` seed filter while preserving `all` as the default.
5. Verify partial DONE artifacts do not crash seed observation.

Verification:

- Focused smoke asserts `playbook_seed_observe` reports `sourceArtifactKind: "done_experience"`.
- Focused smoke asserts repeated observation produces the same `canonicalSourceKey` and `canonicalSourceKeyVersion`.
- Focused smoke asserts DONE success alone does not create a helped outcome or active playbook.

## CHK-002: Convert DONE Experience Seed Into Proposal And Candidate

1. Reuse the existing `playbook_seed_propose_batch --apply --observeDigest` path.
2. Reuse the existing `playbook_candidate_batch_approve --apply --manifestDigest` path.
3. Ensure DONE-experience proposals validate as normal candidate playbooks.
4. Verify repeated observe/propose/approve cannot create duplicate candidates for the same DONE story.

Verification:

- Focused smoke stages a proposal from a DONE-experience seed and approves it into a candidate.
- Focused smoke asserts the candidate status remains `candidate`.
- Focused smoke asserts represented canonical sources block a second candidate.

## CHK-003: Document DONE-Experience Candidate Boundary

1. Update the source-lineage / seed-promotion execution plan with the DONE-experience seed path.
2. Update the playbook-promotion worker plan with the candidate-only boundary.
3. State explicitly that DONE experience seeds create candidate playbooks only; DONE success alone never records helped and never activates runtime guidance.
4. Distinguish new DONE story seeding from later historical backfill.

Verification:

- Documentation checks confirm the exact boundary sentence exists.
- Documentation checks confirm historical backfill remains separate from new DONE story seeding.
