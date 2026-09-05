# B-212f Execution Plan

## CHK-001

Materialize the already reviewed executable parity test at packages/main/tests/red/red-done-prepare-done-parity.mjs. Preserve both reviewed RED parity assertions unchanged, then add the missing read-only acceptance checks: capture reviewer evidence bytes and git status immediately before and after buildDoneClosureRunbook evaluates the stale pass, and assert byte-for-byte/state equality. Register the exact command in proof-or-stop.config.json so validation owns it. Run it against the untouched Story baseline and retain the expected two-parity-failure RED before editing production code; the new read-only controls may already pass and do not replace the two RED assertions.

Verification:
- The control assertions prove real DONE rejects both invalid states.
- The two parity assertions fail only because done_prepare lacks the two rows.
- The read-only assertions prove runbook evaluation does not rewrite reviewer evidence or git state.
- The test is registered and is not a source-string-only check.

Rollback:
- Revert only the test and its configuration registration if the fixture is shown not to reproduce the reviewed behavior; do not weaken either asserted DONE outcome.

## CHK-002

Update packages/main/src/core/done-oracle.ts to call readDevMemoryFinishDecision and evaluateReviewVerdict while assembling the shared checklist consumed by done_closure and done_prepare. Add one finish-decision row and one reviewer-verdict row. Map review_evidence_invalid to stale_closeout_review and preserve every other reviewer verdict code. Keep the inspection path read-only.

Verification:
- Missing finish decision produces missing_dev_memory_finish_decision on both surfaces.
- Live diff-pack drift produces diff_pack_changed and stale_closeout_review on both surfaces.
- Reviewer evidence bytes and git state remain unchanged by runbook evaluation.
- Combined execution proves the registered RED, both shared predicates, and the read-only guarantee in one fixture.

Rollback:
- Revert the two checklist rows and imports as one unit if they introduce a lifecycle regression; the real DONE predicates in machine.ts remain protected and unchanged.

## CHK-003

Register the two consumed predicates as L4 process facts, update scripts/verify-process-fact-contract.mjs, extend flow-stability coverage, and amend the done_prepare decision document so the supported contract states that readiness consumes the same finish-decision and reviewer-verdict predicates as DONE.

The verifier must also enforce a generic omission contract: extract every literal machine-readable blocker code in the targetPhase DONE branch in machine.ts, require each code to have an explicit mapping to a done-oracle row in the process-fact registry, require each mapped row to exist in done-oracle.ts, and run an in-memory mutation self-check that inserts future_done_predicate and confirms the inventory rejects it until mapped. This converts the future-predicate promise into a concrete mechanical rule instead of merely pinning the two current predicates. The dynamic reviewer-verdict-code branch remains represented by the shared review-verdict row and its explicit contract entry.

During implementation and review, classify every new defect by applicability and gate impact before changing scope. Repair a verified applicable critical/high defect, and repair any verified defect introduced or worsened by this Story or directly blocking its acceptance, core result, compatibility promise, protected surface, or lifecycle-gate truth. A verified non-applicable critical/high defect may leave only with strong current-gate nonblocking evidence and a traceable owner or route. For an otherwise eligible unrelated nonblocking low/medium defect, retain reproduction, evidence, impact, recommendation, and a traceable finding/gap/backlog owner; do not expand scope. Reassess immediately if later evidence changes applicability or gate impact.

Verification:
- node scripts/verify-process-fact-contract.mjs prints DONE/preflight predicate inventory parity passed and Process-fact contract verification passed.
- Its in-memory future_done_predicate mutation is rejected by the same inventory function used on repository sources.
- npm --prefix packages/main run test:flow-stability-smoke prints flow stability smoke passed.
- The executable parity test remains GREEN after all contract and documentation changes.

Rollback:
- Revert registry, verifier, flow-smoke, and documentation changes together if the mechanical contract is incorrect; never retain documentation that claims enforcement without the matching executable guard.

## CHK-004

Repair the tool-executed verification path that matched selectors against the 12000-character runValidationCommand presentation window. Keep the public routine-validation result bounded, but give the private pinned-evidence consumer complete ANSI-stripped output for selector matching and digest calculation. Continue persisting only the existing 4000-character outputTail. Extend packages/main/src/tasks/tool-executed-evidence-receipt-smoke.ts with RED/GREEN coverage for a marker beyond the presentation window, digest binding to complete output, bounded persisted tail, genuine selector absence, and unchanged routine-output bounding.

Verification:
- Before the fix, the long-output fixture fails with INT-BEYOND-WINDOW [receipt_selector_absent].
- After the fix, npm --prefix packages/main run test:tool-executed-evidence-receipt-smoke prints tool-executed evidence receipt smoke passed.
- The stored outputTail remains exactly bounded while the digest and selector result bind complete output.
- A genuinely absent selector is still rejected and public routine validation output remains capped.

Rollback:
- Revert validation-executor.ts and the corresponding smoke assertions together if private complete-output capture changes public validation behavior or persistence bounds.
