# B-212f Execution Plan

## CHK-001

Materialize the already reviewed executable parity test at packages/main/tests/red/red-done-prepare-done-parity.mjs without changing its behavioral assertions. Register the exact command in proof-or-stop.config.json so validation owns it. Run it against the untouched Story baseline and retain the expected two-parity-failure RED before editing production code.

Verification:
- The control assertions prove real DONE rejects both invalid states.
- The parity assertions fail only because done_prepare lacks the two rows.
- The test is registered and is not a source-string-only check.

Rollback:
- Revert only the test and its configuration registration if the fixture is shown not to reproduce the reviewed behavior; do not weaken the asserted DONE outcomes.

## CHK-002

Update packages/main/src/core/done-oracle.ts to call readDevMemoryFinishDecision and evaluateReviewVerdict while assembling the shared checklist consumed by done_closure and done_prepare. Add one finish-decision row and one reviewer-verdict row. Map review_evidence_invalid to stale_closeout_review and preserve every other reviewer verdict code. Keep the inspection path read-only.

Verification:
- Missing finish decision produces missing_dev_memory_finish_decision on both surfaces.
- Live diff-pack drift produces diff_pack_changed and stale_closeout_review on both surfaces.
- Reviewer evidence bytes and git state remain unchanged by runbook evaluation.

Rollback:
- Revert the two checklist rows and imports as one unit if they introduce a lifecycle regression; the real DONE predicates in machine.ts remain protected and unchanged.

## CHK-003

Register the two consumed predicates as L4 process facts, update scripts/verify-process-fact-contract.mjs to require them mechanically, extend flow-stability coverage, and amend the done_prepare decision document so the supported contract states that readiness consumes the same finish-decision and reviewer-verdict predicates as DONE.

During implementation and review, classify every new defect before scope changes. Repair a critical/high, safety, data-integrity, destructive-compatibility, acceptance-blocking, or lifecycle-gate-truth defect in this Story. For an unrelated nonblocking medium/low defect, retain reproduction, evidence, impact, recommendation, and a traceable finding/gap/backlog owner; do not expand scope. Reassess immediately if later evidence raises severity or makes it blocking.

Verification:
- node scripts/verify-process-fact-contract.mjs prints Process-fact contract verification passed.
- npm --prefix packages/main run test:flow-stability-smoke prints flow stability smoke passed.
- The executable parity test remains GREEN after all contract and documentation changes.

Rollback:
- Revert registry, verifier, flow-smoke, and documentation changes together if the mechanical contract is incorrect; never retain documentation that claims enforcement without the matching executable guard.
