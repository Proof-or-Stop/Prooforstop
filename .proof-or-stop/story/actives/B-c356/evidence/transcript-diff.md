# B-c356 TEST Transcript Diff

Story: B-c356
Scope: proof metadata job-plus-linked-run reviewer guidance.

## Expected

- The quality reviewer prompt requires checking both `job.metadata` and linked
  `run.metadata` when proof metadata semantics are touched.
- The prompt rejects checking only one metadata location as sufficient.
- The prompt/result artifact do not claim receipt-backed production proof.
- The prompt checklist wording is internally consistent after adding item 4.
- The immutable baseline file remains unchanged; only the derived B-c356 result
  artifact records this story's comparison result.

## Actual

`lattice validate --story=B-c356 --json`

- PASS.
- 27/27 configured validation commands passed.
- Verification intent coverage: 9/9 covered, 0 required missing.
- Observed duration: approximately 100.3 seconds.

`node packages/main/dist/tasks/prompt-registry-smoke.js`

```text
✓ prompt registry smoke passed: 16 agents rendered for claude and codex
```

`rg -n "following 3 items|following items|job.metadata|linked run.metadata|receipt-backed production evidence" ...`

- No `following 3 items` match was returned.
- Template and both managed mirrors contain `following items`.
- Template and both managed mirrors contain `job.metadata` and linked
  `run.metadata`.
- Template and both managed mirrors say this guidance must not be described as
  receipt-backed production evidence.

Baseline result parse:

```json
{
  "baselineId": "lattice-workflow-efficiency-baseline-v1",
  "story": "B-c356",
  "dimension": "proofMetadataReviewCoverage",
  "claimsReceiptBackedProductionProof": false,
  "requiresBoth": true
}
```

## Diff Notes

- Expected and actual match.
- The only reviewer finding, `B-c356:F-001`, was fixed by commit `905c9f167`
  and resolved with strong evidence by `lattice-review-quality`.
- No Authority Server business logic, receipt verification logic, or production
  completion semantics were changed.
