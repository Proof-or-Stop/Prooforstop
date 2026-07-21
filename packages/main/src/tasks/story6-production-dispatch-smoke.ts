import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgentPromptHandlers } from '../handlers/agent-prompt.js';
import { createStoryDispatchHandlers } from '../handlers/story-dispatch.js';
import { verifyPromptEnvelopeIntegrity } from '../core/prompt-envelope.js';
import { collectReviewerEvidenceState } from '../core/review-run.js';
import { StoryStore } from '../core/store.js';

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
      roles: Object.fromEntries(roles.map(role => [role, 'legacy-full-context'])),
    },
  }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'story6@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Story 6 Smoke'], { cwd: root });
  execFileSync('git', ['add', 'lattice.config.json'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });

  const store = new StoryStore(root);
  store.writeStory('B-story6-production', { storyId: 'B-story6-production', title: 'Story 6 production', description: 'Trusted entrypoint smoke', phase: 'DEV', priority: 'high' } as never);
  store.writeChecklist('B-story6-production', { items: [{
      id: 'CHK-001', title: 'Migrate roles', context: 'Story 6', status: 'in_progress', relatedDocs: [],
      files: { modify: [], create: [], test: [] }, verificationIntent: { happy: [], edge: [], adversarial: [] },
    }] } as never);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'story fixture'], { cwd: root });
  const handlers = createAgentPromptHandlers({ root, scanRoot: root, store });
  const receipts: Array<{ roleId: string; arm: 'legacy' | 'modular'; provider: 'INCONCLUSIVE'; envelopeId?: string }> = [];
  for (const role of roles) {
    const defaultSelected = handlers.agent_prompt({ role, storyId: 'B-story6-production', format: 'json' });
    assert.equal(typeof defaultSelected, 'string');
    assert.throws(() => JSON.parse(defaultSelected), 'regressed modular arm must not be selected by default');
    const legacyResponse = JSON.parse(handlers.agent_prompt({ role, storyId: 'B-story6-production', format: 'json', auditExperiment: true }));
    assert.equal(legacyResponse.mode, 'legacy-full-context');
    assert.equal(legacyResponse.auditExperiment, true);
    assert.equal(legacyResponse.envelope, null);
    receipts.push({ roleId: role, arm: 'legacy', provider: 'INCONCLUSIVE' });
    const response = JSON.parse(handlers.agent_prompt({
      role, storyId: 'B-story6-production', format: 'json', auditExperiment: true,
      experimentalModeOverride: 'full-envelope',
    }));
    assert.equal(response.auditOnly, true);
    assert.equal(response.canMintReviewEvidence, false);
    assert.equal(response.envelope.roleId, role);
    assert.equal(response.envelope.dispatchKind, 'story-dispatch');
    receipts.push({ roleId: role, arm: 'modular', provider: 'INCONCLUSIVE', envelopeId: response.envelope.envelopeId });
    assert.ok(store.readPromptEnvelopes('B-story6-production').envelopes.some(envelope => envelope.envelopeId === response.envelope.envelopeId));
    const event = store.readProcessEvents('B-story6-production').find(candidate => candidate.promptEnvelopeId === response.envelope.envelopeId);
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
  assert.throws(
    () => handlers.agent_prompt({ role: 'lattice-implementer', storyId: 'B-story6-production', format: 'json', baselineAccepted: true }),
    /unsupported caller-controlled field "baselineAccepted"/,
    'a caller cannot forge A/B acceptance to activate modular rollout',
  );
  assert.equal(receipts.length, roles.length * 2, 'legacy and modular arms must both be recorded per role');
  assert.ok(receipts.every(receipt => receipt.provider === 'INCONCLUSIVE'), 'provider A/B dimensions must remain honest');
  assert.equal(store.readPromptEnvelopes('B-story6-production').envelopes.length, roles.length, 'each experimental modular arm has one durable content-addressed receipt');
  assert.equal(store.readProcessEvents('B-story6-production').filter(event => event.type === 'dispatch').length, roles.length * 2, 'legacy and modular audit arms each persist a dispatch event');
  const reviewConsumer = collectReviewerEvidenceState(store, 'B-story6-production', root);
  assert.equal(
    reviewConsumer.valid.length,
    0,
    'the real REVIEW evidence consumer gives zero credit to audit-only story-dispatch envelopes/events',
  );

  store.writeStory('B-story6-event-failure', { storyId: 'B-story6-event-failure', title: 'Failure', description: 'Failure', phase: 'DEV', priority: 'high' } as never);
  store.writeChecklist('B-story6-event-failure', { items: [{
    id: 'CHK-FAIL', title: 'Failure', context: 'Failure', status: 'in_progress', relatedDocs: [],
    files: { modify: [], create: [], test: [] }, verificationIntent: { happy: [], edge: [], adversarial: [] },
  }] } as never);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'failure fixture'], { cwd: root });
  const failingStore = Object.create(store) as StoryStore;
  failingStore.appendProcessEvent = () => { throw new Error('injected dispatch event failure'); };
  const failingAgentPrompt = createAgentPromptHandlers({ root, scanRoot: root, store: failingStore });
  assert.throws(
    () => failingAgentPrompt.agent_prompt({
      role: 'lattice-implementer', storyId: 'B-story6-event-failure', format: 'json', auditExperiment: true,
      experimentalModeOverride: 'full-envelope',
    }),
    /injected dispatch event failure/,
  );
  assert.equal(store.readPromptEnvelopes('B-story6-event-failure').envelopes.length, 0, 'agent_prompt rolls back a newly persisted envelope when its event append fails');

  const dispatchRoot = mkdtempSync(join(tmpdir(), 'story6-dispatch-event-failure-'));
  try {
    writeFileSync(join(dispatchRoot, 'lattice.config.json'), JSON.stringify({
      scanRoot: '.', testsDir: 'tests', fixturesDir: 'tests/fixtures',
      storyDir: '.lattice/story/actives', requirementsDir: 'docs/requirements',
      promptEnvelope: { version: 'proofbound.prompt-envelope-rollout.v1', roles: { 'lattice-implementer': 'full-envelope' } },
    }));
    execFileSync('git', ['init', '-q'], { cwd: dispatchRoot });
    execFileSync('git', ['config', 'user.email', 'story6@example.invalid'], { cwd: dispatchRoot });
    execFileSync('git', ['config', 'user.name', 'Story 6 Smoke'], { cwd: dispatchRoot });
    const dispatchStore = new StoryStore(dispatchRoot);
    dispatchStore.writeStory('B-story6-dispatch-failure', { storyId: 'B-story6-dispatch-failure', title: 'Failure', description: 'Failure', phase: 'DEV', priority: 'high' } as never);
    dispatchStore.writeChecklist('B-story6-dispatch-failure', { items: [{
      id: 'CHK-FAIL', title: 'Failure', context: 'Failure', status: 'in_progress', relatedDocs: [],
      files: { modify: [], create: [], test: [] }, verificationIntent: { happy: [], edge: [], adversarial: [] },
    }] } as never);
    execFileSync('git', ['add', '.'], { cwd: dispatchRoot });
    execFileSync('git', ['commit', '-qm', 'dispatch failure fixture'], { cwd: dispatchRoot });
    const failingDispatchStore = Object.create(dispatchStore) as StoryStore;
    failingDispatchStore.appendProcessEvent = () => { throw new Error('injected dispatch event failure'); };
    const failingDispatch = createStoryDispatchHandlers({ root: dispatchRoot, scanRoot: dispatchRoot, store: failingDispatchStore });
    assert.throws(
      () => failingDispatch.dispatch({ storyId: 'B-story6-dispatch-failure', itemId: 'CHK-FAIL', agentType: 'lattice-implementer' }),
      /dispatch event persistence failed; prompt envelope was not accepted: injected dispatch event failure/,
    );
    assert.equal(dispatchStore.readPromptEnvelopes('B-story6-dispatch-failure').envelopes.length, 0, 'story dispatch cleanup prevents a successful half-bound envelope');
  } finally {
    rmSync(dispatchRoot, { recursive: true, force: true });
  }
  console.log(`story6-production-dispatch-smoke: PASS (${roles.length} roles; isolated temp repository)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
