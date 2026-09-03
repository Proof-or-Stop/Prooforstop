import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  assembleFullPromptEnvelope,
  assembleConditionalReviewPromptEnvelope,
  computePromptEnvelopeId,
  verifyPromptEnvelopeIntegrity,
} from '../core/prompt-envelope.js';
import {
  PromptContractValidationError,
  validateFullTaskContext,
  validatePromptEnvelope,
  type FullTaskContext,
  type IncrementalReviewBasis,
} from '../core/prompt-contracts.js';
import {
  ACTIVE_MODULAR_REVIEWER_ROLE_IDS,
  PROMPT_ENVELOPE_ROLLOUT_VERSION,
  promptRoleContract,
  resolvePromptEnvelopeRolloutMode,
  resolvePromptRoleBody,
} from '../core/prompt-role-contract-registry.js';
import { BASELINE_RUNTIME_CONTRACT } from '../core/prompt-measurement.js';
import { createAgentPromptHandlers } from '../handlers/agent-prompt.js';
import { isReviewerAgent, resolveReviewRunLane } from '../core/review-run.js';
import { parseForceReviewers } from '../handlers/reviewer-list.js';
import { StoryStore } from '../core/store.js';

const role = promptRoleContract('proof-or-stop-review-quality');
const fullRollout = {
  version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
  roles: {
    'proof-or-stop-review-quality': 'full-envelope',
    'proof-or-stop-review-behavior': 'full-envelope',
  },
} as const;
const taskContext: FullTaskContext = {
  schemaVersion: 'proofbound.full-task-context.v1',
  storyId: 'B-envelope',
  title: 'Trusted envelope',
  description: 'Exercise trusted full-context assembly.',
  phase: 'REVIEW',
  priority: 'high',
  checklist: [{
    id: 'CHK-001',
    title: 'Assemble',
    status: 'done',
    relatedDocs: ['docs/requirements/decisions/prompt-envelope.md'],
    files: {
      modify: ['packages/main/src/core/prompt-envelope.ts'],
      create: [],
      test: ['packages/main/src/tasks/prompt-full-context-envelope-smoke.ts'],
    },
    verificationIntent: {
      happy: [{ id: 'CHK-001:happy:0', desc: 'Canonical full context is assembled.', type: 'logic', priority: 'must' }],
      edge: [],
      adversarial: [{ id: 'CHK-001:adversarial:0', desc: 'Cross-role substitution is rejected.', type: 'logic', priority: 'must' }],
    },
  }],
  headHash: 'a'.repeat(40),
  materialHash: 'b'.repeat(64),
  storyFilesHash: 'c'.repeat(64),
  scopeContractDigest: 'd'.repeat(64),
  scope: {
    mode: 'enforce',
    allowedModify: ['packages/main/src/core/prompt-envelope.ts'],
    allowedCreate: [],
    allowedTest: ['packages/main/src/tasks/prompt-full-context-envelope-smoke.ts'],
    protectedFiles: ['docs/requirements/decisions/prompt-envelope.md'],
    explicitExcludes: [],
    protectedAnchors: [],
    fileRules: [],
    pathCanonicalizationMode: 'enforce',
    astAnchorMode: 'warn',
  },
};

const common = {
  roleContract: role,
  runtimeContract: BASELINE_RUNTIME_CONTRACT,
  rolePrompt: resolvePromptRoleBody(role.roleId, fullRollout).body,
  taskContext,
  dispatchKind: 'review-run' as const,
  reviewRunId: 'B-envelope:RR-001',
  reviewRound: '2026-07-18T00:00:00.000Z',
  lane: 'proof-or-stop-review-quality',
  dispatchPrompt: 'Trusted story-review dispatch prompt.',
  hostRenderIdentityDigest: 'f'.repeat(64),
};
const first = assembleFullPromptEnvelope({ ...common, createdAt: '2026-07-18T00:00:01.000Z' });
const repeated = assembleFullPromptEnvelope({ ...common, createdAt: '2026-07-18T00:00:02.000Z' });
assert.equal(first.prompt, repeated.prompt, 'semantic assembly is deterministic');
assert.equal(first.envelope.envelopeId, repeated.envelope.envelopeId, 'createdAt is provenance outside envelopeId');
assert.equal(first.envelope.envelopeId, computePromptEnvelopeId(first.envelope));
assert.equal(verifyPromptEnvelopeIntegrity(first.envelope), true);

const changed = assembleFullPromptEnvelope({
  ...common,
  taskContext: { ...taskContext, title: 'Changed trusted envelope' },
  createdAt: '2026-07-18T00:00:01.000Z',
});
assert.notEqual(first.envelope.envelopeId, changed.envelope.envelopeId);

const tampered = { ...first.envelope, assembledPromptDigest: 'e'.repeat(64) };
assert.equal(verifyPromptEnvelopeIntegrity(tampered), false, 'single-field tamper is rejected');
const substituted = { ...first.envelope, envelopeId: changed.envelope.envelopeId };
assert.equal(verifyPromptEnvelopeIntegrity(substituted), false, 'cross-envelope ID substitution is rejected');

assert.throws(
  () => validatePromptEnvelope({ ...first.envelope, contextMode: 'incremental', eligibilityDecision: 'incremental', priorPassRef: 'RP-1' }),
  /freshnessClassification|impactPolicyVersion/,
);
assert.throws(
  () => validatePromptEnvelope({ ...first.envelope, hiddenProviderWrapper: 'claimed' }),
  PromptContractValidationError,
);

const reviewBasis: IncrementalReviewBasis = {
  schemaVersion: 'proofbound.incremental-review-basis.v1',
  storyId: taskContext.storyId,
  lane: 'lattice-review-quality',
  priorPassRef: 'RP-001',
  priorReviewRunId: 'B-envelope:RR-000',
  priorEnvelopeId: '1'.repeat(64),
  reReviewReasonCodes: ['ELIGIBLE_TRUSTED_PRIOR_BINDINGS', 'ELIGIBLE_PURE_STORY_FIXTURE'],
  changedFiles: ['packages/main/src/tasks/prompt-full-context-envelope-smoke.ts'],
  impactedFiles: ['packages/main/src/tasks/prompt-full-context-envelope-smoke.ts'],
  impactedIntentRefs: ['CHK-001:happy:0'],
  currentClaims: [{ intentRef: 'CHK-001:happy:0', claim: 'Canonical full context is assembled.', state: 'done' }],
  invariants: ['Gate evidence remains envelope-bound.'],
  findingDeltas: [],
  unresolvedFindings: [],
  affectedContracts: [],
  authoritativeReferences: ['packages/main/src/tasks/prompt-full-context-envelope-smoke.ts'],
  scopeAcknowledgementDigest: taskContext.scopeContractDigest,
};
const conditionalCommon = {
  ...common,
  createdAt: '2026-07-18T00:00:03.000Z',
  eligibilityDigest: '2'.repeat(64),
  eligibilityReasonCodes: reviewBasis.reReviewReasonCodes,
  freshnessClassification: 'CURRENT_MATERIAL',
  impactPolicyVersion: 'proofbound.impact-classification.v1',
  priorPassRef: reviewBasis.priorPassRef,
  changedFilesDigest: '3'.repeat(64),
  impactedFilesDigest: '4'.repeat(64),
  reviewBasis,
};
const safeIncremental = assembleConditionalReviewPromptEnvelope({
  ...conditionalCommon,
  incrementalEligible: true,
});
assert.equal(safeIncremental.envelope.contextMode, 'incremental');
assert.equal(safeIncremental.selectionReason, 'SAFE_INCREMENTAL');
assert.ok(safeIncremental.envelope.incrementalContextBytes! < safeIncremental.envelope.fullContextBytes!);
assert.equal(verifyPromptEnvelopeIntegrity(safeIncremental.envelope), true);

for (const roleId of ACTIVE_MODULAR_REVIEWER_ROLE_IDS) {
  const roleContract = promptRoleContract(roleId);
  const rolePrompt = resolvePromptRoleBody(roleId, {
    version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
    roles: { [roleId]: 'full-envelope' },
  }).body;
  const roleCommon = {
    ...common,
    roleContract,
    rolePrompt,
    lane: roleId,
    reviewRunId: `B-envelope:RR-${roleId}`,
  };
  const fullLaunch = assembleFullPromptEnvelope({
    ...roleCommon,
    createdAt: '2026-07-18T00:00:04.000Z',
  });
  assert.equal(fullLaunch.envelope.roleId, roleId, `${roleId} trusted full launch binds its own role`);
  assert.equal(verifyPromptEnvelopeIntegrity(fullLaunch.envelope), true);
  const incrementalLaunch = assembleConditionalReviewPromptEnvelope({
    ...roleCommon,
    createdAt: '2026-07-18T00:00:05.000Z',
    eligibilityDigest: '2'.repeat(64),
    eligibilityReasonCodes: reviewBasis.reReviewReasonCodes,
    freshnessClassification: 'CURRENT_MATERIAL',
    impactPolicyVersion: 'proofbound.impact-classification.v1',
    priorPassRef: reviewBasis.priorPassRef,
    changedFilesDigest: '3'.repeat(64),
    impactedFilesDigest: '4'.repeat(64),
    reviewBasis: { ...reviewBasis, lane: roleId },
    incrementalEligible: true,
  });
  assert.equal(incrementalLaunch.envelope.roleId, roleId);
  assert.equal(incrementalLaunch.envelope.contextMode, 'incremental', `${roleId} trusted incremental launch stays role-bound`);
  assert.equal(verifyPromptEnvelopeIntegrity(incrementalLaunch.envelope), true);
}

const safetyFull = assembleConditionalReviewPromptEnvelope({
  ...conditionalCommon,
  incrementalEligible: false,
  eligibilityReasonCodes: ['FULL_PUBLIC_CONTRACT'],
});
assert.equal(safetyFull.envelope.contextMode, 'full');
assert.equal(safetyFull.selectionReason, 'SAFETY_REQUIRES_FULL');

const fullCheaper = assembleConditionalReviewPromptEnvelope({
  ...conditionalCommon,
  incrementalEligible: true,
  reviewBasis: {
    ...reviewBasis,
    invariants: Array.from({ length: 200 }, (_, index) => `large bounded invariant ${index} ${'x'.repeat(80)}`),
  },
});
assert.equal(fullCheaper.envelope.contextMode, 'full');
assert.equal(fullCheaper.selectionReason, 'FULL_CHEAPER_OR_EQUAL');

const incrementalOverBudget = assembleConditionalReviewPromptEnvelope({
  ...conditionalCommon,
  incrementalEligible: true,
  incrementalBudgetBytes: 1,
});
assert.equal(incrementalOverBudget.envelope.contextMode, 'full');
assert.equal(incrementalOverBudget.selectionReason, 'INCREMENTAL_BUDGET_EXCEEDED');
assert.equal(incrementalOverBudget.envelope.budgetViolation, 'incremental');

const fullOverBudget = assembleConditionalReviewPromptEnvelope({
  ...conditionalCommon,
  incrementalEligible: false,
  eligibilityReasonCodes: ['FULL_PUBLIC_CONTRACT'],
  fullBudgetBytes: 1,
});
assert.equal(fullOverBudget.envelope.contextMode, 'full');
assert.equal(fullOverBudget.envelope.budgetViolation, 'full');

const reviewerEscalated = assembleConditionalReviewPromptEnvelope({
  ...conditionalCommon,
  incrementalEligible: true,
  reviewerEscalationReason: 'Affected contract was omitted from the bounded basis.',
});
assert.equal(reviewerEscalated.envelope.contextMode, 'full');
assert.equal(reviewerEscalated.selectionReason, 'REVIEWER_REQUESTED_FULL');
assert.match(reviewerEscalated.envelope.escalationReason!, /Affected contract/);
assert.throws(
  () => validateFullTaskContext({ ...taskContext, checklist: [taskContext.checklist[0], { ...taskContext.checklist[0], title: 'duplicate' }] }),
  /duplicate id/,
);
assert.throws(
  () => assembleFullPromptEnvelope({
    ...common,
    dispatchKind: 'story-dispatch',
    createdAt: '2026-07-18T00:00:01.000Z',
  }),
  /cannot carry reviewer authority/,
);
assert.throws(
  () => assembleFullPromptEnvelope({
    ...common,
    lane: 'proof-or-stop-review-behavior',
    createdAt: '2026-07-18T00:00:01.000Z',
  }),
  /role\/lane mismatch/,
);
assert.throws(
  () => assembleFullPromptEnvelope({
    ...common,
    rolePrompt: resolvePromptRoleBody('proof-or-stop-review-behavior', fullRollout).body,
    createdAt: '2026-07-18T00:00:01.000Z',
  }),
  /renderDigest does not match/,
);

assert.equal(resolvePromptEnvelopeRolloutMode(role.roleId, undefined), 'legacy-full-context');
assert.equal(resolvePromptEnvelopeRolloutMode(role.roleId, {
  version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
  roles: { [role.roleId]: 'full-envelope' },
}), 'full-envelope');
assert.throws(() => resolvePromptEnvelopeRolloutMode('implementation-reviewer', {
  version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
  roles: { 'implementation-reviewer': 'full-envelope' },
}), /compatibility/);
assert.throws(() => resolvePromptEnvelopeRolloutMode(role.roleId, {
  version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
  roles: { unknown: 'full-envelope' },
}), /unknown role/);
assert.equal(isReviewerAgent('implementation-reviewer'), false);
assert.equal(isReviewerAgent('test-intent'), false);
assert.equal(isReviewerAgent('test-case-reviewer'), false);
assert.equal(isReviewerAgent('proof-or-stop-review-channel'), false);
assert.throws(
  () => resolveReviewRunLane('proof-or-stop-review-channel'),
  /retired or not eligible/,
);
assert.throws(
  () => parseForceReviewers('channel'),
  /not supported by review_run_start/,
);

const tempRoot = mkdtempSync(join(tmpdir(), 'proofbound-agent-prompt-envelope-'));
try {
  writeFileSync(join(tempRoot, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.',
    testsDir: 'tests',
    fixturesDir: 'tests/fixtures',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
    flows: { defaults: {}, patterns: [] },
    promptEnvelope: {
      version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
      roles: { 'proof-or-stop-review-quality': 'full-envelope' },
    },
  }));
  execFileSync('git', ['init', '-q'], { cwd: tempRoot });
  execFileSync('git', ['config', 'user.email', 'prompt@example.invalid'], { cwd: tempRoot });
  execFileSync('git', ['config', 'user.name', 'Prompt Smoke'], { cwd: tempRoot });
  execFileSync('git', ['add', 'proof-or-stop.config.json'], { cwd: tempRoot });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: tempRoot });
  const store = new StoryStore(tempRoot);
  store.writeStory('B-envelope', {
    storyId: 'B-envelope',
    title: 'Trusted CLI envelope',
    description: 'Trusted handler assembly',
    phase: 'DEV',
    priority: 'high',
  } as never);
  store.writeChecklist('B-envelope', {
    items: [{
      id: 'CHK-001',
      title: 'Assemble',
      status: 'done',
      relatedDocs: ['docs/requirements/prompt.md'],
      files: { modify: ['src/prompt.ts'], create: [], test: ['tests/prompt.ts'] },
      verificationIntent: {
        happy: [{ desc: 'Trusted full context is visible.', type: 'logic' }],
        edge: [],
        adversarial: [],
      },
    }],
  } as never);
  const handlers = createAgentPromptHandlers({ root: tempRoot, scanRoot: tempRoot, store });
  const response = JSON.parse(handlers.agent_prompt({
    role: 'proof-or-stop-review-quality',
    storyId: 'B-envelope',
    format: 'json',
  }));
  assert.equal(response.auditOnly, true);
  assert.equal(response.canMintReviewEvidence, false);
  assert.equal(response.envelope.dispatchKind, 'story-dispatch');
  assert.equal(store.readPromptEnvelopes('B-envelope').envelopes.length, 1);
  let dispatchEvents = store.readProcessEvents('B-envelope').filter(event => event.type === 'dispatch');
  assert.equal(dispatchEvents.length, 1, 'real StoryStore durably persists the story-aware dispatch event');
  assert.equal(dispatchEvents[0]?.promptEnvelopeId, response.envelope.envelopeId);
  assert.equal(dispatchEvents[0]?.assembledPromptDigest, response.envelope.assembledPromptDigest);
  const response2 = JSON.parse(handlers.agent_prompt({
    role: 'proof-or-stop-review-quality',
    storyId: 'B-envelope',
    format: 'json',
  }));
  assert.equal(response2.envelope.envelopeId, response.envelope.envelopeId);
  assert.equal(store.readPromptEnvelopes('B-envelope').envelopes.length, 1, 'content-addressed repeat is idempotent');
  dispatchEvents = store.readProcessEvents('B-envelope').filter(event => event.type === 'dispatch');
  assert.equal(dispatchEvents.length, 2, 'each real dispatch remains append-only even when its envelope is reused');
  const eventFailureStore = Object.create(store) as StoryStore;
  eventFailureStore.appendProcessEvent = () => { throw new Error('mutated process-event persistence failure'); };
  const eventRequiredHandlers = createAgentPromptHandlers({ root: tempRoot, scanRoot: tempRoot, store: eventFailureStore });
  assert.throws(
    () => eventRequiredHandlers.agent_prompt({ role: 'proof-or-stop-review-quality', storyId: 'B-envelope', format: 'json' }),
    /mutated process-event persistence failure/,
    'story-aware dispatch must fail closed when its production event cannot persist',
  );
  assert.throws(
    () => handlers.agent_prompt({ role: 'proof-or-stop-review-quality', storyId: 'B-envelope', envelopeId: 'forged' }),
    /unsupported caller-controlled field/,
  );
  const legacyBody = resolvePromptRoleBody('proof-or-stop-implementer', {
    version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
    roles: { 'proof-or-stop-review-quality': 'full-envelope' },
  }).body;
  assert.equal(
    handlers.agent_prompt({ role: 'proof-or-stop-implementer', storyId: 'B-envelope', format: 'json' }),
    legacyBody,
    'per-role rollback preserves exact legacy bytes even when Story args remain',
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log('prompt full-context envelope smoke: PASS');
