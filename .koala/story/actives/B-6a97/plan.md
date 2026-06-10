# B-6a97 Plan

## CHK-001

Goal: add local independent review evidence for the five expected-PASS Development baseline runs only: NL-CLI-1, NL-API-1, NL-REPAIR-1, RED-CLI-TS-PY-1, and RED-API-TS-GO-1. For each run, create an independent-review artifact set containing one codex verdict and one claude-code verdict, both bound to the run material digest and validation digest. Update local-review-status.json only when both independent hosts pass.

Execution: run Codex-side mechanical inspection and Claude CLI reviewer inspection against the exact run directories. Evidence must cite scenario evidence for NL baselines, parity/source/target artifacts for redevelopment baselines, final-report terminal criteria, and execution logs. Do not touch RED-GAP-BLOCK-1 except to assert it remains EXPECTED_BLOCK and uncertified for PASS.

Stop conditions: stop and BLOCK if any expected-PASS run lacks artifacts, has failing scenario/parity evidence, has stale digest, has only one host verdict, has duplicated host identity, or has review text not tied to the exact run directory.

## CHK-002

Goal: update per-run final-report.json/md and baseline-suite-report.json/md so the Development baseline suite reports PASS because proof exists, not because the gate was weakened.

Execution: after CHK-001 evidence exists, update the five expected-PASS final reports from outcome=FAIL to outcome=PASS, clear blockedReason/failureSummary, set local.localReviewCertified=true/status=certified, and add evidence refs. Re-run lattice baseline_suite_report for B-688d and normalize paths/suiteId to the existing B-688d artifact convention.

Stop conditions: stop and BLOCK if falseDoneCount becomes nonzero, RED-GAP-BLOCK-1 changes away from EXPECTED_BLOCK, blockingFailures are hidden without per-run proof, or terminalCriteriaFailures are introduced.

## CHK-003

Goal: update the parallel-development final report boundary after Layer 1 passes. This may unlock only Layer 1/basic bounded development proof and may allow Baseline 2-5 implementation planning under existing sequential proof locks.

Execution: update final-report and claim-lock/shared-contract references to point at the new baseline suite report and independent review evidence. Keep authorityMode=off, evidenceClass=local-lifecycle, receiptVerified=false, productionDone=false. Keep Engineering/Loop/Production claims locked until their own baselines pass.

Stop conditions: stop and BLOCK if any field or wording claims Authority DONE, receipt-backed evidence, production-grade unattended development, Engineering baseline pass, Loop Engineering pass, or Production Safety pass.

## Global Verification

Run npm test and lattice validate for B-6a97. Run an artifact consistency script that verifies: five expected-PASS certified with codex+claude-code evidence, suiteStatus=PASS, falseDoneCount=0, safetySuccessRate=1, RED-GAP-BLOCK-1 EXPECTED_BLOCK unchanged, shared-contract evidence refs hash-match, and authority boundary remains local-lifecycle.
