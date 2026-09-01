/**
 * B-45a0: regression controls for the pre-review semantic matcher's strict mode.
 *
 * `requireRegisteredBinding` exists to police BORROWING -- cloning an executed
 * canonical record onto a different assertion ID.  It must NOT reject a row that
 * was executed under its own ID against its own sourceRef, because an active
 * topology larger than the registered canonical catalog executes every assertion
 * for real instead of projecting from a canonical case.
 *
 * The negative controls are the point of this file: if the borrow path ever
 * stops failing closed, the anti-borrowing guarantee is gone and these assertions
 * must fail.
 */
import assert from 'node:assert/strict';
import { preReviewCaseSemanticMatches } from '../core/pre-review-live-proof.js';
import type { PreReviewCaseRecordV1 } from '../core/types.js';

const exactRow: PreReviewCaseRecordV1 = [
  'positive-9', 'positive',
  'active-positive:positive-9', 'active-positive-verifier:positive-9',
  'execute direct acceptance_topology_check and acceptance_rollout_report_read',
  'PASS', 'PASS', true, [], 'intent:CHK-009:happy:0',
];

// An unregistered sourceRef executed under its own identity borrows nothing.
assert.equal(
  preReviewCaseSemanticMatches(exactRow, exactRow[9], true), true,
  'a row executed under its own sourceRef is accepted in strict mode',
);

// NEGATIVE CONTROL: retargeting that same row onto another assertion's sourceRef
// is exactly what the borrow path does, and must still fail closed.
assert.equal(
  preReviewCaseSemanticMatches(exactRow, 'intent:CHK-011:happy:0', true), false,
  'strict mode refuses a record retargeted onto a different assertion sourceRef',
);

// The lenient path is unchanged: it is used for the adapter's exact lookup.
assert.equal(
  preReviewCaseSemanticMatches(exactRow, 'intent:CHK-011:happy:0', false), true,
  'non-strict mode keeps its pre-existing lenient behavior',
);

// NEGATIVE CONTROL: a REGISTERED sourceRef is still held to its canonical
// target/mutationKind/operation, so the relaxation cannot launder a fake row.
const forgedRegistered: PreReviewCaseRecordV1 = [
  'positive-1', 'positive', 'WRONG-target', 'WRONG-kind', 'WRONG-operation',
  'PASS', 'PASS', true, [], 'intent:CHK-001:happy:0',
];
assert.equal(
  preReviewCaseSemanticMatches(forgedRegistered, forgedRegistered[9], true), false,
  'a registered sourceRef with mismatched semantics is refused',
);
assert.equal(
  preReviewCaseSemanticMatches(forgedRegistered, forgedRegistered[9], false), false,
  'a registered sourceRef is refused in non-strict mode too',
);

console.log('pre-review semantic binding smoke PASS');
