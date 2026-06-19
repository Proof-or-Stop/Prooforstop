# Plan: B-fc82 review_run_start preflight ordering

## CHK-001

Move the existing material-source clean-tree preflight block in packages/main/src/handlers/review-run.ts so it runs immediately after the REVIEW phase check and before lane/prompt resolution plus captureReviewRunSnapshot. Keep the same readGitStatusLines, classifyGitStatusRows, classifierOptionsForCheck, isBlockingDirty, and blocking error wording. Update the nearby fail-open comment so it describes proceeding to snapshot only after the preflight decision.

Verification for this item is the targeted review-run clean-tree preflight smoke plus TypeScript build.

## CHK-002

Strengthen packages/main/src/tasks/review-run-clean-tree-preflight-smoke.ts with an end-to-end ordering assertion. The dirty-tree scenario must prove that review_run_start returns the preflight "uncommitted ... changes" error and does not persist a reviewer run. The assertion should be strong enough that placing captureReviewRunSnapshot before the preflight would fail through observable CLI output or artifact state.

Verification for this item is the strengthened smoke itself, plus the broader field regression smoke to catch review-run side effects.
