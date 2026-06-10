# B-ce79 Plan: Formal unlock Layer 2 Engineering Baseline

## Operating Rules

- Implement only the formal Layer 2 Engineering unlock path described in docs/requirements/decisions/unlock-layer2-ENG-suite.md.
- Keep diagnostic baseline_run and diagnostic capability_claim_evaluate behavior non-authoritative unless a formal gate-consumed path is explicitly added and tested.
- Fail closed for missing, stale, local-only, malformed, mismatched, or insufficiently bound proof.
- Do not unlock Loop Engineering, Production Safety, or global Capability Claim.
- Use Claude CLI and Codex CLI as host review evidence; do not treat host verdict text as Authority.

## CHK-001 Freeze Layer 2 suite schema and proof root

Implementation:
- Inspect the current baseline final-report and suite-report schema in packages/main/src/core/lattice-baseline.ts.
- Define or tighten only the fields needed for formal Layer 2 proof: baselineId, suiteRunId, claimTarget, headHash, materialHash, evidence refs, review refs, gate refs, and receipt refs.
- Keep the selected artifacts root explicit and consistent across per-baseline reports, lower-layer proof, suite report, and claim evaluation.

Verification:
- Positive: all nine ENG baseline IDs and required binding fields are represented.
- Negative: unsupported IDs, missing binding fields, or mixed-layer artifacts are rejected.

Stop condition:
- If this requires a broader schema redesign, stop and keep the existing diagnostic path blocked instead of inventing a new framework.

## CHK-002 Pin or ingest Layer 1 Development proof into the selected artifacts root

Implementation:
- Locate the existing Layer 1 Development suite proof or create a digest-pinned projection in the selected artifacts root.
- Ensure Engineering suite aggregation reads the Development proof from that root or from an explicitly pinned digest reference.
- Preserve freshness and materialHash checks.

Verification:
- Positive: fresh Development proof allows Engineering suite evaluation to proceed.
- Negative: missing, stale, malformed, or mismatched Development proof keeps the Engineering suite BLOCKED.

Stop condition:
- If no valid Layer 1 proof can be found or produced, Layer 2 must remain locked.

## CHK-003 Build the formal proof-producing path for Engineering final reports

Implementation:
- Add or tighten a formal report writer/ingester only where current diagnostic output cannot satisfy the decision doc.
- Formal reports may set localOnly=false and capabilityProof=true only after lower-layer proof, evidence refs, host review refs, gate refs, and required receipt refs validate.
- Preserve baseline_run as diagnostic-only unless a separate formal mode is mechanically gated.

Verification:
- Positive: formal path emits accepted reports with capabilityProof=true and localOnly=false only after validation.
- Negative: callers cannot force formal flags without the required proof inputs.

Stop condition:
- If receipt/gate validation cannot be made mechanical, keep formal reports blocked.

## CHK-004 Execute all nine Engineering baselines through formal proof production

Implementation:
- Run or generate formal proof output for ENG-MULTI-FILE-1, ENG-EXISTING-REPO-1, ENG-BUGFIX-1, ENG-REGRESSION-1, ENG-DATA-MIGRATION-1, ENG-AUTH-SECURITY-1, ENG-FRONTEND-VISUAL-1, ENG-LONG-RUN-1, and ENG-LOOP-REVIEW-1.
- Expected-block baselines must use EXPECTED_BLOCK only with refusal/gate evidence.
- Expected-pass baselines must not be marked PASS from diagnostic-only artifacts.

Verification:
- Positive: all nine required baseline IDs are covered by supported formal outcomes.
- Negative: skipped, failed, inconsistent, or fake PASS baseline reports prevent suite PASS.

Stop condition:
- Any unproven baseline blocks Layer 2 unlock.

## CHK-005 Verify and consume Authority receipt refs with baseline and claim binding

Implementation:
- Verify receipt refs or canonical gate input digest binding to story, phase, baselineId, suiteRunId, claimTarget, headHash, materialHash, evidence digests, and run bindings.
- Reject receipts from another baseline, suite run, claim target, head, material hash, or evidence set.
- Do not convert receipt verification into productionDone.

Verification:
- Positive: correctly bound production-classified receipts are accepted as proof refs.
- Negative: stale, local diagnostic, missing, or mismatched receipts fail closed.

Stop condition:
- If only local diagnostic receipt state is available, keep the formal unlock blocked.

## CHK-006 Generate Engineering suite report from formal reports

Implementation:
- Use the selected artifacts root to collect only fresh formal Engineering reports.
- Require all nine baselines and fresh lower-layer proof.
- Reject localOnly=true, capabilityProof=false, stale materialHash, malformed schema, mixed layer, missing lower-layer proof, and inconsistent status/outcome combinations.

Verification:
- Positive: complete valid formal report set yields suiteStatus=PASS, authorization=authorized, capabilityProof=true, localOnly=false.
- Negative: any invalid report or missing proof yields BLOCKED with explicit reasons.

Stop condition:
- Do not patch around suite blockers by weakening validation.

## CHK-007 Run formal Layer 2 claim evaluation or block if only diagnostic evaluator exists

Implementation:
- Check whether a formal Layer 2 evaluator exists. If not, add the smallest formal evaluator path that consumes the formal Engineering suite proof and receipt/gate bindings, or preserve a fail-closed blocked result.
- Keep existing diagnostic capability_claim_evaluate clearly non-authoritative unless formal mode is structurally distinct and tested.
- Authorized claim scope must be exactly Layer 2 Engineering Baseline.

Verification:
- Positive: valid formal suite proof unlocks only Layer 2 Engineering.
- Negative: diagnostic-only proof, malformed suite proof, or higher-layer target returns NOT_AUTHORIZED/BLOCKED.

Stop condition:
- If formal claim evaluation cannot mechanically distinguish diagnostic vs formal proof, do not unlock.

## CHK-008 Verify higher layers remain locked

Implementation:
- Test Loop Engineering, Production Safety, and global Capability Claim requests after Engineering proof exists.
- Ensure Engineering receipts or suite reports cannot satisfy higher-layer prerequisites.
- Keep output wording explicit that Layer 2 does not mean unattended or production-grade capability.

Verification:
- Positive: Layer 2 Engineering can unlock when proof passes.
- Negative: Layer 3, Layer 4, and Layer 5/global claims remain not_authorized without their own proof.

Stop condition:
- Any higher-layer accidental unlock is a blocker and must be fixed before DONE.
