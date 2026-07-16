import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_DISPATCH_ACCEPTED_TYPES,
  AGENT_DISPATCH_REGISTRY,
  AgentDispatchRegistryDefinitionError,
  AgentDispatchRegistryError,
  assertRegisteredAgentMutationAllowed,
  entryAcceptsIdentifier,
  entryPermitsMutation,
  resolveAgentDispatchType,
  validateAgentDispatchRequest,
  validateAgentDispatchRegistry,
} from '../core/agent-dispatch-registry.js';
import { StoryStore } from '../core/store.js';
import { createStoryDispatchHandlers } from '../handlers/story-dispatch.js';
import { createChecklistHandlers } from '../handlers/checklist.js';
import { resolveReviewRunLane } from '../core/review-run.js';

const canonicalNames = AGENT_DISPATCH_REGISTRY.map((entry) => entry.canonicalName);
assert.equal(new Set(canonicalNames).size, canonicalNames.length, 'canonical agent types must be unique');

const allNames = AGENT_DISPATCH_REGISTRY.flatMap((entry) => [entry.canonicalName, ...entry.aliases]);
assert.equal(new Set(allNames).size, allNames.length, 'canonical names and aliases must not collide');
assert.deepEqual(AGENT_DISPATCH_ACCEPTED_TYPES, [...allNames].sort(), 'accepted type list must enumerate the full table');

for (const entry of AGENT_DISPATCH_REGISTRY) {
  assert.ok(entry.allowedPhases.length > 0, `${entry.canonicalName} must declare an allowed phase`);
  assert.equal(new Set(entry.allowedPhases).size, entry.allowedPhases.length, `${entry.canonicalName} phases must be unique`);
  assert.equal(new Set(entry.identifierKinds).size, entry.identifierKinds.length, `${entry.canonicalName} identifiers must be unique`);
  assert.equal(new Set(entry.permittedMutations).size, entry.permittedMutations.length, `${entry.canonicalName} mutations must be unique`);
  assert.equal(new Set(entry.evidenceOwnership).size, entry.evidenceOwnership.length, `${entry.canonicalName} evidence ownership must be unique`);
  const mutations: readonly string[] = entry.permittedMutations;

  if (entry.targetCardinality === 'story-only') {
    assert.deepEqual(entry.identifierKinds, [], `${entry.canonicalName} story-only target cannot accept identifiers`);
  } else {
    assert.ok(entry.identifierKinds.length > 0, `${entry.canonicalName} exactly-one target needs an identifier kind`);
  }

  if (entry.roleClass.endsWith('reviewer')) {
    assert.ok(entry.reviewerLane, `${entry.canonicalName} reviewer must declare a lane`);
    assert.equal(entry.commitAllowed, false, `${entry.canonicalName} reviewer cannot receive commit authority`);
    assert.ok(entry.evidenceOwnership.length > 0, `${entry.canonicalName} reviewer must own evidence`);
    assert.equal(mutations.includes('checklist_update'), false, `${entry.canonicalName} reviewer cannot complete checklist work`);
  } else {
    assert.equal(entry.reviewerLane, null, `${entry.canonicalName} non-reviewer cannot impersonate a reviewer lane`);
  }
  if (entry.roleClass === 'implementer' || entry.roleClass === 'repairer') {
    for (const reviewerCommand of ['init_check_set', 'scope_check_save', 'review_run_start', 'finding_add', 'review_pass_set', 'delivery_check_set'] as const) {
      assert.equal(mutations.includes(reviewerCommand), false, `${entry.canonicalName} cannot mint reviewer evidence with ${reviewerCommand}`);
    }
  }

  const canonical = resolveAgentDispatchType(entry.canonicalName);
  assert.equal(canonical.entry, entry);
  assert.equal(canonical.canonicalType, entry.canonicalName);
  assert.equal(canonical.usedAlias, false);
  assert.equal(canonical.usedDefault, false);
  for (const alias of entry.aliases) {
    const resolved = resolveAgentDispatchType(alias);
    assert.equal(resolved.entry, entry, `${alias} must resolve to ${entry.canonicalName}`);
    assert.equal(resolved.usedAlias, true);
    assert.equal(resolved.usedDefault, false);
  }
  const declaredIdentifiers: readonly string[] = entry.identifierKinds;
  for (const kind of ['itemId', 'findingId', 'clusterId'] as const) {
    assert.equal(entryAcceptsIdentifier(entry, kind), declaredIdentifiers.includes(kind));
  }
  for (const mutation of entry.permittedMutations) {
    assert.equal(entryPermitsMutation(entry, mutation), true, `${entry.canonicalName} must permit declared ${mutation}`);
  }
}

const omitted = resolveAgentDispatchType();
assert.equal(omitted.canonicalType, 'lattice-implementer');
assert.equal(omitted.usedDefault, true);
assert.equal(omitted.usedAlias, false);

for (const blank of ['', ' ', '\t']) {
  assert.throws(
    () => resolveAgentDispatchType(blank),
    (error: unknown) => error instanceof AgentDispatchRegistryError && error.code === 'blank_agent_type',
    `explicit blank agent type ${JSON.stringify(blank)} must fail closed`,
  );
}
assert.throws(
  () => resolveAgentDispatchType('lattice-review-unknown'),
  (error: unknown) => error instanceof AgentDispatchRegistryError
    && error.code === 'unknown_agent_type'
    && error.acceptedTypes.includes('verification-intent')
    && error.acceptedTypes.includes('test-intent'),
  'unknown agent type must return a typed error with accepted canonical and alias guidance',
);
for (const unknown of ['LATTICE-IMPLEMENTER', 'review-quality', 'lattice-review-']) {
  assert.throws(
    () => resolveAgentDispatchType(unknown),
    (error: unknown) => error instanceof AgentDispatchRegistryError && error.code === 'unknown_agent_type',
    `${unknown} must not acquire authority through case folding or prefix inference`,
  );
}

const sample = AGENT_DISPATCH_REGISTRY[0];
assert.throws(
  () => validateAgentDispatchRegistry([{ ...sample, promptBuilder: undefined }]),
  (error: unknown) => error instanceof AgentDispatchRegistryDefinitionError && /promptBuilder/.test(error.message),
  'partial registry entries must fail validation',
);
assert.throws(
  () => validateAgentDispatchRegistry([{ ...sample, permittedMutations: ['story_advance'] }]),
  (error: unknown) => error instanceof AgentDispatchRegistryDefinitionError && /undeclared value/.test(error.message),
  'undeclared mutation authority must fail validation',
);
assert.throws(
  () => validateAgentDispatchRegistry([sample, { ...sample, canonicalName: 'duplicate-role', aliases: ['lattice-implementer'] }]),
  (error: unknown) => error instanceof AgentDispatchRegistryDefinitionError && /duplicate canonical name or alias/.test(error.message),
  'alias collisions must fail validation',
);

const verification = resolveAgentDispatchType('verification-intent').entry;
for (const alias of ['test-intent', 'test-case-reviewer']) {
  assert.equal(resolveAgentDispatchType(alias).entry, verification);
}
assert.equal(verification.roleClass, 'verification-intent');
assert.equal(verification.commitAllowed, false);
assert.deepEqual(verification.permittedMutations, ['checklist_update']);
assert.equal(verification.promptBuilder, 'verification-intent-item');

for (const entry of AGENT_DISPATCH_REGISTRY) {
  const phase = entry.allowedPhases[0];
  const target = entry.targetCardinality === 'story-only'
    ? {}
    : { [entry.identifierKinds[0]]: `${entry.identifierKinds[0]}-value` };
  assert.equal(
    validateAgentDispatchRequest({ agentType: entry.canonicalName, phase, ...target }).entry,
    entry,
    `${entry.canonicalName} valid phase/cardinality must resolve`,
  );
  assert.throws(
    () => validateAgentDispatchRequest({ agentType: entry.canonicalName, phase, ...(entry.targetCardinality === 'story-only' ? { itemId: 'CHK-001' } : {}) }),
    (error: unknown) => error instanceof AgentDispatchRegistryError && error.code === 'invalid_dispatch_cardinality',
    `${entry.canonicalName} invalid cardinality must fail closed`,
  );
}

for (const lane of ['lattice-review-concept', 'lattice-review-quality', 'lattice-review-test-coverage'] as const) {
  const entry = resolveAgentDispatchType(lane).entry;
  assert.equal(entry.targetCardinality, 'story-only', `${lane} lifecycle story hint must be accepted story-only`);
  assert.equal(validateAgentDispatchRequest({ agentType: lane, phase: 'REVIEW' }).entry, entry);
}
assert.throws(
  () => validateAgentDispatchRequest({ agentType: 'verification-intent', phase: 'DEV', itemId: 'CHK-001' }),
  (error: unknown) => error instanceof AgentDispatchRegistryError && error.code === 'invalid_dispatch_phase',
  'verification-intent must fail before prompt generation outside PLAN',
);
assert.throws(
  () => assertRegisteredAgentMutationAllowed('lattice-review-quality', 'checklist_update'),
  /agent_dispatch_mutation_denied/,
  'reviewers must not receive checklist mutation authority',
);
assert.throws(
  () => assertRegisteredAgentMutationAllowed('lattice-implementer', 'review_pass_set'),
  /agent_dispatch_mutation_denied/,
  'implementers must not receive review-pass authority',
);

const root = mkdtempSync(join(tmpdir(), 'agent-dispatch-consumer-smoke-'));
try {
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', storyDir: '.lattice/story/actives', requirementsDir: 'docs/requirements',
  }));
  const store = new StoryStore(root);
  const storyId = 'B-dispatch-consumer';
  const now = '2026-07-16T00:00:00.000Z';
  store.writeStory(storyId, {
    storyId, name: 'dispatch-consumer-smoke', title: 'Dispatch consumer smoke', description: 'Synthetic dispatch contract.',
    type: 'chore', phase: 'PLAN', priority: 'medium', createdAt: now, startedAt: now, endedAt: null, events: [],
  });
  store.writeChecklist(storyId, { items: [{
    id: 'CHK-001', title: 'Define verification', context: 'Synthetic context', status: 'pending', startTime: null, endTime: null,
  }] });
  const handlers = createStoryDispatchHandlers({ store, root, scanRoot: join(root, 'packages/main') });
  const checklistHandlers = createChecklistHandlers({ store, root, scanRoot: join(root, 'packages/main') });
  for (const agentType of ['verification-intent', 'test-intent', 'test-case-reviewer']) {
    const prompt = handlers.dispatch({ storyId, itemId: 'CHK-001', agentType }).prompt;
    assert.match(prompt, /define verification intent/);
    assert.doesNotMatch(prompt, /git commit|status["': ]+done/i);
  }
  const beforeUnknown = store.readProcessEvents(storyId).length;
  assert.throws(
    () => handlers.dispatch({ storyId, itemId: 'CHK-001', agentType: 'lattice-review-lookalike' }),
    /unknown agentType/,
  );
  assert.equal(store.readProcessEvents(storyId).length, beforeUnknown, 'unknown type must fail before dispatch side effects');
  assert.throws(
    () => checklistHandlers.checklist_update({ storyId, itemId: 'CHK-001', status: 'done', actor: 'lattice-review-quality' }),
    /agent_dispatch_mutation_denied/,
    'reviewer checklist completion must be rejected by the real handler consumer',
  );
  assert.throws(
    () => checklistHandlers.checklist_update({ storyId, itemId: 'CHK-001', status: 'done', actor: 'test-intent' }),
    /agent_dispatch_mutation_scope_denied/,
    'verification-intent alias checklist completion must be rejected by the real handler consumer',
  );
  assert.throws(
    () => resolveReviewRunLane('lattice-implementer'),
    /not a registered REVIEW reviewer/,
    'implementer must not mint reviewer-run/pass authority through the real review-run consumer',
  );
  store.writeStory(storyId, { ...store.readStory(storyId), phase: 'REVIEW' });
  const reviewPrompt = handlers.dispatch({ storyId, agentType: 'lattice-review-quality' }).prompt;
  assert.match(reviewPrompt, /review story .* in full/);
  assert.doesNotMatch(reviewPrompt, /git commit|checklist_update/);
  assert.throws(
    () => handlers.dispatch({ storyId, itemId: 'CHK-001', agentType: 'lattice-review-quality' }),
    /story-only; omit itemId/,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`agent-dispatch-registry-smoke PASS (${AGENT_DISPATCH_REGISTRY.length} canonical roles, ${allNames.length - canonicalNames.length} aliases)`);
