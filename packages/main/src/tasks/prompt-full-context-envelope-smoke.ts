import assert from 'node:assert/strict';

import {
  assembleFullPromptEnvelope,
  computePromptEnvelopeId,
  verifyPromptEnvelopeIntegrity,
} from '../core/prompt-envelope.js';
import {
  PromptContractValidationError,
  validateFullTaskContext,
  validatePromptEnvelope,
  type FullTaskContext,
} from '../core/prompt-contracts.js';
import {
  PROMPT_ENVELOPE_ROLLOUT_VERSION,
  promptRoleContract,
  resolvePromptEnvelopeRolloutMode,
} from '../core/prompt-role-contract-registry.js';
import { BASELINE_RUNTIME_CONTRACT } from '../core/prompt-measurement.js';

const role = promptRoleContract('lattice-review-quality');
const taskContext: FullTaskContext = {
  schemaVersion: 'proofbound.full-task-context.v1',
  storyId: 'B-envelope',
  title: 'Trusted envelope',
  description: 'Exercise trusted full-context assembly.',
  phase: 'REVIEW',
  priority: 'high',
  checklist: [{ id: 'CHK-001', title: 'Assemble', status: 'done' }],
  headHash: 'a'.repeat(40),
  materialHash: 'b'.repeat(64),
  storyFilesHash: 'c'.repeat(64),
  scopeContractDigest: 'd'.repeat(64),
};

const common = {
  roleContract: role,
  runtimeContract: BASELINE_RUNTIME_CONTRACT,
  rolePrompt: 'Review independently.',
  taskContext,
  dispatchKind: 'review-run' as const,
  reviewRunId: 'B-envelope:RR-001',
  reviewRound: '2026-07-18T00:00:00.000Z',
  lane: 'lattice-review-quality',
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
  /full context only/,
);
assert.throws(
  () => validatePromptEnvelope({ ...first.envelope, hiddenProviderWrapper: 'claimed' }),
  PromptContractValidationError,
);
assert.throws(
  () => validateFullTaskContext({ ...taskContext, checklist: [{ id: 'CHK-001', title: 'x', status: 'done' }, { id: 'CHK-001', title: 'y', status: 'done' }] }),
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

console.log('prompt full-context envelope smoke: PASS');
