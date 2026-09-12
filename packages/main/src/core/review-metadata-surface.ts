/** Exact review storage surface; never sweep unrelated staged files or Story authoring. */
export const REVIEW_EPOCH_COMMIT_ARTIFACTS = [
  'review-runs.json', 'prompt-envelopes.json', 'review-passes.json',
  'findings.json', 'finding-ledger.json', 'review-inventory-epochs.json',
  'convergence-progress.json', 'process-events.jsonl', 'process-metrics.json',
] as const;

