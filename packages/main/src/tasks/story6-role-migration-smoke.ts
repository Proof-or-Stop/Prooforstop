import assert from 'node:assert/strict';

import {
  assembleFullPromptEnvelope,
  buildFullTaskContext,
} from '../core/prompt-envelope.js';
import { BASELINE_RUNTIME_CONTRACT } from '../core/prompt-measurement.js';
import {
  ACTIVE_MODULAR_COMPLEX_ROLE_IDS,
  promptRoleContract,
  resolvePromptRoleBody,
} from '../core/prompt-role-contract-registry.js';
import { observeComplexRolePromptBudget } from '../core/prompt-budget.js';
import { resolvePromptEnvelopeRolloutMode } from '../core/prompt-role-contract-registry.js';

const taskContext = buildFullTaskContext({
  story: {
    storyId: 'B-story6-smoke',
    title: 'Story 6 role migration',
    description: 'Deterministic trusted dispatch fixture.',
    phase: 'DEV',
    priority: 'high',
  } as any,
  checklist: {
    items: [{
      id: 'CHK-001', title: 'Migrate roles', status: 'in_progress', relatedDocs: [],
      files: { modify: [], create: [], test: [] },
      verificationIntent: { happy: [], edge: [], adversarial: [] },
    }],
  } as any,
  headHash: 'a'.repeat(40),
  materialHash: 'b'.repeat(64),
  storyFilesHash: 'c'.repeat(64),
});

for (const roleId of ACTIVE_MODULAR_COMPLEX_ROLE_IDS) {
  assert.equal(resolvePromptEnvelopeRolloutMode(roleId, {
    version: 'proofbound.prompt-envelope-rollout.v1',
    roles: { [roleId]: 'full-envelope' },
  }), 'full-envelope');
  const role = promptRoleContract(roleId);
  const body = resolvePromptRoleBody(roleId, {
    version: 'proofbound.prompt-envelope-rollout.v1',
    roles: { [roleId]: 'full-envelope' },
  }).body;
  const assembly = assembleFullPromptEnvelope({
    roleContract: role,
    runtimeContract: BASELINE_RUNTIME_CONTRACT,
    rolePrompt: body,
    taskContext,
    dispatchKind: 'story-dispatch',
    dispatchPrompt: `Story 6 dispatch for ${roleId}`,
    createdAt: '2026-07-20T00:00:00.000Z',
  });
  assert.equal(assembly.envelope.roleId, roleId);
  assert.match(assembly.prompt, /## Runtime Contract/);
  assert.match(assembly.prompt, /## Task Context/);
  assert.equal(assembly.envelope.dispatchKind, 'story-dispatch');
  const budget = observeComplexRolePromptBudget({
    roleId,
    contextMode: 'full',
    bytes: assembly.envelope.bytes,
    estimatedTokens: assembly.envelope.estimatedTokens,
  });
  assert.equal(budget.mode, 'observe');
}

const overBudget = observeComplexRolePromptBudget({
  roleId: 'lattice-implementer',
  contextMode: 'full',
  bytes: 44_001,
  estimatedTokens: 10_000,
});
assert.equal(overBudget.withinBudget, false);
assert.equal(overBudget.violation, 'complex-role-budget');
assert.match(overBudget.reason, /continue full correctness dispatch/);
console.log(`story6-role-migration-smoke: PASS (${ACTIVE_MODULAR_COMPLEX_ROLE_IDS.length} roles; warn-only budget violation)`);
