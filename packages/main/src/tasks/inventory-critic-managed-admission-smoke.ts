#!/usr/bin/env node
import assert from 'node:assert/strict';

import * as reviewerBatchSubject from '../core/reviewer-batch-subject.js';

const admissionLanes = (reviewerBatchSubject as unknown as {
  reviewerBatchAdmissionLanes?: (requiredLanes: readonly string[], includeInventoryCritic: boolean) => string[];
}).reviewerBatchAdmissionLanes;

assert.equal(
  typeof admissionLanes,
  'function',
  'inventory completeness critic is admitted through the managed reviewer batch after its purpose-bound run starts',
);

const required = [
  'proof-or-stop-review-concept',
  'proof-or-stop-review-quality',
  'proof-or-stop-review-test-coverage',
  'proof-or-stop-review-docs',
];
const critic = 'proof-or-stop-review-topology-critic';

assert.deepEqual(admissionLanes!(required, false), required, 'ordinary inventory waves retain the exact required-lane roster');
assert.deepEqual(
  admissionLanes!(required, true),
  [...required, critic],
  'a purpose-bound inventory critic gets one explicit managed admission lane',
);
assert.equal(
  admissionLanes!([...required, critic], true).filter(lane => lane === critic).length,
  1,
  'critic admission is deterministic and duplicate-free',
);

console.log('INVENTORY_CRITIC_MANAGED_ADMISSION PASS');
