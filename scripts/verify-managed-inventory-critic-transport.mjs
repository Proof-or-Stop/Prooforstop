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
    candidateSpecSetDigest: 'a'.repeat(64), corpusDigest: 'b'.repeat(64), scanEscalationReason: null},
  readLog: {filesReadFully: files, filesTriagedByName: [], summary: {readCount: 1, tokenCount: null}, digest: 'c'.repeat(64)},
};
const classify = value => classifyManagedReviewFinalEnvelope(JSON.stringify(value)).kind;
assert.equal(classify(proposal), 'valid', 'Existing managed review transport must remain valid');
const inventory = {...proposal, inventoryCritic: {
  epochId: 'B-fixture:RI-001', wave: 1,
  findingDispositions: [{finding: {findingId: 'B-fixture:F-001'}, disposition: 'verified_family',
    familyKey: 'stale-report', reason: 'The signed fixture observation identifies a stale report.'}],
}};
assert.equal(classify(inventory), 'valid', 'MANAGED_INVENTORY_DISPOSITION_TRANSPORT_MISSING');
assert.equal(classify({...inventory, lane: 'proof-or-stop-review-quality',
  providerAgent: 'proof-or-stop-review-quality'}), 'malformed', 'Ordinary reviewers cannot transport critic authority');
for (const invalid of [null, {}, {...inventory.inventoryCritic, wave: 0},
  {...inventory.inventoryCritic, extraAuthority: true},
  {...inventory.inventoryCritic, findingDispositions: [{finding: {findingId: 'B-fixture:F-001'}, disposition: 'resolved'}]}]) {
  assert.equal(classify({...proposal, inventoryCritic: invalid}), 'malformed', 'Malformed critic payload must fail closed');
}
console.log('MANAGED_INVENTORY_CRITIC_TRANSPORT_PARSER_GREEN');

// Keep the Lab-pinned command and repository validation on the full transport.
const {execFileSync} = await import('node:child_process');
const {fileURLToPath} = await import('node:url');
for (const scenario of ['findings', 'pass', 'crash', 'wrong-wave', 'drift', 'committed-drift']) {
  execFileSync(process.execPath, [fileURLToPath(new URL('./verify-managed-inventory-critic-import.mjs', import.meta.url)), `--case=${scenario}`],
    {stdio: 'inherit', timeout: 120000});
}
console.log('MANAGED_INVENTORY_CRITIC_TRANSPORT_GREEN');
