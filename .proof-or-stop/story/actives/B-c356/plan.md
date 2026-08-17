## CHK-001
Update `packages/main/templates/agents/lattice-review-quality.md` with a narrow proof metadata rule. The rule must say that server-authored proof keys must be reviewed in both `job.metadata` and linked `run.metadata`, and that one location cannot stand in for the other.

## CHK-002
Extend `packages/main/src/tasks/prompt-registry-smoke.ts` so the quality reviewer prompt must contain the job metadata phrase, linked run metadata phrase, server-authored proof key phrase, and the one-location-insufficient warning.

## CHK-003
Create `experiments/baselines/lattice-workflow-efficiency-baseline-v1-B-c356-proof-metadata-review-coverage-result.json` as a derived comparison result. It must reference the immutable baseline id and B-c356, and it must not claim reviewer guidance is receipt-backed production proof.

## Verification
Run `npm --prefix packages/main run build`, `node packages/main/dist/tasks/prompt-registry-smoke.js`, and focused/full story validation as required by Lattice gates. Add verificationEvidence for all checklist intents after commands pass and commit the code before moving to REVIEW.
