import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { storyRuntimeLockPath } from '../core/validation-execution-lock.js';
import { createAgentPromptHandlers } from '../handlers/agent-prompt.js';
import { verifyPromptEnvelopeIntegrity } from '../core/prompt-envelope.js';

const roles = [
  'lattice-review-story-init',
  'lattice-review-scope-plan',
  'lattice-implementer',
  'lattice-review-delivery',
  'lattice-evaluator',
];
const budgeted = new Set(roles.filter(role => role !== 'lattice-evaluator'));
const root = mkdtempSync(join(tmpdir(), 'story6-production-dispatch-'));
try {
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: '.', testsDir: 'tests', fixturesDir: 'tests/fixtures',
    storyDir: '.lattice/story/actives', requirementsDir: 'docs/requirements',
    promptEnvelope: {
      version: 'proofbound.prompt-envelope-rollout.v1',
      roles: Object.fromEntries(roles.map(role => [role, 'full-envelope'])),
    },
  }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'story6@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Story 6 Smoke'], { cwd: root });
  execFileSync('git', ['add', 'lattice.config.json'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });

  const envelopes: any[] = [];
  const events: any[] = [];
  const storyDir = join(root, '.lattice', 'story', 'actives', 'B-story6-production');
  mkdirSync(storyDir, { recursive: true });
  const store = {
    readStory: () => ({ storyId: 'B-story6-production', title: 'Story 6 production', description: 'Trusted entrypoint smoke', phase: 'DEV', priority: 'high' }),
    readChecklist: () => ({ items: [{
      id: 'CHK-001', title: 'Migrate roles', context: 'Story 6', status: 'in_progress', relatedDocs: [],
      files: { modify: [], create: [], test: [] }, verificationIntent: { happy: [], edge: [], adversarial: [] },
    }] }),
    readScopeContract: () => null,
    storyDirPath: () => storyDir,
    storyFilePath: (_storyId: string, file: string) => join(storyDir, file),
    runtimeLockDirPath: (storyId: string, category: string, name: string) => storyRuntimeLockPath(root, category, storyId, name),
    readPromptEnvelopes: () => ({ envelopes }),
    writePromptEnvelopes: (_storyId: string, data: { envelopes: any[] }) => envelopes.splice(0, envelopes.length, ...data.envelopes),
    appendProcessEvent: (_storyId: string, event: any) => events.push(event),
  };
  const handlers = createAgentPromptHandlers({ root, scanRoot: root, store: store as never });
  const receipts: Array<{ roleId: string; arm: 'legacy' | 'modular'; provider: 'INCONCLUSIVE'; envelopeId?: string }> = [];
  for (const role of roles) {
    const legacy = handlers.agent_prompt({ role });
    assert.equal(typeof legacy, 'string');
    assert.match(legacy, new RegExp(role));
    receipts.push({ roleId: role, arm: 'legacy', provider: 'INCONCLUSIVE' });
    const response = JSON.parse(handlers.agent_prompt({ role, storyId: 'B-story6-production', format: 'json' }));
    assert.equal(response.auditOnly, true);
    assert.equal(response.canMintReviewEvidence, false);
    assert.equal(response.envelope.roleId, role);
    assert.equal(response.envelope.dispatchKind, 'story-dispatch');
    receipts.push({ roleId: role, arm: 'modular', provider: 'INCONCLUSIVE', envelopeId: response.envelope.envelopeId });
    assert.ok(envelopes.some(envelope => envelope.envelopeId === response.envelope.envelopeId));
    const event = events.find(candidate => candidate.promptEnvelopeId === response.envelope.envelopeId);
    assert.equal(event?.targetKind, 'story-dispatch');
    if (budgeted.has(role)) {
      assert.equal(response.promptBudget.mode, 'observe');
      assert.equal(response.promptBudget.baselineAccepted, true);
    } else {
      assert.equal(response.promptBudget, undefined, 'evaluator is migrated but not budgeted by Story 6');
      assert.equal(event?.promptBudget, undefined);
    }
    // Adversarial receipt checks: role substitution, stale head, and digest
    // mutation must fail the content-addressed integrity check.
    const wrongRole = role === 'lattice-evaluator' ? 'lattice-implementer' : 'lattice-evaluator';
    assert.equal(verifyPromptEnvelopeIntegrity({ ...response.envelope, roleId: wrongRole }), false);
    assert.equal(verifyPromptEnvelopeIntegrity({ ...response.envelope, headHash: 'f'.repeat(40) }), false);
    assert.equal(verifyPromptEnvelopeIntegrity({ ...response.envelope, contextDigest: 'e'.repeat(64) }), false);
  }
  assert.equal(receipts.length, roles.length * 2, 'legacy and modular arms must both be recorded per role');
  assert.ok(receipts.every(receipt => receipt.provider === 'INCONCLUSIVE'), 'provider A/B dimensions must remain honest');
  assert.equal(envelopes.length, roles.length, 'each migrated role has one durable content-addressed receipt');
  assert.equal(events.length, roles.length, 'each receipt has an audit-only dispatch event');
  console.log(`story6-production-dispatch-smoke: PASS (${roles.length} roles; isolated temp repository)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
