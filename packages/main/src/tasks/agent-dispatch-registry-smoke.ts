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
  resolveAgentDispatchPromptBuilder,
  validateAgentDispatchRequest,
  validateAgentDispatchRegistry,
} from '../core/agent-dispatch-registry.js';
import { StoryStore } from '../core/store.js';
import { createStoryDispatchHandlers } from '../handlers/story-dispatch.js';
import { createChecklistHandlers } from '../handlers/checklist.js';
import { createFindingHandlers } from '../handlers/finding.js';
import { createReviewRunHandlers } from '../handlers/review-run.js';
import { createInitCheckHandlers } from '../handlers/init-check.js';
import { createScopeCheckHandlers } from '../handlers/scope-check.js';
import { createDeliveryCheckHandlers } from '../handlers/delivery-check.js';
import { captureReviewerReadEvent } from '../core/reviewer-read-evidence.js';
import { resolveReviewRunLane } from '../core/review-run.js';
import type {
  AgentDispatchMutationCommand,
  AgentDispatchRegistryEntry,
  StoryPhase,
} from '../core/types.js';

const ALL_PHASES: readonly StoryPhase[] = [
  'IDEA', 'INIT', 'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE',
  'DISCARDED', 'TEST_CASE', 'TEST_CASE_REVIEW', 'META',
];
const ALL_IDENTIFIERS = ['itemId', 'findingId', 'clusterId'] as const;
const ALL_MUTATIONS: readonly AgentDispatchMutationCommand[] = [
  'checklist_update', 'init_check_set', 'scope_check_save', 'review_run_start',
  'finding_add', 'review_pass_set', 'delivery_check_set', 'finding_resolve',
];

function assertCoverageComplete(
  entries: readonly AgentDispatchRegistryEntry[],
  coveredCanonical: ReadonlySet<string>,
  coveredAliases: ReadonlySet<string>,
  coveredPromptBuilders: ReadonlySet<string>,
): void {
  for (const entry of entries) {
    assert.ok(coveredCanonical.has(entry.canonicalName), `coverage missing canonical role ${entry.canonicalName}`);
    assert.ok(coveredPromptBuilders.has(entry.promptBuilder), `coverage missing prompt class ${entry.promptBuilder}`);
    for (const alias of entry.aliases) {
      assert.ok(coveredAliases.has(alias), `coverage missing alias ${alias}`);
    }
  }
}

const canonicalNames = AGENT_DISPATCH_REGISTRY.map((entry) => entry.canonicalName);
assert.equal(new Set(canonicalNames).size, canonicalNames.length, 'canonical agent types must be unique');

const allNames = AGENT_DISPATCH_REGISTRY.flatMap((entry) => [entry.canonicalName, ...entry.aliases]);
assert.equal(new Set(allNames).size, allNames.length, 'canonical names and aliases must not collide');
assert.deepEqual(AGENT_DISPATCH_ACCEPTED_TYPES, [...allNames].sort(), 'accepted type list must enumerate the full table');
assert.equal(
  AGENT_DISPATCH_REGISTRY.some((entry) => String(entry.roleClass) === 'item-reviewer'),
  false,
  'legacy implementation-reviewer stays deliberately folded into quality/behavior instead of acquiring a third REVIEW authority',
);

for (const entry of AGENT_DISPATCH_REGISTRY) {
  assert.ok(entry.allowedPhases.length > 0, `${entry.canonicalName} must declare an allowed phase`);
  assert.equal(new Set(entry.allowedPhases).size, entry.allowedPhases.length, `${entry.canonicalName} phases must be unique`);
  assert.equal(new Set(entry.identifierKinds).size, entry.identifierKinds.length, `${entry.canonicalName} identifiers must be unique`);
  assert.equal(new Set(entry.permittedMutations).size, entry.permittedMutations.length, `${entry.canonicalName} mutations must be unique`);
  assert.equal(new Set(entry.evidenceOwnership).size, entry.evidenceOwnership.length, `${entry.canonicalName} evidence ownership must be unique`);
  assert.deepEqual(
    Object.keys(entry.promptBuilderByIdentifier).sort(),
    entry.targetCardinality === 'story-only' ? [] : [...entry.identifierKinds].sort(),
    `${entry.canonicalName} prompt mapping must cover every and only accepted target`,
  );
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
  () => validateAgentDispatchRegistry([{ ...sample, promptBuilderByIdentifier: { itemId: 'implementer-dispatch' } }]),
  (error: unknown) => error instanceof AgentDispatchRegistryDefinitionError && /map every and only accepted identifier kind/.test(error.message),
  'a registry row with an unmapped accepted target must fail completeness',
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

const coveredCanonical = new Set<string>();
const coveredAliases = new Set<string>();
const coveredPromptBuilders = new Set<string>();
for (const entry of AGENT_DISPATCH_REGISTRY) {
  coveredCanonical.add(entry.canonicalName);
  coveredPromptBuilders.add(entry.promptBuilder);
  const names = [entry.canonicalName, ...entry.aliases];
  for (const alias of entry.aliases) coveredAliases.add(alias);
  for (const agentType of names) {
    for (const phase of ALL_PHASES) {
      for (let mask = 0; mask < 8; mask += 1) {
        const target = Object.fromEntries(ALL_IDENTIFIERS.flatMap((kind, index) => (
          mask & (1 << index) ? [[kind, `${kind}-value`]] : []
        )));
        const provided = ALL_IDENTIFIERS.filter((_, index) => mask & (1 << index));
        const acceptedIdentifiers: readonly string[] = entry.identifierKinds;
        const allowedPhases: readonly StoryPhase[] = entry.allowedPhases;
        const cardinalityValid = entry.targetCardinality === 'story-only'
          ? provided.length === 0
          : provided.length === 1 && acceptedIdentifiers.includes(provided[0]);
        const phaseValid = allowedPhases.includes(phase);
        if (phaseValid && cardinalityValid) {
          assert.equal(
            validateAgentDispatchRequest({ agentType, phase, ...target }).entry,
            entry,
            `${agentType} must accept ${phase}/${provided.join('+') || 'story-only'}`,
          );
        } else {
          const expectedCode = phaseValid ? 'invalid_dispatch_cardinality' : 'invalid_dispatch_phase';
          assert.throws(
            () => validateAgentDispatchRequest({ agentType, phase, ...target }),
            (error: unknown) => error instanceof AgentDispatchRegistryError && error.code === expectedCode,
            `${agentType} must reject ${phase}/${provided.join('+') || 'story-only'} as ${expectedCode}`,
          );
        }
      }
    }
    for (const mutation of ALL_MUTATIONS) {
      const allowedMutations: readonly AgentDispatchMutationCommand[] = entry.permittedMutations;
      const allowed = allowedMutations.includes(mutation);
      assert.equal(entryPermitsMutation(entry, mutation), allowed, `${agentType}/${mutation} table result drifted`);
      if (allowed) {
        assert.equal(assertRegisteredAgentMutationAllowed(agentType, mutation), entry, `${agentType} must retain ${mutation}`);
      } else {
        assert.throws(
          () => assertRegisteredAgentMutationAllowed(agentType, mutation),
          /agent_dispatch_mutation_denied/,
          `${agentType} must be denied ${mutation}`,
        );
      }
    }
  }
}
assertCoverageComplete(AGENT_DISPATCH_REGISTRY, coveredCanonical, coveredAliases, coveredPromptBuilders);

const syntheticCanonical = { ...AGENT_DISPATCH_REGISTRY[0], canonicalName: 'synthetic-uncovered-role' } as unknown as AgentDispatchRegistryEntry;
assert.throws(
  () => assertCoverageComplete([...AGENT_DISPATCH_REGISTRY, syntheticCanonical], coveredCanonical, coveredAliases, coveredPromptBuilders),
  /coverage missing canonical role synthetic-uncovered-role/,
  'a new registry row without an explicit coverage ledger entry must fail completeness',
);
const syntheticAlias = { ...AGENT_DISPATCH_REGISTRY[0], aliases: ['synthetic-uncovered-alias'] } as unknown as AgentDispatchRegistryEntry;
assert.throws(
  () => assertCoverageComplete([syntheticAlias], coveredCanonical, coveredAliases, coveredPromptBuilders),
  /coverage missing alias synthetic-uncovered-alias/,
  'a new compatibility alias without an explicit coverage ledger entry must fail completeness',
);

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
  store.writeFindings(storyId, { findings: [{
    id: `${storyId}:F-001`, desc: 'Synthetic dispatch finding', severity: 'high', category: 'missing',
    status: 'open', agent: 'lattice-review-quality', files: ['packages/main/src/example.ts'],
  }] });
  store.writeClusters(storyId, { clusters: [{
    clusterId: 'CL-001', rootCause: 'Synthetic root cause', findingIds: [`${storyId}:F-001`],
    files: ['packages/main/src/example.ts'], severity: 'high', createdAt: now,
  }] });
  const handlers = createStoryDispatchHandlers({ store, root, scanRoot: join(root, 'packages/main') });
  const checklistHandlers = createChecklistHandlers({ store, root, scanRoot: join(root, 'packages/main') });
  const handlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  const findingHandlers = createFindingHandlers(handlerContext);
  const reviewRunHandlers = createReviewRunHandlers(handlerContext);
  const initCheckHandlers = createInitCheckHandlers(handlerContext);
  const scopeCheckHandlers = createScopeCheckHandlers(handlerContext);
  const deliveryCheckHandlers = createDeliveryCheckHandlers(handlerContext);
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
  const findingsBeforeDenied = JSON.stringify(store.readFindings(storyId));
  assert.throws(
    () => findingHandlers.finding_add({
      storyId, desc: 'must not persist', severity: 'high', category: 'missing', agent: 'test-intent',
    }),
    /agent_dispatch_mutation_denied/,
  );
  assert.equal(JSON.stringify(store.readFindings(storyId)), findingsBeforeDenied, 'denied finding_add must have no side effect');
  assert.throws(
    () => findingHandlers.review_pass_set({
      storyId, agent: 'lattice-implementer', note: 'must not persist a review pass',
      reviewRunId: 'RR-denied', readManifest: { routedCandidates: [], fullyRead: [], triaged: [] },
    }),
    /agent_dispatch_mutation_denied/,
  );
  assert.equal(store.readReviewPasses(storyId).passes.length, 0, 'denied review_pass_set must have no side effect');
  assert.throws(
    () => reviewRunHandlers.review_run_start({ storyId, agent: 'lattice-implementer' }),
    /agent_dispatch_mutation_denied/,
  );
  assert.equal(store.readReviewRuns(storyId).runs.length, 0, 'denied review_run_start must have no side effect');
  assert.throws(
    () => initCheckHandlers.init_check_set({ storyId, issues: [], agent: 'lattice-implementer' }),
    /agent_dispatch_mutation_denied/,
  );
  assert.equal(store.readInitCheck(storyId), null, 'denied init_check_set must have no side effect');
  const previousAgent = process.env.LATTICE_AGENT;
  process.env.LATTICE_AGENT = 'test-intent';
  try {
    assert.throws(
      () => scopeCheckHandlers.scope_check_save({
        storyId, features: [], summary: { total: 0, covered: 0, excluded: 0, gaps: 0 },
        readManifest: { routedCandidates: [], fullyRead: [], triaged: [] },
      }),
      /agent_dispatch_mutation_denied/,
    );
    assert.equal(store.readScopeCheck(storyId), null, 'denied scope_check_save must have no side effect');
    assert.throws(
      () => deliveryCheckHandlers.delivery_check_set({
        storyId, docsPromises: [], realMachineTests: [], closingSelfCheck: { summary: 'must not persist delivery evidence' },
      }),
      /agent_dispatch_mutation_denied/,
    );
    assert.equal(store.readDeliveryCheck(storyId), null, 'denied delivery_check_set must have no side effect');
    assert.throws(
      () => findingHandlers.finding_resolve({ storyId, findingId: `${storyId}:F-001` }),
      /agent_dispatch_mutation_denied/,
    );
    assert.equal(JSON.stringify(store.readFindings(storyId)), findingsBeforeDenied, 'denied finding_resolve must have no side effect');
  } finally {
    if (previousAgent === undefined) delete process.env.LATTICE_AGENT;
    else process.env.LATTICE_AGENT = previousAgent;
  }
  assert.equal(
    captureReviewerReadEvent({ path: 'docs/requirements/decisions/example.md', mode: 'full' }, { agent: 'lattice-review-lookalike' }),
    null,
    'prefix lookalikes must not produce reviewer read evidence',
  );
  assert.ok(
    captureReviewerReadEvent({ path: 'docs/requirements/decisions/example.md', mode: 'full' }, { agent: 'lattice-review-quality' }),
    'registered REVIEW lanes must retain reviewer read evidence authority',
  );
  store.writeStory(storyId, { ...store.readStory(storyId), phase: 'REVIEW' });
  const reviewPrompt = handlers.dispatch({ storyId, agentType: 'lattice-review-quality' }).prompt;
  assert.match(reviewPrompt, /review story .* in full/);
  assert.doesNotMatch(reviewPrompt, /git commit|checklist_update/);
  assert.throws(
    () => handlers.dispatch({ storyId, itemId: 'CHK-001', agentType: 'lattice-review-quality' }),
    /story-only; omit itemId/,
  );

  const promptPatterns: Record<string, RegExp> = {
    'implementer-dispatch': /git commit --author=.*lattice-implementer/,
    'verification-intent-item': /define verification intent/,
    'init-review': /INIT_REVIEW_START/,
    'product-init-review': /product-reviewer/,
    'scope-plan-review': /scope_check_save/,
    'story-review': /review_run_start/,
    'coverage-review': /review_run_start/,
    'delivery-review': /delivery_check_set/,
    'finding-repair': /finding_resolve/,
    'cluster-repair': /Resolves: CL-001/,
  };
  const actualPromptCoverage = new Set<string>();
  for (const entry of AGENT_DISPATCH_REGISTRY) {
    for (const agentType of [entry.canonicalName, ...entry.aliases]) {
      for (const identifierKind of entry.targetCardinality === 'story-only' ? [null] : entry.identifierKinds) {
        store.writeStory(storyId, { ...store.readStory(storyId), phase: entry.allowedPhases[0] });
        const target = identifierKind === 'itemId'
          ? { itemId: 'CHK-001' }
          : identifierKind === 'findingId'
            ? { findingId: 'F-001' }
            : identifierKind === 'clusterId'
              ? { clusterId: 'CL-001' }
              : {};
        const expectedPromptBuilder = resolveAgentDispatchPromptBuilder(entry, identifierKind ?? undefined);
        const prompt = handlers.dispatch({ storyId, agentType, ...target }).prompt;
        assert.match(prompt, promptPatterns[expectedPromptBuilder], `${agentType}/${identifierKind || 'story'} must render ${expectedPromptBuilder}`);
        if (!entry.commitAllowed) assert.doesNotMatch(prompt, /git commit --author=/, `${agentType} must not receive commit instructions`);
        if (entry.roleClass === 'verification-intent') assert.doesNotMatch(prompt, /status["': ]+done/i, `${agentType} must not complete an item`);
        if (entry.roleClass.endsWith('reviewer')) assert.doesNotMatch(prompt, /lattice checklist_update/, `${agentType} must not mutate checklist status`);
        actualPromptCoverage.add(expectedPromptBuilder);
      }
    }
  }
  assertCoverageComplete(AGENT_DISPATCH_REGISTRY, coveredCanonical, coveredAliases, actualPromptCoverage);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`agent-dispatch-registry-smoke PASS (${AGENT_DISPATCH_REGISTRY.length} canonical roles, ${allNames.length - canonicalNames.length} aliases)`);
