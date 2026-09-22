#!/usr/bin/env node
import assert from 'node:assert/strict';

import * as managedReviewEvidence from '../core/managed-review-evidence.js';

const buildPack = (managedReviewEvidence as unknown as {
  buildManagedInventoryCriticEvidencePack?: (args: Record<string, unknown>) => {
    reviewRuns: Array<{ reviewRunId: string }>;
    findings: Array<{ id: string }>;
    passes: Array<{ id: string }>;
  };
}).buildManagedInventoryCriticEvidencePack;

assert.equal(
  typeof buildPack,
  'function',
  'managed inventory critic receives current signed uncommitted inventory metadata in its sealed prompt',
);

const binding = {
  epochId: 'B-test:RI-001',
  reviewRound: '2026-09-10T00:00:00.000Z',
  wave: 1,
  cutoff: { headHash: 'a'.repeat(40), materialHash: 'b'.repeat(64), storyFilesHash: 'c'.repeat(64) },
  runSequenceBoundary: 10,
};
const criticRun = {
  reviewRunId: 'B-test:RR-013', storyId: 'B-test', agent: 'proof-or-stop-review-topology-critic',
  lane: 'proof-or-stop-review-topology-critic', reviewRound: binding.reviewRound,
  headHash: binding.cutoff.headHash, materialHash: binding.cutoff.materialHash,
  storyFilesHash: binding.cutoff.storyFilesHash, reviewPurpose: 'inventory-completeness', inventoryBinding: binding,
};
const currentRun = {
  reviewRunId: 'B-test:RR-011', storyId: 'B-test', agent: 'proof-or-stop-review-quality',
  lane: 'proof-or-stop-review-quality', reviewRound: binding.reviewRound,
  headHash: binding.cutoff.headHash, materialHash: binding.cutoff.materialHash,
  storyFilesHash: binding.cutoff.storyFilesHash,
};
const metadataOnlyHeadRun = {
  ...currentRun,
  reviewRunId: 'B-test:RR-012',
  headHash: 'd'.repeat(40),
};
const staleRun = { ...currentRun, reviewRunId: 'B-test:RR-009' };
const epoch = { epochId: binding.epochId, storyId: 'B-test', state: 'OPEN', reviewRound: binding.reviewRound,
  cutoff: binding.cutoff, requiredLanes: ['proof-or-stop-review-quality'] };

const pack = buildPack!({
  criticRun,
  epoch,
  reviewRuns: [staleRun, currentRun, metadataOnlyHeadRun, criticRun],
  findings: [
    { id: 'B-test:F-001', reviewRunId: staleRun.reviewRunId },
    { id: 'B-test:F-002', reviewRunId: currentRun.reviewRunId },
    { id: 'B-test:F-003', reviewRunId: metadataOnlyHeadRun.reviewRunId },
  ],
  passes: [
    { id: 'B-test:RP-001', reviewRunId: currentRun.reviewRunId },
    { id: 'B-test:RP-003', reviewRunId: metadataOnlyHeadRun.reviewRunId },
    { id: 'B-test:RP-002', reviewRunId: criticRun.reviewRunId },
  ],
});

assert.deepEqual(pack.reviewRuns.map(row => row.reviewRunId), [currentRun.reviewRunId, metadataOnlyHeadRun.reviewRunId],
  'critic pack must retain the same metadata-only HEAD drift admitted by inventory wave evaluation');
assert.deepEqual(pack.findings.map(row => row.id), ['B-test:F-002', 'B-test:F-003']);
assert.deepEqual(pack.passes.map(row => row.id), ['B-test:RP-001', 'B-test:RP-003']);

console.log('INVENTORY_CRITIC_LIVE_METADATA_PROJECTION PASS');
