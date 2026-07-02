# Plan: B-01df Source Lineage Audit M1

Goal: deliver the first read-only source lineage audit for learning artifacts. This story intentionally stops before seed proposal, candidate approval, automatic promotion, DONE settlement default-on, or runtime blocking policy.

## CHK-001

Implement a small core projection that collects learning-domain artifacts into versioned lineage records. Each record should expose artifact identity, source references when present, canonicalSourceKey, canonicalSourceKeyVersion, canonicalizationPolicyHash, authority=non_authoritative, and gateEvidence=false. Missing or malformed lineage must become diagnostics rather than throw-only failure. The collector should use read-only store access and should not create learning files in an empty project.

Verification focus: synthetic duplicate sourceStoryId/sourceFindingId/signature records group under one canonical source key; missing lineage is counted and listed; all derived records remain non-authoritative and non-gate evidence.

## CHK-002

Expose the projection through host-neutral CLI command lattice source_lineage_audit --domain=learning --json. Register command metadata as read-only/L0 and keep it out of Codex, Claude, or other host-adapter namespaces. Unsupported domains should fail clearly.

Verification focus: JSON output includes counts, duplicateCanonicalSourceGroups, missingLineageCount, and authority/gateEvidence; command policy/process facts classify it as read-only and L0; running the CLI does not mutate .lattice learning stores.

## CHK-003

Add focused smoke coverage and align the execution-plan docs with the M1 boundary. The docs must state that this story only audits source lineage and does not create proposals, candidates, outcomes, promotion decisions, or active playbooks. Update NAV only for the new decision document entry.

Verification focus: smoke covers duplicate grouping, malformed/missing lineage, empty-store read-only posture, unsupported domain behavior, and no host-specific command alias. Build and smoke should pass before story gates advance.

## Exclusions

- No playbook_seed_observe implementation.
- No playbook_seed_propose_batch implementation.
- No candidate approval flow.
- No automatic candidate to active promotion.
- No PLAYBOOK_DONE_SETTLEMENT_ENABLED default-on change.
- No runtime guidance or DONE gate blocker based on this audit output.
