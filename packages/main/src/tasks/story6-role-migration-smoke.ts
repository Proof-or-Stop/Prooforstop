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
import { StoryStore } from '../core/store.js';
import { createAgentPromptHandlers } from '../handlers/agent-prompt.js';

import {
  readPromptRegistry,
  renderPromptEntryForHost,
} from '../core/prompt-registry.js';

const registry = readPromptRegistry();
const projectConfig = JSON.parse(readFileSync(join(process.cwd(), 'proof-or-stop.config.json'), 'utf8')) as {
  promptEnvelope?: { roles?: Record<string, string> };
};
const handlers = createAgentPromptHandlers({
  root: process.cwd(),
  scanRoot: join(process.cwd(), 'packages/main'),
  store: new StoryStore(process.cwd()),
});

for (const roleId of ACTIVE_MODULAR_COMPLEX_ROLE_IDS) {
  assert.equal(
    projectConfig.promptEnvelope?.roles?.[roleId],
    'full-envelope',
    `${roleId} must use the current full-envelope mode`,
  );
}

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
    version: 'proof-or-stop.prompt-envelope-rollout.v1',
    roles: { [roleId]: 'full-envelope' },
  }), 'full-envelope');
  const role = promptRoleContract(roleId);
  const body = resolvePromptRoleBody(roleId, {
    version: 'proof-or-stop.prompt-envelope-rollout.v1',
    roles: { [roleId]: 'full-envelope' },
  }).body;
  assert.throws(() => resolvePromptRoleBody(roleId, {
    version: 'proof-or-stop.prompt-envelope-rollout.v1',
    roles: { [roleId]: 'legacy-full-context' as never },
  }), /unsupported mode/);
  const currentClaude = renderPromptEntryForHost(entry, 'claude', 'full-envelope');
  const currentCodex = renderPromptEntryForHost(entry, 'codex', 'full-envelope');
  assert.equal(handlers.agent_prompt({ role: roleId }), currentClaude, `${roleId} role-only agent_prompt uses the current Claude render`);
  assert.equal(currentClaude, body, `${roleId} current Claude render matches the Role Contract body`);
  assert.equal(currentCodex, body.replace(/Claude Code/g, 'Codex').replace(/\.claude\/agents\//g, '.proof-or-stop-codex/agents/'), `${roleId} current Codex render matches the host transform`);
  // B-4043: the implementer prompt now carries the acceptance-rollout boundary
  // guidance (moved from the host shim into the canonical template), like its
  // sibling complex roles, so every complex role shares the same 12_000-byte
  // role-body budget.
  const roleLimit = 12_000;
  assert.ok(Buffer.byteLength(body, 'utf8') <= roleLimit, `${roleId} modular role body meets ${roleLimit} byte target`);
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
    assert.equal(roleId, 'proof-or-stop-evaluator', 'only evaluator is migrated without a Story 6 budget');
  }
}

const overBudget = observeComplexRolePromptBudget({
  roleId: 'proof-or-stop-implementer',
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
