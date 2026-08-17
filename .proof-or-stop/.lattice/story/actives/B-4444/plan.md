# B-4444 Execution Plan

Status: PLAN artifact for a documentation-only Story. This plan creates one auditable decision document and does not implement the proposed runtime behavior.

## CHK-001 — Document current ownership and non-duplication boundaries

1. Ground the document in current code and canonical decision documents.
2. Give each existing surface one owner: milestone ledger for intent totality; acceptanceBindings for accepted claims; verificationIntent for planned scenarios; verificationEvidence for observed results; REVIEW completeness for post-implementation scrutiny.
3. State the non-duplication invariant: no persisted acceptance_matrix artifact; any matrix is a deterministic read-only projection.
4. Add a current-versus-proposed table so readers cannot mistake the plan for shipped behavior.

## CHK-002 — Specify acceptance topology and both lifecycle checks

1. Specify a versioned, nested topology on each ProofStory acceptance binding using references rather than copied claims.
2. Define producer, consumer, positive assertion, mutation case, transcript assertion, command, and evidence-authority records with stable IDs.
3. Define bidirectional totality, reference validity, applicability, uniqueness, polarity, authority, and freshness rules.
4. Define acceptance_topology_check at PLAN→DEV as a structural-only check.
5. Define pre_review_check at DEV→REVIEW as an executable evidence/freshness check that fails when required mutations do not bite or transcript assertions are absent.
6. Specify stable diagnostic codes and a derived matrix renderer.

## CHK-003 — Specify implementation waves, negative controls, rollout, and audit rubric

1. Map likely source, handler, schema, registry, prompt, and test touchpoints without editing them.
2. Decompose implementation into bounded follow-up Stories with explicit dependencies and stop conditions.
3. Define observe→warn→enforce rollout, legacy normalization, docs-only applicability, rollback, and evidence freshness semantics.
4. Define positive, edge, adversarial, mutation, transcript, stale-evidence, and truth-source-drift test cases.
5. State measurable success criteria and pre-mortem risks.
6. End with open decisions and a reviewer audit checklist.
