import assert from 'node:assert/strict';
import { buildFullTaskContext } from '../core/prompt-envelope.js';
import { buildStory6ABReceipts } from './story6-ab-dispatch.js';

const taskContext = buildFullTaskContext({
  story: { storyId: 'B-story6-ab', title: 'A/B', description: 'A/B', phase: 'DEV', priority: 'high' } as any,
  checklist: { items: [{ id: 'CHK-001', title: 'A/B', status: 'in_progress', relatedDocs: [], files: { modify: [], create: [], test: [] }, verificationIntent: { happy: [], edge: [], adversarial: [] } }] } as any,
  headHash: 'a'.repeat(40),
});
const receipts = buildStory6ABReceipts(taskContext);
assert.equal(receipts.length, 10);
for (const roleId of [...new Set(receipts.map(receipt => receipt.roleId))]) {
  const arms = receipts.filter(receipt => receipt.roleId === roleId);
  assert.deepEqual(arms.map(receipt => receipt.arm), ['legacy', 'modular']);
  assert.ok(arms.every(receipt => receipt.outcome === 'INCONCLUSIVE'));
  assert.ok(arms.every(receipt => receipt.providerUsage.availability === 'unavailable'));
  assert.ok(arms.every(receipt => receipt.assembledPromptTokens > 0));
}
console.log(`story6-ab-dispatch-smoke: PASS (${receipts.length} local receipts; provider dimensions INCONCLUSIVE)`);
