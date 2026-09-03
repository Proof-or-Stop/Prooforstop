import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_DISPATCH_ACCEPTED_TYPES,
  AGENT_DISPATCH_REGISTRY,
  AgentDispatchRegistryDefinitionError,
  AgentDispatchRegistryError,
  assertRegisteredAgentMutationAllowed,
  entryAcceptsIdentifier,
  entryPermitsMutation,
  isTrustedHostActor,
  resolveAgentMutationAuthority,
  resolveAgentDispatchType,
  resolveAgentDispatchPromptBuilder,
  TRUSTED_HOST_ACTOR_IDENTITIES,
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
import { DEFAULT_PHASE_TOOLS } from '../core/config.js';
import { REVIEW_RUN_LANES, resolveReviewRunLane } from '../core/review-run.js';
import {
  AGENT_LIVENESS_GUIDANCE_REQUIRED_FRAGMENTS,
  decideAgentLiveness,
  renderAgentLivenessGuidance,
  type AgentHostTaskStatus,
} from '../core/agent-liveness-policy.js';
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

const NONTERMINAL_LIVENESS_STATES: readonly AgentHostTaskStatus[] = [
  'foreground', 'running', 'background', 'silent', 'unknown', 'unavailable',
];
const TERMINAL_FAILURE_STATES: readonly AgentHostTaskStatus[] = [
  'failed', 'cancelled', 'missing', 'dead', 'operator-cancelled',
];

function assertCanonicalLivenessGuidance(prompt: string, label: string): void {
  for (const fragment of AGENT_LIVENESS_GUIDANCE_REQUIRED_FRAGMENTS) {
    assert.match(prompt, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${label} missing canonical liveness fragment: ${fragment}`);
  }
  assert.doesNotMatch(prompt, /no output for 4 minutes|no result (?:for|after) 10 minutes|treat as (?:stuck|stalled).*restart/i, `${label} must not infer failure from elapsed time`);
}

for (const status of NONTERMINAL_LIVENESS_STATES) {
  const decision = decideAgentLiveness({ status, elapsedMs: 60 * 60 * 1000, replacementAlreadyAttempted: false });
  assert.equal(decision.action, 'monitor-same-task', `${status} beyond 600s must keep monitoring`);
  assert.equal(decision.preserveTaskIdentity, true, `${status} must preserve the original task identity`);
  assert.equal(decision.replacementAuthorized, false, `${status} must never authorize a duplicate`);
}
assert.equal(
  decideAgentLiveness({ status: 'completed', elapsedMs: 60 * 60 * 1000, replacementAlreadyAttempted: false }).action,
  'accept-completed-result',
  'a late original result must be consumed exactly once',
);
assert.equal(
  decideAgentLiveness({ status: 'completed', elapsedMs: 60 * 60 * 1000, resultAlreadyConsumed: true, replacementAlreadyAttempted: false }).action,
  'hold-completed',
  'a repeated completed observation must not consume the original result twice',
);
for (const status of TERMINAL_FAILURE_STATES) {
  const first = decideAgentLiveness({ status, elapsedMs: 1, replacementAlreadyAttempted: false });
  assert.equal(first.action, 'replace-once', `${status} must authorize recovery`);
  assert.equal(first.replacementAuthorized, true, `${status} must authorize one replacement`);
  assert.match(first.recordReason ?? '', new RegExp(status.replace('-', '.')), `${status} replacement must retain a reason`);
  const repeated = decideAgentLiveness({ status, elapsedMs: 1, replacementAlreadyAttempted: true });
  assert.equal(repeated.action, 'hold-terminal', `${status} must not launch a second replacement`);
  assert.equal(repeated.replacementAuthorized, false, `${status} retry must be capped at one`);
}
assertCanonicalLivenessGuidance(renderAgentLivenessGuidance({ label: 'state-matrix-smoke' }), 'canonical renderer');

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const activeLivenessSurfaces = [
  'handlers/story-dispatch',
  'handlers/story-create',
  'handlers/transition-effects',
  'core/machine',
];
for (const relativePath of activeLivenessSurfaces) {
  for (const [tree, extension] of [['src', 'ts'], ['dist', 'js']] as const) {
    const path = resolve(packageRoot, tree === 'src' ? '..' : '.', tree === 'src' ? 'src' : '', `${relativePath}.${extension}`);
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(
      source,
      /no output for 4 minutes|no result (?:for|after) 10 minutes|treat as (?:stuck|stalled)[^\n]*(?:restart|re-dispatch)/i,
      `${tree}/${relativePath} must not retain elapsed-only restart guidance`,
    );
  }
}

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
assert.deepEqual(
  AGENT_DISPATCH_ACCEPTED_TYPES,
  allNames.filter(name => name !== 'proof-or-stop-review-channel' && name !== 'lattice-review-channel').sort(),
  'accepted type list must enumerate every non-retired role while excluding channel',
);
assert.deepEqual(
  REVIEW_RUN_LANES,
  AGENT_DISPATCH_REGISTRY
    .filter((entry) => entry.reviewerLane && (entry.allowedPhases as readonly string[]).includes('REVIEW'))
    .map((entry) => entry.reviewerLane),
  'review-run lanes must be the stable registry-order projection, not a second authority list',
);
assert.equal(
  AGENT_DISPATCH_REGISTRY.some((entry) => String(entry.roleClass) === 'item-reviewer'),
  false,
  'legacy implementation-reviewer stays deliberately folded into quality/behavior instead of acquiring a third REVIEW authority',
);
const deliveryEntry = AGENT_DISPATCH_REGISTRY.find((entry) => entry.canonicalName === 'proof-or-stop-review-delivery');
assert.deepEqual(deliveryEntry?.allowedPhases, ['TEST'], 'delivery reviewer dispatch is TEST-only');
const rolloutVerifier = AGENT_DISPATCH_REGISTRY.find((entry) => entry.canonicalName === 'acceptance-rollout-verifier');
assert.ok(rolloutVerifier, 'acceptance-rollout-verifier must be a registered dispatch actor');
assert.equal(rolloutVerifier?.roleClass, 'story-reviewer');
assert.deepEqual(rolloutVerifier?.allowedPhases, ['DEV', 'TEST']);
assert.equal(
  assertRegisteredAgentMutationAllowed('acceptance-rollout-verifier', 'review_run_start'),
  rolloutVerifier,
  'acceptance-rollout-verifier must be allowed to call review_run_start',
);
assert.equal(
  REVIEW_RUN_LANES.includes('acceptance-rollout-verifier' as (typeof REVIEW_RUN_LANES)[number]),
  false,
  'acceptance-rollout-verifier is not a REVIEW evidence lane',
);
assert.equal(DEFAULT_PHASE_TOOLS.TEST.includes('delivery_check_set'), true, 'delivery_check_set must be legal in TEST');
assert.equal(DEFAULT_PHASE_TOOLS.REVIEW.includes('delivery_check_set'), false, 'delivery_check_set must not be legal outside the delivery reviewer dispatch phase');
assert.equal(DEFAULT_PHASE_TOOLS.TEST.includes('delivery_waiver_add'), true, 'delivery waiver must share the delivery reviewer phase');
assert.equal(DEFAULT_PHASE_TOOLS.REVIEW.includes('delivery_waiver_add'), false, 'delivery waiver must reject REVIEW before mutation');

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

  if (entry.canonicalName === 'proof-or-stop-review-channel') {
    assert.throws(
      () => resolveAgentDispatchType(entry.canonicalName),
      /retired agentType/,
      'retired channel remains registry-readable but cannot be dispatched',
    );
    continue;
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
assert.equal(omitted.canonicalType, 'proof-or-stop-implementer');
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
      && error.acceptedTypes.includes('proof-or-stop-verification-intent')
      && !error.acceptedTypes.includes('test-intent'),
  'unknown agent type must return a typed error with accepted canonical and alias guidance',
);
for (const unknown of ['PROOF_OR_STOP-IMPLEMENTER', 'review-quality', 'proof-or-stop-review-']) {
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
  () => validateAgentDispatchRegistry([sample, { ...sample, canonicalName: 'duplicate-role', aliases: ['proof-or-stop-implementer'] }]),
  (error: unknown) => error instanceof AgentDispatchRegistryDefinitionError && /duplicate canonical name or alias/.test(error.message),
  'alias collisions must fail validation',
);

const verification = resolveAgentDispatchType('verification-intent').entry;
assert.equal(verification.canonicalName, 'proof-or-stop-verification-intent');
for (const legacyType of ['proof-or-stop-test-intent', 'proof-or-stop-test-case-reviewer', 'test-intent', 'test-case-reviewer']) {
  assert.throws(
    () => validateAgentDispatchRequest({ agentType: legacyType, phase: 'PLAN', itemId: 'CHK-001' }),
    (error: unknown) => error instanceof AgentDispatchRegistryError
      && error.code === 'legacy_agent_type'
      && /proof-or-stop-verification-intent/.test(error.message),
    `${legacyType} must be rejected for new PLAN dispatch`,
  );
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
  if (entry.canonicalName === 'proof-or-stop-review-channel') continue;
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

for (const lane of ['proof-or-stop-review-concept', 'proof-or-stop-review-quality', 'proof-or-stop-review-test-coverage'] as const) {
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
  () => assertRegisteredAgentMutationAllowed('proof-or-stop-review-quality', 'checklist_update'),
  /agent_dispatch_mutation_denied/,
  'reviewers must not receive checklist mutation authority',
);
assert.throws(
  () => assertRegisteredAgentMutationAllowed('proof-or-stop-implementer', 'review_pass_set'),
  /agent_dispatch_mutation_denied/,
  'implementers must not receive review-pass authority',
);
assert.equal(assertRegisteredAgentMutationAllowed(undefined, 'finding_add'), null, 'omitted actor retains explicit main-host compatibility');
assert.equal(assertRegisteredAgentMutationAllowed(null, 'finding_add'), null, 'null actor retains explicit main-host compatibility');
assert.equal(assertRegisteredAgentMutationAllowed('   ', 'finding_add'), null, 'blank actor retains explicit main-host compatibility');
assert.deepEqual(TRUSTED_HOST_ACTOR_IDENTITIES, ['main', 'main-agent', 'human'], 'trusted host actor set stays minimal and auditable');
for (const actor of TRUSTED_HOST_ACTOR_IDENTITIES) {
  assert.equal(isTrustedHostActor(actor), true, `${actor} is an explicit trusted host identity`);
  assert.equal(assertRegisteredAgentMutationAllowed(actor, 'finding_add'), null, `${actor} retains host mutation compatibility`);
}
assert.throws(
  () => resolveAgentMutationAuthority({
    command: 'checklist_update',
    envActor: 'test-intent',
    payloadActors: ['verification-intent'],
  }),
  /agent_dispatch_identity_conflict/,
  'legacy actor identity must not be authority-equivalent to the active PLAN role',
);
assert.equal(
  resolveAgentMutationAuthority({
    command: 'checklist_update',
    envActor: 'verification-intent',
    payloadActors: ['verification-intent'],
  }).entry?.canonicalName,
  'proof-or-stop-verification-intent',
  'active alias and canonical role remain authority-equivalent',
);
assert.throws(
  () => resolveAgentMutationAuthority({
    command: 'checklist_update',
    envActor: 'verification-intent',
    payloadActors: ['human'],
  }),
  /agent_dispatch_identity_conflict/,
  'trusted-host payload attribution cannot override a registered dispatched env role',
);
assert.throws(
  () => assertRegisteredAgentMutationAllowed('proof-or-stop-review-lookalike', 'finding_add'),
  /agent_dispatch_actor_unknown/,
  'every nonblank unknown actor must fail closed',
);
for (const payloadActor of ['human', 'proof-or-stop-review-quality', 'test-intent']) {
  assert.throws(
    () => resolveAgentMutationAuthority({
      command: 'finding_add',
      envActor: 'proof-or-stop-review-lookalike',
      payloadActors: [payloadActor],
    }),
    /agent_dispatch_actor_unknown/,
    `unknown env actor must not be laundered through payload identity ${payloadActor}`,
  );
}

const root = mkdtempSync(join(tmpdir(), 'agent-dispatch-consumer-smoke-'));
try {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
  }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['checkout', '-qB', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'smoke@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Smoke'], { cwd: root });
  execFileSync('git', ['add', 'proof-or-stop.config.json'], { cwd: root });
  execFileSync('git', [
    'commit', '-qm', 'smoke baseline',
    '--author=proof-or-stop-implementer <proof-or-stop-implementer@noreply.local>',
  ], { cwd: root });
  // Topology-authority dispatch is intentionally fail-closed on an empty
  // story-owned diff. Exercise the complete registry on a real story branch
  // with one committed production delta instead of weakening that gate for a
  // synthetic HEAD==main fixture.
  execFileSync('git', ['checkout', '-qb', 'story/B-dispatch-consumer'], { cwd: root });
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeFileSync(join(root, 'packages/main/src/example.ts'), 'export const dispatchConsumerSmoke = true;\n', 'utf8');
  execFileSync('git', ['add', 'packages/main/src/example.ts'], { cwd: root });
  execFileSync('git', [
    'commit', '-qm', 'seed story-owned dispatch delta',
    '--author=proof-or-stop-implementer <proof-or-stop-implementer@noreply.local>',
  ], { cwd: root });
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
    status: 'open', agent: 'proof-or-stop-review-quality', files: ['packages/main/src/example.ts'],
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
  const mutationState = () => JSON.stringify({
    checklist: store.readChecklist(storyId),
    findings: store.readFindings(storyId),
    reviewPasses: store.readReviewPasses(storyId),
    reviewRuns: store.readReviewRuns(storyId),
    initCheck: store.readInitCheck(storyId),
    scopeCheck: store.readScopeCheck(storyId),
    deliveryCheck: store.readDeliveryCheck(storyId),
    processEvents: store.readProcessEvents(storyId),
  });
  const assertUnknownActorRejectedWithoutMutation = (command: string, invoke: () => unknown) => {
    const before = mutationState();
    assert.throws(invoke, /agent_dispatch_actor_unknown/, `${command} must fail closed for a nonblank unknown actor`);
    assert.equal(mutationState(), before, `${command} unknown-actor rejection must leave story state byte-equivalent`);
  };
  const previousHostAgent = process.env.PROOF_OR_STOP_AGENT;
  delete process.env.PROOF_OR_STOP_AGENT;
  try {
    const hostCases: Array<{ label: string; agent?: string | null; expectedAgent: string }> = [
      { label: 'omitted', expectedAgent: 'main' },
      { label: 'null', agent: null, expectedAgent: 'main' },
      { label: 'blank', agent: '   ', expectedAgent: 'main' },
      { label: 'main', agent: 'main', expectedAgent: 'main' },
      { label: 'main-agent', agent: 'main-agent', expectedAgent: 'main-agent' },
      { label: 'human', agent: 'human', expectedAgent: 'human' },
    ];
    for (const hostCase of hostCases) {
      const result = findingHandlers.finding_add({
        storyId,
        desc: `trusted host compatibility ${hostCase.label}`,
        severity: 'low',
        category: 'edge',
        ...(hostCase.agent === undefined ? {} : { agent: hostCase.agent }),
      } as Parameters<typeof findingHandlers.finding_add>[0]);
      assert.match(result, new RegExp(`created by ${hostCase.expectedAgent}:`), `${hostCase.label} must use the real host handler path`);
    }
    const hostFindings = store.readFindings(storyId).findings.slice(-hostCases.length);
    assert.deepEqual(
      hostFindings.map((finding) => finding.agent),
      hostCases.map((hostCase) => hostCase.expectedAgent),
      'real finding handler preserves explicit trusted host identities and normalizes absent identities to main',
    );

    for (const lookalike of [
      'Main',
      'main_agent',
      'mainagent',
      'main-agent-extra',
      'human-agent',
      'human-reviewer',
      'main/agent',
      'main.agent',
    ]) {
      assert.equal(isTrustedHostActor(lookalike), false, `${lookalike} must not match the exact trusted-host set`);
      assertUnknownActorRejectedWithoutMutation(`finding_add actor=${lookalike}`, () => findingHandlers.finding_add({
        storyId,
        desc: 'trusted host lookalike must not persist',
        severity: 'high',
        category: 'missing',
        agent: lookalike,
      }));
    }
  } finally {
    if (previousHostAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
    else process.env.PROOF_OR_STOP_AGENT = previousHostAgent;
  }
  const assertSpoofRejectedWithoutMutation = (command: string, envAgent: string, invoke: () => unknown) => {
    const before = mutationState();
    const savedAgent = process.env.PROOF_OR_STOP_AGENT;
    process.env.PROOF_OR_STOP_AGENT = envAgent;
    try {
      assert.throws(invoke, /agent_dispatch_identity_conflict/, `${command} must reject env-vs-payload identity spoofing`);
      assert.equal(mutationState(), before, `${command} identity-spoof rejection must leave story state byte-equivalent`);
    } finally {
      if (savedAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
      else process.env.PROOF_OR_STOP_AGENT = savedAgent;
    }
  };
  const assertUnknownEnvSpoofRejectedWithoutMutation = (command: string, payloadAgent: string) => {
    const before = mutationState();
    const savedAgent = process.env.PROOF_OR_STOP_AGENT;
    process.env.PROOF_OR_STOP_AGENT = 'proof-or-stop-review-lookalike';
    try {
      assert.throws(
        () => findingHandlers.finding_add({
          storyId,
          desc: `unknown env actor must not persist via ${payloadAgent}`,
          severity: 'high',
          category: 'missing',
          agent: payloadAgent,
        }),
        /agent_dispatch_actor_unknown/,
        `${command} must reject unknown env identity before payload authority`,
      );
      assert.equal(mutationState(), before, `${command} rejection must leave story state byte-equivalent`);
    } finally {
      if (savedAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
      else process.env.PROOF_OR_STOP_AGENT = savedAgent;
    }
  };
  assertUnknownEnvSpoofRejectedWithoutMutation('finding_add unknown-env + trusted-host payload', 'human');
  assertUnknownEnvSpoofRejectedWithoutMutation('finding_add unknown-env + registered-role payload', 'proof-or-stop-review-quality');
  assertSpoofRejectedWithoutMutation('checklist_update', 'verification-intent', () => checklistHandlers.checklist_update({
    storyId, itemId: 'CHK-001', status: 'done', actor: 'human', agent: 'human',
  }));
  assertSpoofRejectedWithoutMutation('finding_add', 'proof-or-stop-review-quality', () => findingHandlers.finding_add({
    storyId, desc: 'spoofed host finding must not persist', severity: 'high', category: 'missing', agent: 'human',
  }));
  assertSpoofRejectedWithoutMutation('review_pass_set', 'proof-or-stop-implementer', () => findingHandlers.review_pass_set({
    storyId, agent: 'proof-or-stop-review-quality', note: 'spoofed reviewer pass must not persist', reviewRunId: 'RR-spoof',
    readManifest: { routedCandidates: [], fullyRead: [], triaged: [] },
  }));
  assertSpoofRejectedWithoutMutation('review_run_start', 'proof-or-stop-implementer', () => reviewRunHandlers.review_run_start({
    storyId, agent: 'proof-or-stop-review-quality',
  }));
  assertSpoofRejectedWithoutMutation('init_check_set', 'proof-or-stop-implementer', () => initCheckHandlers.init_check_set({
    storyId, issues: [], agent: 'proof-or-stop-review-story-init', agentId: 'proof-or-stop-review-story-init',
  }));
  assertSpoofRejectedWithoutMutation('delivery_check_set', 'proof-or-stop-implementer', () => deliveryCheckHandlers.delivery_check_set({
    storyId, agentId: 'proof-or-stop-review-delivery', docsPromises: [], realMachineTests: [],
    closingSelfCheck: { summary: 'spoofed delivery evidence must not persist' },
  }));
  for (const agentType of ['verification-intent']) {
    const prompt = handlers.dispatch({ storyId, itemId: 'CHK-001', agentType }).prompt;
    assert.match(prompt, /define verification intent/);
    assert.match(prompt, /verificationIntent/);
    assert.doesNotMatch(prompt, /proof-or-stop-test-intent|proof-or-stop-test-case-reviewer|testIntent|testintent_/);
    assert.doesNotMatch(prompt, /git commit|status["': ]+done/i);
  }
  const previousPlanActor = process.env.LATTICE_AGENT;
  process.env.LATTICE_AGENT = 'verification-intent';
  try {
    checklistHandlers.checklist_update({
      storyId,
      itemId: 'CHK-001',
      verificationIntent: {
        happy: [{ desc: 'intent write -> persists', type: 'logic', priority: 'must' }],
        edge: [],
        adversarial: [],
      },
      agent: 'verification-intent',
    });
    const writtenItem = store.readChecklist(storyId).items.find(item => item.id === 'CHK-001');
    assert.deepEqual(writtenItem?.verificationIntent, {
      happy: [{ desc: 'intent write -> persists', type: 'logic', priority: 'must' }],
      edge: [],
      adversarial: [],
    }, 'canonical PLAN role can write verificationIntent through the real checklist handler');
    assert.equal(writtenItem?.status, 'pending', 'verification-intent role cannot complete the checklist item');
    assert.throws(
      () => checklistHandlers.checklist_update({
        storyId, itemId: 'CHK-001', status: 'done', agent: 'verification-intent',
      }),
      /agent_dispatch_mutation_scope_denied/,
      'canonical PLAN role cannot write checklist status',
    );
    assert.throws(
      () => checklistHandlers.checklist_update({
        storyId,
        itemId: 'CHK-001',
        verificationEvidence: [{ kind: 'logic_test', intentRef: `${storyId}:CHK-001:happy:0`, result: 'pass', note: 'must be rejected' }],
        agent: 'verification-intent',
      }),
      /agent_dispatch_mutation_scope_denied/,
      'canonical PLAN role cannot write verificationEvidence',
    );
  } finally {
    if (previousPlanActor === undefined) delete process.env.LATTICE_AGENT;
    else process.env.LATTICE_AGENT = previousPlanActor;
  }
  const beforeUnknown = store.readProcessEvents(storyId).length;
  assert.throws(
    () => handlers.dispatch({ storyId, itemId: 'CHK-001', agentType: 'proof-or-stop-review-lookalike' }),
    /unknown agentType/,
  );
  assert.equal(store.readProcessEvents(storyId).length, beforeUnknown, 'unknown type must fail before dispatch side effects');
  assert.throws(
    () => checklistHandlers.checklist_update({ storyId, itemId: 'CHK-001', status: 'done', actor: 'proof-or-stop-review-quality' }),
    /agent_dispatch_mutation_denied/,
    'reviewer checklist completion must be rejected by the real handler consumer',
  );
  assert.throws(
    () => checklistHandlers.checklist_update({ storyId, itemId: 'CHK-001', status: 'done', actor: 'test-intent' }),
    /agent_dispatch_mutation_denied/,
    'legacy verification-intent identity must have no mutation authority',
  );
  assert.throws(
    () => resolveReviewRunLane('proof-or-stop-implementer'),
    /not a registered REVIEW reviewer/,
    'implementer must not mint reviewer-run/pass authority through the real review-run consumer',
  );
  assert.equal(
    resolveReviewRunLane('lattice-review-topology-critic'),
    'proof-or-stop-review-topology-critic',
    'independent topology critic must mint its own canonical REVIEW ReviewRun before critic authority',
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
      storyId, agent: 'proof-or-stop-implementer', note: 'must not persist a review pass',
      reviewRunId: 'RR-denied', readManifest: { routedCandidates: [], fullyRead: [], triaged: [] },
    }),
    /agent_dispatch_mutation_denied/,
  );
  assert.equal(store.readReviewPasses(storyId).passes.length, 0, 'denied review_pass_set must have no side effect');
  assert.throws(
    () => findingHandlers.review_pass_set({
      storyId, agent: 'main', note: 'main must not self-sign reviewer pass evidence',
      reviewRunId: 'RR-main-denied',
      readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
    }),
    /not a registered REVIEW reviewer/,
    'trusted main host still cannot mint reviewer pass evidence',
  );
  assert.equal(store.readReviewPasses(storyId).passes.length, 0, 'main pass rejection must have no side effect');
  {
    const savedAgent = process.env.PROOF_OR_STOP_AGENT;
    process.env.PROOF_OR_STOP_AGENT = 'proof-or-stop-review-quality';
    try {
      assert.throws(
        () => findingHandlers.review_pass_set({
          storyId, agent: 'proof-or-stop-review-behavior', note: 'wrong lane must not sign another reviewer pass',
          reviewRunId: 'RR-wrong-lane', readManifest: { routedCandidates: [], fullyRead: [], triaged: [] },
        }),
        /agent_dispatch_identity_conflict/,
        'one reviewer lane cannot submit a pass as another lane',
      );
      assert.throws(
        () => checklistHandlers.checklist_update({ storyId, itemId: 'CHK-001', status: 'done', actor: 'proof-or-stop-review-quality' }),
        /agent_dispatch_mutation_denied/,
        'reviewer cannot take owner/implementer lifecycle mutation through the real checklist handler',
      );
      assert.throws(
        () => deliveryCheckHandlers.delivery_check_set({
          storyId, docsPromises: [], realMachineTests: [], closingSelfCheck: { summary: 'quality cannot sign delivery-only evidence' },
        }),
        /agent_dispatch_mutation_denied/,
        'delivery evidence remains delivery-reviewer-only',
      );
    } finally {
      if (savedAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
      else process.env.PROOF_OR_STOP_AGENT = savedAgent;
    }
  }
  assert.equal(store.readReviewPasses(storyId).passes.length, 0, 'wrong-lane pass rejection must have no side effect');
  assert.throws(
    () => reviewRunHandlers.review_run_start({ storyId, agent: 'proof-or-stop-implementer' }),
    /agent_dispatch_mutation_denied/,
  );
  assert.equal(store.readReviewRuns(storyId).runs.length, 0, 'denied review_run_start must have no side effect');
  assert.throws(
    () => initCheckHandlers.init_check_set({ storyId, issues: [], agent: 'proof-or-stop-implementer' }),
    /agent_dispatch_mutation_denied/,
  );
  assert.equal(store.readInitCheck(storyId), null, 'denied init_check_set must have no side effect');
  assertUnknownActorRejectedWithoutMutation('checklist_update', () => checklistHandlers.checklist_update({
    storyId, itemId: 'CHK-001', status: 'done', actor: 'proof-or-stop-review-lookalike',
  }));
  assertUnknownActorRejectedWithoutMutation('finding_add', () => findingHandlers.finding_add({
    storyId, desc: 'must not persist', severity: 'high', category: 'missing', agent: 'proof-or-stop-review-lookalike',
  }));
  assertUnknownActorRejectedWithoutMutation('review_pass_set', () => findingHandlers.review_pass_set({
    storyId, agent: 'proof-or-stop-review-lookalike', note: 'must not persist an unknown actor review pass',
    reviewRunId: 'RR-unknown', readManifest: { routedCandidates: [], fullyRead: [], triaged: [] },
  }));
  assertUnknownActorRejectedWithoutMutation('review_run_start', () => reviewRunHandlers.review_run_start({
    storyId, agent: 'proof-or-stop-review-lookalike',
  }));
  assertUnknownActorRejectedWithoutMutation('init_check_set', () => initCheckHandlers.init_check_set({
    storyId, issues: [], agent: 'proof-or-stop-review-lookalike',
  }));
  const previousAgent = process.env.PROOF_OR_STOP_AGENT;
  process.env.PROOF_OR_STOP_AGENT = 'proof-or-stop-review-lookalike';
  try {
    assertUnknownActorRejectedWithoutMutation('scope_check_save', () => scopeCheckHandlers.scope_check_save({
      storyId, features: [], summary: { total: 0, covered: 0, excluded: 0, gaps: 0 },
      readManifest: { routedCandidates: [], fullyRead: [], triaged: [] },
    }));
    assertUnknownActorRejectedWithoutMutation('delivery_check_set', () => deliveryCheckHandlers.delivery_check_set({
      storyId, docsPromises: [], realMachineTests: [], closingSelfCheck: { summary: 'must not persist delivery evidence' },
    }));
    assertUnknownActorRejectedWithoutMutation('finding_resolve', () => findingHandlers.finding_resolve({
      storyId, findingId: `${storyId}:F-001`,
    }));
    process.env.PROOF_OR_STOP_AGENT = 'test-intent';
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
    if (previousAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
    else process.env.PROOF_OR_STOP_AGENT = previousAgent;
  }
  assert.equal(
    captureReviewerReadEvent({ path: 'docs/requirements/decisions/example.md', mode: 'full' }, { agent: 'proof-or-stop-review-lookalike' }),
    null,
    'prefix lookalikes must not produce reviewer read evidence',
  );
  assert.ok(
    captureReviewerReadEvent({ path: 'docs/requirements/decisions/example.md', mode: 'full' }, { agent: 'proof-or-stop-review-quality' }),
    'registered REVIEW lanes must retain reviewer read evidence authority',
  );
  store.writeStory(storyId, { ...store.readStory(storyId), phase: 'REVIEW' });
  const reviewPrompt = handlers.dispatch({ storyId, agentType: 'proof-or-stop-review-quality' }).prompt;
  assert.match(reviewPrompt, /review story .* using the trusted context selected by review_run_start/);
  assert.doesNotMatch(reviewPrompt, /git commit|checklist_update/);
  assert.throws(
    () => handlers.dispatch({ storyId, itemId: 'CHK-001', agentType: 'proof-or-stop-review-quality' }),
    /story-only; omit itemId/,
  );
  const criticReviewPrompt = handlers.dispatch({ storyId, agentType: 'lattice-review-topology-critic' }).prompt;
  assert.match(criticReviewPrompt, /review_run_start[\s\S]*review_inventory_critic_set/,
    'REVIEW critic prompt must require fresh terminal ReviewRun evidence and bound critic receipt');

  const promptPatterns: Record<string, RegExp> = {
    'implementer-dispatch': /git commit --author=.*proof-or-stop-implementer/,
    'verification-intent-item': /define verification intent/,
    'init-review': /INIT_REVIEW_START/,
    'product-init-review': /product-reviewer/,
    'scope-plan-review': /scope_check_save/,
    'topology-critic-review': /topology_critic_receipt_set/,
    'story-review': /review_run_start/,
    'coverage-review': /review_run_start/,
    'delivery-review': /delivery_check_set/,
    'finding-repair': /finding_resolve/,
    'cluster-repair': /Resolves: CL-001/,
    'rollout-verify': /review_run_start/,
  };
  const actualPromptCoverage = new Set<string>();
  for (const entry of AGENT_DISPATCH_REGISTRY) {
    if (entry.canonicalName === 'proof-or-stop-review-channel') continue;
    for (const agentType of [entry.canonicalName, ...entry.aliases]) {
      for (const identifierKind of entry.targetCardinality === 'story-only' ? [null] : entry.identifierKinds) {
        for (const phase of entry.allowedPhases) {
          store.writeStory(storyId, { ...store.readStory(storyId), phase });
          const target = identifierKind === 'itemId'
            ? { itemId: 'CHK-001' }
            : identifierKind === 'findingId'
              ? { findingId: 'F-001' }
              : identifierKind === 'clusterId'
                ? { clusterId: 'CL-001' }
                : {};
          const expectedPromptBuilder = resolveAgentDispatchPromptBuilder(entry, identifierKind ?? undefined);
          const prompt = handlers.dispatch({ storyId, agentType, ...target }).prompt;
          const label = `${agentType}/${identifierKind || 'story'}/${phase}`;
          assert.match(prompt, promptPatterns[expectedPromptBuilder], `${label} must render ${expectedPromptBuilder}`);
          assertCanonicalLivenessGuidance(prompt, label);
          if (!entry.commitAllowed) assert.doesNotMatch(prompt, /git commit --author=/, `${label} must not receive commit instructions`);
          if (entry.roleClass === 'verification-intent') assert.doesNotMatch(prompt, /status["': ]+done/i, `${label} must not complete an item`);
          if (entry.roleClass.endsWith('reviewer')) assert.doesNotMatch(prompt, /(?:proof-or-stop|lattice) checklist_update/, `${label} must not mutate checklist status`);
          actualPromptCoverage.add(expectedPromptBuilder);
        }
      }
    }
  }
  assertCoverageComplete(AGENT_DISPATCH_REGISTRY, coveredCanonical, coveredAliases, actualPromptCoverage);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`agent-dispatch-registry-smoke PASS (${AGENT_DISPATCH_REGISTRY.length} canonical roles, ${allNames.length - canonicalNames.length} aliases)`);
