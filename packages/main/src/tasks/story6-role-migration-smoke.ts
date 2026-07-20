import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
import { isBudgetedComplexRole, observeComplexRolePromptBudget } from '../core/prompt-budget.js';
import { resolvePromptEnvelopeRolloutMode } from '../core/prompt-role-contract-registry.js';
import {
  readPromptRegistry,
  renderPromptEntryForHost,
  restoreLegacyPromptTemplate,
} from '../core/prompt-registry.js';

const registry = readPromptRegistry();

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
  const entry = registry.agents.find(candidate => candidate.agentId === roleId)!;
  assert.equal(resolvePromptEnvelopeRolloutMode(roleId, {
    version: 'proofbound.prompt-envelope-rollout.v1',
    roles: { [roleId]: 'full-envelope' },
  }), 'full-envelope');
  const role = promptRoleContract(roleId);
  const body = resolvePromptRoleBody(roleId, {
    version: 'proofbound.prompt-envelope-rollout.v1',
    roles: { [roleId]: 'full-envelope' },
  }).body;
  const legacy = resolvePromptRoleBody(roleId, {
    version: 'proofbound.prompt-envelope-rollout.v1',
    roles: { [roleId]: 'legacy-full-context' },
  });
  assert.equal(legacy.legacyBytesRestored, true);
  assert.equal(legacy.body, restoreLegacyPromptTemplate(entry), `${roleId} exact rollback is content-addressed`);
  const roleLimit = roleId === 'lattice-implementer' ? 10_000 : 12_000;
  assert.ok(Buffer.byteLength(body, 'utf8') <= roleLimit, `${roleId} modular role body meets ${roleLimit} byte target`);
  assert.ok(Buffer.byteLength(body, 'utf8') < Buffer.byteLength(legacy.body, 'utf8'));
  assert.equal(readFileSync(join(process.cwd(), '.claude/agents', entry.file), 'utf8'), renderPromptEntryForHost(entry, 'claude'));
  assert.equal(readFileSync(join(process.cwd(), '.lattice-codex/agents', entry.file), 'utf8'), renderPromptEntryForHost(entry, 'codex'));
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
  if (isBudgetedComplexRole(roleId)) {
    const budget = observeComplexRolePromptBudget({
      roleId,
      contextMode: 'full',
      bytes: assembly.envelope.bytes,
      estimatedTokens: assembly.envelope.estimatedTokens,
    });
    assert.equal(budget.mode, 'observe');
    assert.equal(budget.baselineAccepted, budget.withinBudget);
  } else {
    assert.equal(roleId, 'lattice-evaluator', 'only evaluator is migrated without a Story 6 budget');
  }
}

const overBudget = observeComplexRolePromptBudget({
  roleId: 'lattice-implementer',
  contextMode: 'full',
  bytes: 44_001,
  estimatedTokens: 10_000,
});
assert.equal(overBudget.withinBudget, false);
assert.equal(overBudget.violation, 'complex-role-budget');
assert.equal(overBudget.correctnessExecution, 'continue-full');
assert.equal(overBudget.baselineAccepted, false);
assert.match(overBudget.reason, /continue full correctness dispatch/);
console.log(`story6-role-migration-smoke: PASS (${ACTIVE_MODULAR_COMPLEX_ROLE_IDS.length} roles; observe-only budget violation)`);
