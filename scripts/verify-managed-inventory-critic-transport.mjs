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

// Execute the actual final guard and failure gate in a disposable subprocess.
// Removing each required authority token must exit nonzero before success banners.
const {readFileSync} = await import('node:fs');
const {spawnSync} = await import('node:child_process');
const verifierSource = readFileSync(new URL('./verify-process-fact-contract.mjs', import.meta.url), 'utf8');
const finalGuard = verifierSource.slice(verifierSource.indexOf('// Managed inventory transport checks must precede the final failure gate.'));
assert(finalGuard.includes('if (failures.length)'), 'Contract test must include the actual final failure gate');
const handlerSource = readFileSync(new URL('../packages/main/src/handlers/review-inventory.ts', import.meta.url), 'utf8');
for (const token of [null, 'export function importManagedInventoryCritic', 'createManagedReviewEvidenceBinding',
  'verifyManagedReviewLiveBinding', 'proposalFindingIndex', 'only proof-or-stop-review-topology-critic may write critic authority']) {
  const candidate = token ? handlerSource.replaceAll(token, '') : handlerSource;
  const prelude = `const nodeAssert=require('node:assert/strict');const failures=[];function assert(ok,message){if(!ok)failures.push(message);}function read(){return ${JSON.stringify(candidate)};}\n`;
  const result = spawnSync(process.execPath, ['-e', prelude + finalGuard], {encoding:'utf8',timeout:10000});
  assert.equal(result.status, token ? 1 : 0, 'Actual guard exit status for '+token);
  if (token) {assert.match(result.stderr,/Process fact contract failed/);assert(!result.stdout.includes('Process-fact contract verification passed'));}
}
console.log('MANAGED_INVENTORY_CONTRACT_NEGATIVE_CONTROLS_GREEN');

// Two bounded fixture children per batch. Each inner watchdog is 120 seconds;
// the outer grace is 15 seconds. Six batches fit within the pinned 900s budget.
const {execFile} = await import('node:child_process');
const {fileURLToPath} = await import('node:url');
const scenarios = ['findings', 'pass', 'crash', 'wrong-wave', 'drift', 'committed-drift',
  'missing-disposition', 'duplicate', 'not-verified', 'own-id', 'existing-id', 'index-ambiguity'];
const run = scenario => new Promise((resolve, reject) => {
  execFile(process.execPath, [fileURLToPath(new URL('./verify-managed-inventory-critic-import.mjs', import.meta.url)), `--case=${scenario}`],
    {timeout: 135000, maxBuffer: 8 * 1024 * 1024}, (error, stdout, stderr) => {
      process.stdout.write(stdout); process.stderr.write(stderr);
      if (error) reject(error); else resolve();
    });
});
for (let offset = 0; offset < scenarios.length; offset += 2) {
  const batch = await Promise.allSettled(scenarios.slice(offset, offset + 2).map(run));
  const failure = batch.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}
console.log('MANAGED_INVENTORY_CRITIC_TRANSPORT_GREEN');
