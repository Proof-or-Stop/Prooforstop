import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const digest = value => createHash('sha256').update(value).digest('hex');

export function validateSelectorReceiptCore(receipt, selector, current, currentFileDigests, headAdmissible) {
  assert.equal(receipt.schema, 'b9812.full-suite-contract-capture.v2');
  assert.equal(headAdmissible(receipt.head, current.head), true, 'capture HEAD is not an admissible metadata-only ancestor');
  assert.equal(receipt.material, current.material, 'capture material changed');
  assert.deepEqual(receipt.fileDigests, currentFileDigests, 'captured artifact or verifier source digest changed');
  assert.ok(Object.hasOwn(receipt.predicates, selector), `selector missing from capture: ${selector}`);
  assert.equal(receipt.predicates[selector].passed, true, `selector predicate did not pass: ${selector}`);
  assert.equal(receipt.predicates[selector].outputDigest, digest(`VERIFIED ${selector}`), `selector predicate digest changed: ${selector}`);
}
