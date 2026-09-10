import { resolve } from 'node:path';

import { currentMaterialHash, currentStoryFilesHash } from '../../src/core/evidence-freshness.ts';
import { evaluateReviewVerdict } from '../../src/core/machine.ts';
import { verifyReviewInventoryReceipt } from '../../src/core/review-inventory-epoch.ts';
import { StoryStore } from '../../src/core/store.ts';

const storyId = 'B-03b7';
const targetRoot = resolve(process.argv[2] || '');

if (!process.argv[2]) {
  console.error('BROKEN: expected the B-03b7 worktree path');
  process.exit(2);
}

const store = new StoryStore(targetRoot);
const story = store.readStory(storyId);
const inventory = store.readReviewInventoryEpochs(storyId);
const receipt = [...inventory.receipts]
  .reverse()
  .find((candidate) => !candidate.consumedAt && candidate.reviewRound === story.currentReviewRound);

if (!receipt || !verifyReviewInventoryReceipt(receipt)) {
  console.error('BROKEN: expected one valid unconsumed finalized inventory receipt');
  process.exit(2);
}

const materialHash = currentMaterialHash(targetRoot, 'HEAD', targetRoot);
const storyFilesHash = currentStoryFilesHash(targetRoot, 'HEAD', targetRoot);
if (receipt.cutoff.materialHash !== materialHash || receipt.cutoff.storyFilesHash !== storyFilesHash) {
  console.error('BROKEN: receipt cutoff is not fresh for material and Story-owned files');
  process.exit(2);
}

const verdict = evaluateReviewVerdict({ storyId, store, projectRoot: targetRoot, gitCwd: targetRoot });
if (!verdict.ok) {
  console.error(`SEALED_REVIEW_PASS_FINALIZATION_RED ${verdict.code}: ${verdict.message}`);
  process.exit(1);
}

console.log(`SEALED_REVIEW_PASS_FINALIZATION_GREEN ${receipt.receiptId}`);
