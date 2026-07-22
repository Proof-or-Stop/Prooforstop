# B-4ec1 Wave 3 executable pre-review gate

## Outcome

A complete current worktree prints `Pre-review check: PASS plannedActual=complete executableEvidence=current mutations=biting transcript=related authority=admissible`. Removing a topology mapping that remains in the recomputed basis prints `Pre-review check: FAIL code=AT_UNMAPPED_SCOPE_REF` and enforce mode blocks DEV-to-REVIEW.

## CHK-001

Define a verifier-owned signed pre-review artifact and read-only report. Bind story, plan and pre-review basis digests, topology, scope, story and closure hashes, canonical executable evidence refs, transcript relation, mutation polarity, authority, freshness, issuance and signature. Register CLI schema, handler, store path and process facts. Every field must be recomputed or verified.

## CHK-002

Regenerate `AcceptanceCoverageBasisV1` with `phaseBasis=pre_review` from the current worktree and bind `priorPlanBasisDigest`. Reconcile every typed planned path to actual discovered paths as exact, expanded or independently approved replaced. Reject missing, partial, unsupported, stale or tampered adapter results. Prove the topology-only omission mutation by retaining the basis path and removing its mapping.

## CHK-003

Resolve canonical verificationEvidence refs from the checklist, require passing and fresh command-backed evidence, link manual transcript evidence to the canonical live transcript when applicable, and verify admissible signed authority. Require clean control, adverse mutation bite and exact restoration. A caller must not submit inventory, verdict, authority, relation or freshness fields.

## CHK-004

Call the shared evaluator before `actor.send` for DEV-to-REVIEW. Observe and warn render deterministic diagnostics without blocking; enforce blocks when the canonical report is not PASS. Update process-fact registry and contracts, CLI docs and the approved decision document. Focused production smoke must prove CLI and lifecycle parity, legacy compatibility, rollback, restoration and absence of Wave 3A selective applicability or Wave 4 measured rollout.

## Verification order

Build once, run the focused production smoke, run process-fact contract and prompt baseline if role guidance changes, record all verificationIntent evidence on the same current storyFilesHash, then enter REVIEW for four independent lanes and full 3x2 quorum. TEST runs fresh validate and DONE-required policy before done_prepare.
