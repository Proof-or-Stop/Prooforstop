import { assertCanonicalActiveIdentityBoundary } from './runtime-environment-checks.js';

const EXPECTED_ACTIVE_IDENTITIES: Readonly<Record<string, string>> = Object.freeze({
  'acceptance-amendment-review': ['proof-or-stop', '.acceptance_amendment_review_final.v1'].join(''),
  'candidate-spec-routing': ['proof-or-stop', '.corpus-index.v1'].join(''),
  'certification-window': ['proof-or-stop', '.certification_window.v1'].join(''),
  'review-incremental-context': ['proof-or-stop', '.impact-classification.v1'].join(''),
  'review-inventory-epoch': ['proof-or-stop', '.review_inventory_epochs.v1'].join(''),
  'learning-source-lineage': ['proof-or-stop', '.source-lineage-audit.v1'].join(''),
  'playbook-runtime-memory': ['proof-or-stop', '.memory-pack.v1'].join(''),
  'lifecycle-control': ['proof-or-stop', '.queue_governance_status.v1'].join(''),
  'milestone-status': ['proof-or-stop', '.milestone_status.v1'].join(''),
  'process-fact-registry': ['proof-or-stop', '.candidate-spec-set.v1'].join(''),
  'prompt-runtime': ['proof-or-stop', '.prompt-registry.v1'].join(''),
  'claim-admissibility-pack': ['proof-or-stop', '.claim_admissibility_pack.v1'].join(''),
  'artifact-release-ledger': ['proof-or-stop', '.artifact-release.v1'].join(''),
  'capability-release-ledger': ['proof-or-stop', '.product-capability-release.v1'].join(''),
});

export function assertActiveIdentityConsumerContract(boundary: string, actual: string, projectRoot?: string): void {
  const expected = EXPECTED_ACTIVE_IDENTITIES[boundary];
  if (!expected) throw new Error(`unregistered active identity consumer boundary: ${boundary}`);
  // Name the exact changed source site before the representative value check.
  // Both checks still run before the consumer performs its operation.
  assertCanonicalActiveIdentityBoundary({ boundaryId: boundary, projectRoot });
  if (actual !== expected) {
    throw new Error(
      `${boundary} consumer rejected active identity ${JSON.stringify(actual)}; expected exact ${expected}`,
    );
  }
}
