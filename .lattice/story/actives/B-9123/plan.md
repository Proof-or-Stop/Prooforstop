# B-9123 Wave 2A Independent Topology Critic Plan

## CHK-001

Define a least-privilege eligibility policy for the dedicated topology critic and exclusion approver. Reuse canonical reviewer identity, workspace, dispatch, session, and commit provenance readers. Mechanical checks must reject any overlap with the implementer across agent, session, dispatch authorship, or business commit authorship; prompt labels cannot satisfy independence.

## CHK-002

Implement a dedicated signed TopologyCriticReceiptV1 producer and canonical verifier. The signed payload binds Story, critic identity and eligible role, basis and topology digests, scope check and phase-applicable scope contract digests, storyFilesHash, closureFilesHash, findings, approved exclusions, verdict, issuance time, and signature. Register CLI schemas, read-only inspection, writer policy, artifact ownership, freshness, and process facts.

## CHK-003

Implement separately attributable exclusion approval owned by lattice-review-scope-plan and consumed by critic verification. Exclusions must bind current scope and material. Critic or approver verdicts may challenge or confirm only a complete verifier-derived basis and can never upgrade missing, partial, unsupported, stale, or tampered discovery.

## CHK-004

Add a focused compiled production-path smoke and process-fact mutation campaign. Prove eligible clean acceptance, all identity and receipt field tampering, stale material/scope/closure, forged or missing exclusion approval, incomplete basis fail-closed, deterministic CLI text/JSON output, exact restoration, and prompt/handler/verifier/gate contract bites. Preserve the Wave 2A boundary: no pre_review_check, executable evidence, selective applicability, measured rollout, Authority DONE, or production-readiness claim.
