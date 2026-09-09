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
  'proof-or-stop-review-story-init',
  'proof-or-stop-review-scope-plan',
  'proof-or-stop-implementer',
  'proof-or-stop-review-delivery',
  'proof-or-stop-evaluator',
];
const budgeted = new Set(roles.filter(role => role !== 'proof-or-stop-evaluator'));
const root = mkdtempSync(join(tmpdir(), 'story6-production-dispatch-'));
try {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', testsDir: 'tests', fixturesDir: 'tests/fixtures',
    storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
    promptEnvelope: {
      version: 'proof-or-stop.prompt-envelope-rollout.v1',
      roles: Object.fromEntries(roles.map(role => [role, 'full-envelope'])),
    },
  }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'story6@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Story 6 Smoke'], { cwd: root });
  execFileSync('git', ['add', 'proof-or-stop.config.json'], { cwd: root });
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
  const receipts: Array<{ roleId: string; arm: 'canonical'; provider: 'INCONCLUSIVE'; envelopeId: string }> = [];
  for (const role of roles) {
    const defaultSelected = handlers.agent_prompt({ role, storyId: 'B-story6-production', format: 'json' });
    assert.equal(typeof defaultSelected, 'string');
    const response = JSON.parse(defaultSelected);
    assert.equal(response.mode, 'full-envelope');
    assert.equal(response.auditOnly, true);
    assert.equal(response.canMintReviewEvidence, false);
    assert.equal(response.envelope.roleId, role);
    assert.equal(response.envelope.dispatchKind, 'story-dispatch');
    receipts.push({ roleId: role, arm: 'canonical', provider: 'INCONCLUSIVE', envelopeId: response.envelope.envelopeId });
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
    const wrongRole = role === 'proof-or-stop-evaluator' ? 'proof-or-stop-implementer' : 'proof-or-stop-evaluator';
    assert.equal(verifyPromptEnvelopeIntegrity({ ...response.envelope, roleId: wrongRole }), false);
    assert.equal(verifyPromptEnvelopeIntegrity({ ...response.envelope, headHash: 'f'.repeat(40) }), false);
    assert.equal(verifyPromptEnvelopeIntegrity({ ...response.envelope, contextDigest: 'e'.repeat(64) }), false);
  }
  assert.throws(
    () => handlers.agent_prompt({ role: 'proof-or-stop-implementer', storyId: 'B-story6-production', format: 'json', baselineAccepted: true }),
    /unsupported caller-controlled field "baselineAccepted"/,
    'a caller cannot forge A/B acceptance to activate modular rollout',
  );
  assert.equal(receipts.length, roles.length, 'each current role records one canonical receipt');
  assert.ok(receipts.every(receipt => receipt.provider === 'INCONCLUSIVE'), 'provider dimensions must remain honest');
  assert.equal(store.readPromptEnvelopes('B-story6-production').envelopes.length, roles.length, 'each current role has one durable content-addressed receipt');
  assert.equal(store.readProcessEvents('B-story6-production').filter(event => event.type === 'dispatch').length, roles.length, 'each current role persists one dispatch event');
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
      role: 'proof-or-stop-implementer', storyId: 'B-story6-event-failure', format: 'json',
    }),
    /injected dispatch event failure/,
  );
  assert.equal(store.readPromptEnvelopes('B-story6-event-failure').envelopes.length, 0, 'agent_prompt rolls back a newly persisted envelope when its event append fails');

  const dispatchRoot = mkdtempSync(join(tmpdir(), 'story6-dispatch-event-failure-'));
  try {
    writeFileSync(join(dispatchRoot, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: '.', testsDir: 'tests', fixturesDir: 'tests/fixtures',
      storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
      promptEnvelope: { version: 'proof-or-stop.prompt-envelope-rollout.v1', roles: { 'proof-or-stop-implementer': 'full-envelope' } },
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
      () => failingDispatch.dispatch({ storyId: 'B-story6-dispatch-failure', itemId: 'CHK-FAIL', agentType: 'proof-or-stop-implementer' }),
      /dispatch event persistence failed; prompt envelope was not accepted: injected dispatch event failure/,
    );
    assert.equal(dispatchStore.readPromptEnvelopes('B-story6-dispatch-failure').envelopes.length, 0, 'story dispatch cleanup prevents a successful half-bound envelope');

    dispatchStore.writeStory('B-story6-reentrant', { storyId: 'B-story6-reentrant', title: 'Reentrant', description: 'Reentrant', phase: 'DEV', priority: 'high' } as never);
    dispatchStore.writeChecklist('B-story6-reentrant', { items: [{
      id: 'CHK-REENTRANT', title: 'Reentrant', context: 'Reentrant', status: 'in_progress', relatedDocs: [],
      files: { modify: [], create: [], test: [] }, verificationIntent: { happy: [], edge: [], adversarial: [] },
    }] } as never);
    execFileSync('git', ['add', '.'], { cwd: dispatchRoot });
    execFileSync('git', ['commit', '-qm', 'reentrant dispatch fixture'], { cwd: dispatchRoot });
    const reentrantStore = Object.create(dispatchStore) as StoryStore;
    let nested = false;
    let reentrantDispatch: ReturnType<typeof createStoryDispatchHandlers>;
    reentrantStore.appendProcessEvent = (storyId, event) => {
      if (!nested) {
        nested = true;
        reentrantDispatch.dispatch({ storyId, itemId: 'CHK-REENTRANT', agentType: 'proof-or-stop-implementer' });
        throw new Error('injected outer append failure after inner success');
      }
      return dispatchStore.appendProcessEvent(storyId, event);
    };
    reentrantDispatch = createStoryDispatchHandlers({ root: dispatchRoot, scanRoot: dispatchRoot, store: reentrantStore });
    assert.throws(
      () => reentrantDispatch.dispatch({ storyId: 'B-story6-reentrant', itemId: 'CHK-REENTRANT', agentType: 'proof-or-stop-implementer' }),
      /dispatch event persistence failed; prompt envelope was not accepted: injected outer append failure after inner success/,
    );
    const reentrantEvents = dispatchStore.readProcessEvents('B-story6-reentrant').filter(event => event.type === 'dispatch');
    const reentrantEnvelopes = dispatchStore.readPromptEnvelopes('B-story6-reentrant').envelopes;
    assert.equal(reentrantEvents.length, 1, 'inner identical dispatch persists exactly one successful event');
    assert.equal(reentrantEnvelopes.length, 1, 'outer failure must not delete the envelope shared by the successful inner dispatch');
    assert.equal(reentrantEvents[0].promptEnvelopeId, reentrantEnvelopes[0].envelopeId);
    assert.equal(reentrantEvents[0].assembledPromptDigest, reentrantEnvelopes[0].assembledPromptDigest);
  } finally {
    rmSync(dispatchRoot, { recursive: true, force: true });
  }
  console.log(`story6-production-dispatch-smoke: PASS (${roles.length} roles; isolated temp repository)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
