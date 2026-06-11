## Expected

User opens `Lattice-lifecycle-memory-Evolving.md` and sees a concrete 100-point memory baseline:

- `HistoricalRetrievalScore = (exact recall@1 + recall@10 + MRR@10 + precision@10) / 4`
- `Expanded MemoryScore = 25 * HistoricalRetrievalScore + 25 * ExactAnswerHit + 25 * EvidenceLinkageRate + 15 * LayerRoutingAccuracy + 10 * ScaleStabilityScore`
- 10,000 / 100,000 / 1,000,000 candidate thresholds
- six memory layer labels, with non-authoritative layers marked boundary-only
- explicit text that MemoryScore is not lifecycle truth, review pass, validation evidence, delivery check, receipt, or production authority

## Actual

The final document contains the `MemoryScore (100-point baseline)` section with helper and expanded formulas, original retrieval thresholds, `staleTruthHit` failure taxonomy, 10k/100k/1M score thresholds, and score-boundary wording.

`koala validate --story=B-4980 --json` passed with 6/6 verification intent coverage, and reviewers confirmed the F-001/F-002/F-003/F-004 corrections.

## Diff

No user-value gap. The user asked to include the screenshot metrics in the score, and the final document includes all four retrieval metrics inside `HistoricalRetrievalScore` while keeping Lattice authority boundaries intact.
