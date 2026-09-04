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

The verifier must also enforce a generic omission contract: extract every literal machine-readable blocker code in machine.ts's targetPhase DONE branch, require each code to have an explicit mapping to a done-oracle row in the process-fact registry, require each mapped row to exist in done-oracle.ts, and run an in-memory mutation self-check that inserts future_done_predicate and confirms the inventory rejects it until mapped. This converts the broad future-predicate promise into a concrete mechanical rule instead of merely pinning the two current predicates. The dynamic reviewer-verdict-code branch remains represented by the shared review-verdict row and its explicit contract entry.

During implementation and review, classify every new defect before scope changes. Repair a critical/high, safety, data-integrity, destructive-compatibility, acceptance-blocking, or lifecycle-gate-truth defect in this Story. For an unrelated nonblocking medium/low defect, retain reproduction, evidence, impact, recommendation, and a traceable finding/gap/backlog owner; do not expand scope. Reassess immediately if later evidence raises severity or makes it blocking.

Verification:
- node scripts/verify-process-fact-contract.mjs prints DONE/preflight predicate inventory parity passed and Process-fact contract verification passed.
- Its in-memory future_done_predicate mutation is rejected by the same inventory function used on repository sources.
- npm --prefix packages/main run test:flow-stability-smoke prints flow stability smoke passed.
- The executable parity test remains GREEN after all contract and documentation changes.

Rollback:
- Revert registry, verifier, flow-smoke, and documentation changes together if the mechanical contract is incorrect; never retain documentation that claims enforcement without the matching executable guard.
