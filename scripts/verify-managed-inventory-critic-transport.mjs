// Synthetic transport input only; this creates no live review or authority.
import assert from 'node:assert/strict';
import {classifyManagedReviewFinalEnvelope} from '../packages/main/dist/core/host-run.js';

const files = ['docs/requirements/inventory.md'];
const proposal = {
  schemaVersion: 'lattice.managed_review_final_proposal.v1',
  storyId: 'B-fixture', providerAgent: 'proof-or-stop-review-topology-critic',
  lane: 'proof-or-stop-review-topology-critic', reviewRunId: 'B-fixture:RR-001',
  conclusion: 'pass', note: 'The bounded fixture inventory has complete terminal evidence.',
  readManifest: {filesReadFully: files, filesTriagedByName: [],
    candidateSpecSetDigest: 'fixture-candidates', corpusDigest: 'fixture-corpus', scanEscalationReason: null},
  readLog: {filesReadFully: files, filesTriagedByName: [], summary: {readCount: 1, tokenCount: null}},
};
const classify = value => classifyManagedReviewFinalEnvelope(JSON.stringify(value)).kind;
assert.equal(classify(proposal), 'valid', 'Existing managed review transport must remain valid');
const inventory = {...proposal, inventoryCritic: {
  epochId: 'B-fixture:RI-001', wave: 1,
  findingDispositions: [{findingId: 'B-fixture:F-001', disposition: 'verified_family',
    familyKey: 'stale-report', reason: 'The signed fixture observation identifies a stale report.'}],
}};
assert.equal(classify(inventory), 'valid', 'MANAGED_INVENTORY_DISPOSITION_TRANSPORT_MISSING');
assert.equal(classify({...inventory, lane: 'proof-or-stop-review-quality',
  providerAgent: 'proof-or-stop-review-quality'}), 'malformed', 'Ordinary reviewers cannot transport critic authority');
for (const invalid of [null, {}, {...inventory.inventoryCritic, wave: 0},
  {...inventory.inventoryCritic, extraAuthority: true},
  {...inventory.inventoryCritic, findingDispositions: [{findingId: 'B-fixture:F-001', disposition: 'resolved'}]}]) {
  assert.equal(classify({...proposal, inventoryCritic: invalid}), 'malformed', 'Malformed critic payload must fail closed');
}
console.log('MANAGED_INVENTORY_CRITIC_TRANSPORT_PARSER_GREEN');
