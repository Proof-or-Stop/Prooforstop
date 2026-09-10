import assert from 'node:assert/strict';
import { computeNextStep } from '../packages/main/dist/handlers/session.js';
const base = { storyId: 'B-guidance', phase: 'REVIEW', checklist: null,
  hasUnderstanding: true, hasDecision: true, bugs: null, hasTestEvidence: false,
  hasPassingTestEvidence: false, testPassedAt: null, gitReady: true,
  configuredGitRootResolved: false, donePrecheck: null,
  reviewerStatus: { totalBlockers: 0, allPassed: true, entries: [] } };
assert.match(computeNextStep(base), /review_inventory_begin/, 'PRE_CERT guidance must begin inventory before TEST');
assert.match(computeNextStep({ ...base, reviewInventoryState: 'OPEN' }), /review_inventory_status/);
assert.match(computeNextStep({ ...base, reviewInventoryState: 'FINALIZED' }), /--focus=fast --json.*certification_window_begin/);
for (const state of ['ADMITTED', 'RUNNING', 'FINALIZED']) {
  const next = computeNextStep({ ...base, reviewInventoryState: 'FINALIZED', certificationWindowState: state });
  assert.match(next, /certification_window_status/, `existing ${state} window must be inspected before starting another`);
  assert.doesNotMatch(next, /certification_window_begin/);
}
for (const hasTestEvidence of [false, true]) {
  const next = computeNextStep({ ...base, phase: 'TEST', hasTestEvidence });
  assert.match(next, /phase=DEV/);
  assert.doesNotMatch(next, /Next:.*proof-or-stop validate/);
}
const blocked = computeNextStep({ ...base, reviewInventoryState: 'FINALIZED', reviewerStatus: {
  totalBlockers: 1, allPassed: false, entries: [{ name: 'quality', blockerCount: 1 }] } });
assert.match(blocked, /phase=DEV/);
assert.doesNotMatch(blocked, /certification_window_begin/);
console.log('PASS PRE_CERT guidance matches gate sequence');
