/** Exact review storage surface; never sweep unrelated staged files or Story authoring. */
export const REVIEW_EPOCH_COMMIT_ARTIFACTS = [
  'review-runs.json', 'prompt-envelopes.json', 'review-passes.json',
  'findings.json', 'finding-ledger.json', 'review-inventory-epochs.json',
  'convergence-progress.json', 'process-events.jsonl', 'process-metrics.json',
] as const;

/** Missing snapshots are designed refusals, not reader-health anomalies. */
export function isMissingReviewSnapshotError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (
    ('code' in error && error.code === 'ENOENT')
    || ('stderr' in error && /fatal: path .* (?:does not exist|exists on disk, but not) in/.test(String(error.stderr)))
  ));
}
