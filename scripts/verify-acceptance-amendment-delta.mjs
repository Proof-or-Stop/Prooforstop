import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
const moduleUrl = new URL('../packages/main/dist/core/acceptance-amendment.js', import.meta.url);
assert.ok(existsSync(moduleUrl), 'U05 requires additive acceptance amendment derivation');
const { deriveAcceptanceAmendment } = await import(moduleUrl);
const now = '2026-09-09T00:00:00.000Z';
const items = Array.from({ length: 5 }, (_, i) => ({ id: `CHK-00${i + 1}`, title: `Original requirement ${i + 1}`, status: 'done',
  verificationIntent: { happy: Array.from({ length: 7 }, (_, j) => ({ desc: `Original required case ${j + 1}`, type: 'cli', priority: 'must' })), edge: [], adversarial: [] },
  verificationEvidence: [{ intentRef: `CHK-00${i + 1}:happy:0`, kind: 'integration_test', result: 'pass', note: 'Preserved historical evidence' }] }));
items.push({ id: 'CHK-006', title: 'New requirement without intent', status: 'in_progress', files: { modify: ['src/add.ts'], create: [], test: ['tests/add.test.ts'] }, verificationIntent: { happy: [], edge: [], adversarial: [] } });
const base = { storyId: 'B-amendment', checklist: { items },
  scope: { storyId: 'B-amendment', mode: 'enforce', allowedModify: ['src/add.ts'], allowedCreate: [], allowedTest: ['tests/add.test.ts'], protectedFiles: ['src/protected.ts'], explicitExcludes: ['private/**'], acknowledgements: [], createdAt: now, updatedAt: now },
  proofStory: { schemaVersion: 'proofstory.contract.v1', storyId: 'B-amendment', diagnosticOnly: false, hardeningLevel: 'standard', triggerReasons: [], acceptanceBindings: [], diagnosticGaps: [], createdAt: now, updatedAt: now } };
const original = structuredClone(base);
const ref = { refKind: 'existing', canonicalSourceRef: 'intent:CHK-006:happy:0' };
const binding = { id: 'AB-NEW', checklistRefs: ['CHK-006'], verificationIntentRefs: ['CHK-006:happy:0'], milestoneIds: [],
  verificationTopology: { schemaVersion: 'proofstory.acceptance_topology.v1',
    producerRefs: [{ id: 'P', sourceRef: { refKind: 'existing', canonicalSourceRef: 'process-fact:checklist_update' } }],
    consumerRefs: [{ id: 'C', sourceRef: { refKind: 'existing', canonicalSourceRef: 'process-fact:story_advance' }, producerRefs: ['P'] }],
    positiveAssertionRefs: [{ id: 'A', sourceRef: ref, producerRefs: ['P'], consumerRefs: ['C'] }],
    mutationCaseRefs: [{ id: 'M', sourceRef: ref, producerRefs: ['P'], consumerRefs: ['C'] }], transcriptAssertionRefs: [], commandRefs: [ref] } };
const delta = { addItems: [], appendIntents: [{ itemId: 'CHK-006', verificationIntent: { happy: [{ desc: 'New requirement returns the exact sum', type: 'cli', priority: 'must' }], edge: [], adversarial: [] } }],
  scopeDelta: { modify: [], create: [], test: [] }, topologyDelta: [binding] };
const derived = deriveAcceptanceAmendment(base, delta);
assert.deepEqual(base, original, 'proposal derivation never mutates current acceptance');
assert.deepEqual(derived.checklist.items.slice(0, 5), original.checklist.items.slice(0, 5), 'all original CHK-001 through CHK-005 history remains byte-equivalent');
assert.equal(derived.checklist.items.flatMap(i => Object.values(i.verificationIntent ?? {}).flat()).length, 36, 'missing thirty-sixth intent is added without waiver');
assert.equal(derived.checklist.items[5].status, 'pending', 'tightened requirement must be verified again before done');
assert.deepEqual(deriveAcceptanceAmendment(base, delta), derived, 'same proposal has deterministic derived artifacts');
assert.throws(() => deriveAcceptanceAmendment(base, { ...delta, removeItems: ['CHK-001'] }), /unknown|additive|remove/i);
assert.throws(() => deriveAcceptanceAmendment(base, { ...delta, replaceIntents: [{ itemId: 'CHK-001', verificationIntent: { happy: [] } }] }), /unknown|additive|replace/i);
assert.throws(() => deriveAcceptanceAmendment(base, { ...delta, appendIntents: [{ itemId: 'CHK-006', verificationIntent: { happy: [{ desc: 'Optional substitute', type: 'cli', priority: 'nice' }], edge: [], adversarial: [] } }] }), /required|priority|must/i);
assert.throws(() => deriveAcceptanceAmendment(base, { ...delta, scopeDelta: { modify: ['src/protected.ts'], create: [], test: [] } }), /protected|scope/i);
assert.throws(() => deriveAcceptanceAmendment(base, { ...delta, scopeDelta: { modify: [], create: ['../escape.ts'], test: [] } }), /path|scope/i);
assert.throws(() => deriveAcceptanceAmendment(base, { ...delta, topologyDelta: [] }), /topology|binding/i);
assert.throws(() => deriveAcceptanceAmendment(base, { ...delta, addItems: [{ ...items[0], status: 'done' }] }), /existing|duplicate|status/i);
const withBound = structuredClone(base); withBound.proofStory.acceptanceBindings.push(binding);
assert.throws(() => deriveAcceptanceAmendment(withBound, delta), /binding|duplicate/i);
const withId = structuredClone(base); withId.checklist.items[0].verificationIntent.happy[0].id = 'existing-intent';
const alias = structuredClone(delta); alias.appendIntents[0].verificationIntent.happy[0].id = 'existing-intent';
assert.throws(() => deriveAcceptanceAmendment(withId, alias), /intent|duplicate/i);
console.log('PASS U05 additive acceptance amendment derivation preserves frozen history');
