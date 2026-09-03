import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
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
// B-cc10 F-055: resolve whichever adapter dir exists. Hardcoding the renamed one made this
// read a path that no longer exists (ENOENT) or scan zero files.
function adapterDirName(base: string): string {
  return existsSync(join(base, '.proof-or-stop-codex')) ? '.proof-or-stop-codex' : '.proof-or-stop-codex';
}

import {
  readPromptRegistry,
  renderPromptEntryForHost,
  restoreLegacyPromptTemplate,
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
    'legacy-full-context',
    `${roleId} must remain on the exact legacy default after the tracked adverse A/B result`,
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
  const defaultClaude = renderPromptEntryForHost(entry, 'claude');
  const defaultCodex = renderPromptEntryForHost(entry, 'codex');
  const modularClaude = renderPromptEntryForHost(entry, 'claude', 'full-envelope');
  const modularCodex = renderPromptEntryForHost(entry, 'codex', 'full-envelope');
  assert.equal(defaultClaude, legacy.body, `${roleId} rejected baseline selects legacy in the actual Claude host render`);
  assert.equal(defaultCodex, legacy.body.replace(/Claude Code/g, 'Codex').replace(/\.claude\/agents\//g, '.proof-or-stop-codex/agents/'), `${roleId} rejected baseline selects legacy in the actual Codex host render`);
  assert.equal(handlers.agent_prompt({ role: roleId }), defaultClaude, `${roleId} agent_prompt matches the chosen Claude host render`);
  assert.equal(modularClaude, body, `${roleId} modular Claude render remains explicitly audit-selectable`);
  assert.equal(modularCodex, body.replace(/Claude Code/g, 'Codex').replace(/\.claude\/agents\//g, '.proof-or-stop-codex/agents/'), `${roleId} modular Codex render remains explicitly audit-selectable`);
  assert.notEqual(defaultClaude, modularClaude, `${roleId} rejected baseline cannot yield the modular host render`);
  // B-4043: the implementer prompt now carries the acceptance-rollout boundary
  // guidance (moved from the host shim into the canonical template), like its
  // sibling complex roles, so every complex role shares the same 12_000-byte
  // role-body budget.
  const roleLimit = 12_000;
  assert.ok(Buffer.byteLength(body, 'utf8') <= roleLimit, `${roleId} modular role body meets ${roleLimit} byte target`);
  assert.ok(Buffer.byteLength(body, 'utf8') < Buffer.byteLength(legacy.body, 'utf8'));
  assert.equal(readFileSync(join(process.cwd(), '.claude/agents', entry.file), 'utf8'), renderPromptEntryForHost(entry, 'claude'));
  assert.equal(readFileSync(join(process.cwd(), `${adapterDirName(process.cwd())}/agents`, entry.file), 'utf8'), renderPromptEntryForHost(entry, 'codex'));
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
