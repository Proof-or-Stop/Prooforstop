// Read the actual historical Story; never mutate or re-sign its original evidence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { StoryStore } from '../packages/main/dist/core/store.js';
import { deriveAcceptanceAmendment } from '../packages/main/dist/core/acceptance-amendment.js';
import { acceptanceCompletionBlocker } from '../packages/main/dist/core/acceptance-amendment-gates.js';
import { collectVerificationIntents } from '../packages/main/dist/core/verification.js';
const root = process.cwd(), storyId = 'B-cdf6', store = new StoryStore(root);
const read = () => JSON.parse(execFileSync(process.execPath, ['bin/proof-or-stop.js', 'checklist_get', '--storyId=' + storyId], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
const checklist = read(), original = JSON.stringify(checklist), missing = checklist.items.find(i => i.id === 'CHK-006');
assert.equal(missing.status, 'done');
assert.equal(collectVerificationIntents(missing).length, 0);
assert.equal((missing.verificationEvidence ?? []).length, 0);
assert.match(acceptanceCompletionBlocker(store, storyId, root), /CHK-006/);
const priorCount = checklist.items.reduce((n, i) => n + collectVerificationIntents(i).length, 0);
assert.equal(priorCount, 37, 'current retained snapshot contains two more intents than the original report');
const intentRef = 'CHK-006:happy:0', reference = { refKind: 'existing', canonicalSourceRef: 'intent:' + intentRef };
const test = 'scripts/verify-state-dir-migration.mjs';
const delta = { addItems: [], appendIntents: [{ itemId: missing.id, filesDelta: { modify: [], create: [], test: [test] }, verificationIntent: {
  happy: [{ desc: 'The historical rename claim requires current brand and generated assets, preserved historical evidence, and an explicit verdict for its superseded runtime compatibility promise; a migration-only pass is insufficient.', type: 'cli', priority: 'must' }], edge: [], adversarial: [],
} }], scopeDelta: { modify: [], create: [], test: [test] }, topologyDelta: [{ id: 'AB-CDF6-AMENDMENT-REPLAY', checklistRefs: [missing.id], verificationIntentRefs: [intentRef], milestoneIds: [], verificationTopology: {
  schemaVersion: 'proofstory.acceptance_topology.v1',
  producerRefs: [{ id: 'P', sourceRef: { refKind: 'existing', canonicalSourceRef: 'checklist:CHK-006' } }],
  consumerRefs: [{ id: 'C', sourceRef: { refKind: 'existing', canonicalSourceRef: 'intent:' + intentRef }, producerRefs: ['P'] }],
  positiveAssertionRefs: [{ id: 'A', sourceRef: reference, producerRefs: ['P'], consumerRefs: ['C'] }],
  mutationCaseRefs: [{ id: 'M', sourceRef: reference, producerRefs: ['P'], consumerRefs: ['C'] }], transcriptAssertionRefs: [], commandRefs: [reference],
} }] };
const next = deriveAcceptanceAmendment({ storyId, checklist, scope: store.readScopeContract(storyId), proofStory: store.readProofStoryContract(storyId) }, delta);
assert.deepEqual(next.checklist.items.slice(0, 5), checklist.items.slice(0, 5));
assert.equal(next.checklist.items.reduce((n, i) => n + collectVerificationIntents(i).length, 0), priorCount + 1);
assert.equal(next.checklist.items.find(i => i.id === missing.id).status, 'pending');
assert.equal(next.checklist.items.find(i => i.id === missing.id).verificationEvidence?.length ?? 0, 0);
assert.equal(JSON.stringify(read()), original, 'historical source bytes and evidence remain unchanged');
const decisionPath = 'docs/requirements/decisions/proof-or-stop-identity-cutover.md';
const decision = readFileSync(decisionPath, 'utf8');
assert.match(decision, /normal execution neither probes nor recreates a legacy path/);
console.log(JSON.stringify({ contract: 'acceptance-amendment-historical', sourceStory: storyId,
  checklistDigest: createHash('sha256').update(original).digest('hex'), originalIntents: priorCount, proposedIntents: priorCount + 1, reportSnapshotIntents: 35,
  emptyDoneBlocked: true, priorHistoryUnchanged: true, sourceUnchanged: true,
  productCoverage: 'not-claimed', originalCompatibilityRequirement: 'superseded-by-later-explicit-cutover', decisionPath,
  decisionDigest: createHash('sha256').update(decision).digest('hex'),
  boundary: 'Real historical input and additive derivation only; no independent approval or new product evidence is fabricated.' }, null, 2));
console.log('PASS U05 historical missing-acceptance regression');
