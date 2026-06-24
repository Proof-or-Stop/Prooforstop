# B-0985 Plan: Proof Admissibility Registry MVP

## Scope

Implement the M0/M1 executable slice of `proof-admissibility-hardening-execution-plan.md`: proof surface inventory, shared admissibility domain/registry, classification helper, and focused smoke coverage. This story stays classification-only and does not enforce REVIEW/TEST/DONE/Authority gates.

## CHK-001 Add proof surface inventory docs and machine-readable surface map

Create `docs/evidence/proof-surface-inventory.md` and `.json` from the M0 surface list. Each row records artifact kind, producer boundary, current storage/path, evidence scope, temporal role, allowed consumers, allowed claims, productionDone eligibility, and required follow-up milestone. Include Repro candidate artifacts from B-0aa1, local diagnostic surfaces, local review quorum, authority-receipt-only, and production-gate-decision.

Verification: documentation rows must make non-production scopes explicit and must be machine-checkable from the JSON inventory.

## CHK-002 Implement shared proof admissibility domain and registry

Add `packages/main/src/core/proof-admissibility.ts` with canonical enums/types, stable reason codes, artifact definitions, registry lookup, and helper accessors. The module must fail closed for unknown artifact kinds and must keep authority receipt separate from production gate decision. It should not write files or create a new storage root.

Verification: smoke imports the registry and asserts definitions for required surfaces, stable scope values, and fail-closed unknown behavior.

## CHK-003 Add classification/evaluation helper for proof-looking artifacts

Expose a function that evaluates a candidate artifact definition against a requested consumer/claim/scope. It returns allowed, productionDoneEligible, reasons, and remediation hints. It must deny local diagnostic, evidence candidate, legacy, local-key, local quorum production claims, and receipt-only production claims. It may allow a matching production-gate-decision under the registered policy.

Verification: smoke covers positive and negative evaluations with reason codes: `scope_not_allowed_for_claim`, `local_diagnostic_not_authority`, `authority_receipt_requires_gate_decision`, `legacy_not_strong_admissible`, `unknown_artifact_kind`, and consumer/claim mismatch cases.

## CHK-004 Add smoke tests and process fact registration for admissibility classification

Add `packages/main/src/tasks/proof-admissibility-smoke.ts` and package script `test:proof-admissibility`. If a CLI command is added, register command policy/process facts. Prefer a package script only unless an operator-facing command is necessary for this MVP. Run build, smoke, and process fact contract.

Verification: `npm --prefix packages/main run build`, `npm --prefix packages/main run test:proof-admissibility`, and `node scripts/verify-process-fact-contract.mjs` pass.

## Rollback

Because this slice is additive and classification-only, rollback is to remove the new docs, registry module, package script, and smoke test. No existing gate behavior should depend on this story yet.

## Non-goals

No Authority Server changes, no hard-fail gate rollout, no metadata sanitizer enforcement, no handoff schema migration, no legacy repair command, and no migration of existing signed receipt formats in this story.
