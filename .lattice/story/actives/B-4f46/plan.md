# B-4f46 Execution Plan — Experience Layer Phase 1b (finding outcome enums + signature-registry)

Additive, optional, audit-only finding outcome fields + a signature-registry, so
Phase 1a signals become meaningful. No gate reads the new fields; legacy callers
unchanged; new fields stay out of the finding signature.

## CHK-001 Audit-only Finding type fields
`types.ts` Finding: add optional `signatureTag?: string`,
`resolutionType?: 'fixed'|'duplicate'|'superseded'|'accepted_risk'|'partially_mitigated'`,
`dismissReasonType?: 'false_positive'|'out_of_scope'|'duplicate'|'wontfix'|'unclear'|'already_covered'`,
`resolveEvidenceStrength?: 'strong'|'medium'|'weak'`, `dismissEvidenceStrength?` (same enum).
Each annotated `// audit-only — MUST NOT be read by any gate`. Excluded from the
finding signature domain.
Verification: build clean; finding-verify signing unchanged (legacy finding verifies).

## CHK-002 Capture + back-compat
`cli-engine.ts` schemas: finding_add += signatureTag? ; finding_resolve +=
resolutionType?/resolveEvidenceStrength? ; finding_dismiss +=
dismissReasonType?(OPTIONAL)/dismissEvidenceStrength?. `finding.ts` handlers:
validate enums (reuse the evidenceState validation pattern), store the fields.
Omitting any field => identical legacy behavior.
Verification: smoke captures + persists fields; field-less calls unchanged;
invalid enum rejected with a clear error.

## CHK-003 Signature-registry + minimal CLI + gate-exclusion guardrail
`learning-store.ts`: read/write `.lattice/learning/signature-registry.json`
(tags:{tag,status:active|proposed|deprecated,aliases,mergedInto,createdBy,approvedBy}).
finding_add with a new signatureTag auto-records it status=proposed. New handler
`signature-registry.ts` + cli-engine/registry entries: `signature_registry_list`
and `signature_registry_set --action=propose|approve|alias|deprecate` (active
requires explicit approve). Guardrail: advisory.ts / gate logic never read any
audit field.
Verification: smoke proposes/approves/aliases tags; advisory gate decision is
identical with vs without the audit fields.

## CHK-004 Smoke + npm script + no regression
`tasks/experience-layer-finding-enums-smoke.ts` + package.json
`test:experience-layer-finding-enums`. Hermetic. Assert: capture + enum
validation; legacy migration tolerance; audit fields not read by advisory gate;
signature-registry propose/approve/alias/mergedInto; finding-signals yields
non-zero signalScore when enums present; existing finding/usage-ledger smokes
still pass.
Verification: npm script exits 0 'smoke passed'; verifier TOTAL N | PASS N | FAIL 0.

## Out of scope
Reviewer-prompt hint injection (Phase 1.5); playbook lifecycle (Phase 2); any
gate consumption of the new fields; cross-project aggregation.
