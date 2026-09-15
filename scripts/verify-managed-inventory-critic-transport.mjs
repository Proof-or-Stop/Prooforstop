import {spawnSync, execFile} from 'node:child_process';
// Synthetic transport input only; this creates no live review or authority.
import assert from 'node:assert/strict';
import {classifyManagedReviewFinalEnvelope, managedReviewClaudeJsonSchema, MANAGED_REVIEW_CLAUDE_JSON_SCHEMA_MAX_BYTES} from '../packages/main/dist/core/host-run.js';

const {MANAGED_CRITIC_FIXTURE_RUNTIME_POLICY: casePolicy} = await import('../packages/main/dist/core/runtime-fact-registry.js');
const {managedCriticFixtureBudgetMs} = await import('../packages/main/dist/tasks/isolated-finding-fixture.js');
assert.equal(managedCriticFixtureBudgetMs({},1000),120000);
const envelope = value => ({[casePolicy.environmentKey]: JSON.stringify(value)});
assert.equal(managedCriticFixtureBudgetMs(envelope({entry:casePolicy.entry,deadlineAt:51000}),1000),35000);
for (const value of [null,{}, {entry:'foreign',deadlineAt:51000},{entry:casePolicy.entry,deadlineAt:15000}]) {
 assert.throws(()=>managedCriticFixtureBudgetMs(envelope(value),1000));
}
assert.throws(()=>managedCriticFixtureBudgetMs({[casePolicy.environmentKey]:'invalid'},1000));
const claudeSchemaText = managedReviewClaudeJsonSchema({storyId:'B-fixture',agentType:'proof-or-stop-review-topology-critic',lane:'proof-or-stop-review-topology-critic',reviewRunId:'B-fixture:RR-001'});
const claudeSchema = JSON.parse(claudeSchemaText);
assert(claudeSchema.properties.inventoryCritic);
assert(Buffer.byteLength(claudeSchemaText,'utf8') <= MANAGED_REVIEW_CLAUDE_JSON_SCHEMA_MAX_BYTES);
assert(!/"(?:minLength|anyOf|oneOf|allOf)"/.test(claudeSchemaText),'Claude provider schema must use supported flat constraints');
const {createManagedReviewEvidenceHandlers} = await import('../packages/main/dist/handlers/managed-review-evidence.js');
assert.throws(()=>createManagedReviewEvidenceHandlers({}).managed_review_proposal_set({inventoryCritic:{}}),/MANAGED_INVENTORY_FINAL_ENVELOPE_REQUIRED/);
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
assert.equal(classify(proposal), 'malformed',
  'Topology critic transport without inventoryCritic must fail before it can omit the critic receipt');
const inventory = {...proposal, inventoryCritic: {
  epochId: 'B-fixture:RI-001', wave: 1,
  findingDispositions: [{finding: {findingId: 'B-fixture:F-001'}, disposition: 'verified_family',
    familyKey: 'stale-report', reason: 'The signed fixture observation identifies a stale report.'}],
}};
assert.equal(classify(inventory), 'valid', 'MANAGED_INVENTORY_DISPOSITION_TRANSPORT_MISSING');
assert.equal(classify({...inventory, lane: 'proof-or-stop-review-quality',
  providerAgent: 'proof-or-stop-review-quality'}), 'malformed', 'Ordinary reviewers cannot transport critic authority');
for (const invalid of [null, {}, {...inventory.inventoryCritic, findingDispositions: [inventory.inventoryCritic.findingDispositions[0], inventory.inventoryCritic.findingDispositions[0]]}, {...inventory.inventoryCritic, wave: 0},
  {...inventory.inventoryCritic, extraAuthority: true},
  {...inventory.inventoryCritic, findingDispositions: [{finding: {findingId: 'B-fixture:F-001'}, disposition: 'resolved'}]}]) {
  assert.equal(classify({...proposal, inventoryCritic: invalid}), 'malformed', 'Malformed critic payload must fail closed');
}
for (const reason of ['', 'short', '123456789', '   123456789   ']) {
 const shortReason = {...inventory, inventoryCritic: {...inventory.inventoryCritic,
   findingDispositions: inventory.inventoryCritic.findingDispositions.map(row => ({...row, reason}))}};
 assert.equal(classify(shortReason), 'malformed', 'Managed critic reason must meet the shared trimmed ten-character floor');
}
assert.equal(classify({...inventory, inventoryCritic: {...inventory.inventoryCritic,
 findingDispositions: inventory.inventoryCritic.findingDispositions.map(row => ({...row, reason:'1234567890'}))}}), 'valid');
console.log('MANAGED_INVENTORY_CRITIC_TRANSPORT_PARSER_GREEN');

// Execute the actual final guard and failure gate in a disposable subprocess.
// Removing each required authority token must exit nonzero before success banners.
const {readFileSync} = await import('node:fs');
const verifierSource = readFileSync(new URL('./verify-process-fact-contract.mjs', import.meta.url), 'utf8');
const finalGuard = verifierSource.slice(verifierSource.indexOf('// Managed inventory transport checks must precede the final failure gate.'));
assert(finalGuard.includes('if (failures.length)'), 'Contract test must include the actual final failure gate');
const handlerPath = 'packages/main/src/handlers/review-inventory.ts';
const sourcePaths = [handlerPath,'packages/main/src/core/managed-host-run.ts','packages/main/src/core/managed-review-evidence.ts'];
const sources = Object.fromEntries(sourcePaths.map(path=>[path,readFileSync(new URL('../'+path,import.meta.url),'utf8')]));
const mutations = [null,...['export function importManagedInventoryCritic','createManagedReviewEvidenceBinding',
 'verifyManagedReviewLiveBinding','proposalFindingIndex','only proof-or-stop-review-topology-critic may write critic authority'].map(token=>({path:handlerPath,token})),
 ...sourcePaths.slice(1).map(path=>({path,token:'isManagedInventoryCritic'}))];
for (const mutation of mutations) {
  const candidate = {...sources};
  if(mutation) candidate[mutation.path]=candidate[mutation.path].replaceAll(mutation.token,'');
  const prelude = `const nodeAssert=require('node:assert/strict');const failures=[];function assert(ok,message){if(!ok)failures.push(message);}const sources=${JSON.stringify(candidate)};function read(path){return sources[path];}\n`;
  const result = spawnSync(process.execPath, ['-e', 'eval(require("node:fs").readFileSync(0, "utf8"))'], {input:prelude + finalGuard,encoding:'utf8',timeout:10000});
  assert.equal(result.status, mutation ? 1 : 0, 'Actual guard exit status for '+JSON.stringify(mutation));
  if (mutation) {assert.match(result.stderr,/Process fact contract failed/);assert(!result.stdout.includes('Process-fact contract verification passed'));}
}
console.log('MANAGED_INVENTORY_CONTRACT_NEGATIVE_CONTROLS_GREEN');

// Three bounded fixture children per batch. Each inner watchdog is 120 seconds;
// the outer grace is 15 seconds. Five batches (675s) plus subprocess controls (80s) leave 145s of the pinned 900s budget.
const {fileURLToPath} = await import('node:url');
const scenarios = ['findings', 'pass', 'crash', 'wrong-wave', 'drift', 'committed-drift',
  'missing-disposition', 'duplicate', 'not-verified', 'own-id', 'existing-id', 'index-ambiguity', 'cancel-before-import', 'native', 'resolved-collision'];
const run = scenario => new Promise((resolve, reject) => {
  const startedAt = performance.now();
  process.stderr.write(`Starting managed critic scenario: ${scenario}\n`);
  execFile(process.execPath, [fileURLToPath(new URL('./verify-managed-inventory-critic-import.mjs', import.meta.url)), `--case=${scenario}`],
    {timeout: casePolicy.outerMs, maxBuffer: 8 * 1024 * 1024, env: {...process.env,
      [casePolicy.environmentKey]: JSON.stringify({entry:casePolicy.entry,deadlineAt:Date.now()+casePolicy.outerMs})}}, (error, stdout, stderr) => {
      process.stdout.write(stdout); process.stderr.write(stderr);
      process.stderr.write(`Managed critic scenario elapsed: ${scenario} ${Math.round(performance.now()-startedAt)} ms\n`);
      if (error) reject(error); else resolve();
    });
});
for (let offset = 0; offset < scenarios.length; offset += casePolicy.parallelism) {
  const batch = await Promise.allSettled(scenarios.slice(offset, offset + casePolicy.parallelism).map(run));
  const failure = batch.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}
console.log('MANAGED_INVENTORY_CRITIC_TRANSPORT_GREEN');
