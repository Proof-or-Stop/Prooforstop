/**
 * B-90d6 slice C — INIT preflight guidance + story-level scope-plan dispatch.
 *
 * Run after build:
 *   npm --prefix packages/main run build
 *   node packages/main/tests/b90d6-init-dispatch-guidance.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const { resetConfigCache } = await import(join(distRoot, 'core/config.js'));
const { StoryStore } = await import(join(distRoot, 'core/store.js'));
const { getGuardFailureReason } = await import(join(distRoot, 'core/machine.js'));
const { createInitCheckHandlers } = await import(join(distRoot, 'handlers/init-check.js'));
const { createScopeAntiExpansionHandlers } = await import(join(distRoot, 'handlers/scope-anti-expansion.js'));
const { createStoryDispatchHandlers } = await import(join(distRoot, 'handlers/story-dispatch.js'));
const { createStoryReviewHandlers } = await import(join(distRoot, 'handlers/story-review.js'));

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'lattice-b90d6-guidance-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
    workflow: { profile: 'balanced' },
  }, null, 2));
  resetConfigCache();
  return root;
}

function seedStory(store, storyId, phase = 'INIT') {
  const now = '2026-07-08T12:00:00.000Z';
  store.writeStory(storyId, {
    storyId,
    name: storyId,
    title: 'Guided INIT and scope dispatch',
    description: 'Verify guidance and dispatch prompts without changing gate semantics.',
    type: 'chore',
    phase,
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase, action: 'seed', timestamp: now }],
  });
  store.writeChecklist(storyId, {
    items: [{
      id: 'CHK-001',
      title: 'Preserve gate guidance',
      context: 'Failure messages and dispatch prompts guide agents to the right command.',
      status: 'pending',
      startTime: null,
      endTime: null,
      files: {
        modify: ['packages/main/src/core/machine.ts'],
        create: [],
        test: ['packages/main/tests/b90d6-init-dispatch-guidance.test.mjs'],
      },
    }],
  });
}

function scopeHandlers(root, store) {
  return createScopeAntiExpansionHandlers({ root, store, scanRoot: join(root, 'packages/main') });
}

function freezeScope(root, store, storyId) {
  const handlers = scopeHandlers(root, store);
  handlers.scope_boundary_set({
    storyId,
    mode: 'correctness_fix',
    allowedScope: ['Guided INIT and scope dispatch'],
    excludedScope: ['future unrelated expansion'],
    userConfirmed: true,
    confirmation: 'Synthetic user-confirmed boundary for the B-90d6 focused regression test.',
  });
  handlers.execution_boundary_set({
    storyId,
    allowedCommands: ['npm --prefix packages/main run build'],
    allowedPaths: ['packages/main/src', 'packages/main/tests'],
    excludedCommands: ['git push'],
  });
  assert.match(handlers.scope_freeze_check({ storyId }), /PASS/);
}

function assertIncludesInitPreflight(reason, storyId, label) {
  assert.ok(reason, `${label}: expected a blocking reason`);
  assert.match(reason, new RegExp(`lattice init_preflight --storyId=${storyId}`), label);
}

function assertInitCheckGuardGuidance() {
  const storyId = 'B-guidance';
  const root = makeRoot();
  try {
    const store = new StoryStore(root);
    seedStory(store, storyId);

    assertIncludesInitPreflight(
      getGuardFailureReason(storyId, store, 'INIT_CHECK', root),
      storyId,
      'missing scope-boundary guidance',
    );

    scopeHandlers(root, store).scope_boundary_set({
      storyId,
      mode: 'correctness_fix',
      allowedScope: ['Guided INIT and scope dispatch'],
      userConfirmed: true,
      confirmation: 'Synthetic boundary before execution-boundary coverage.',
    });
    const missingExecution = getGuardFailureReason(storyId, store, 'INIT_CHECK', root);
    assert.match(missingExecution ?? '', /missing_execution_boundary/);
    assertIncludesInitPreflight(missingExecution, storyId, 'missing execution-boundary guidance');

    scopeHandlers(root, store).execution_boundary_set({
      storyId,
      allowedPaths: ['packages/main/src'],
    });
    const missingFreeze = getGuardFailureReason(storyId, store, 'INIT_CHECK', root);
    assert.match(missingFreeze ?? '', /missing_scope_freeze_check/);
    assertIncludesInitPreflight(missingFreeze, storyId, 'missing scope-freeze guidance');

    assert.match(scopeHandlers(root, store).scope_freeze_check({ storyId }), /PASS/);
    const missingInitCheck = getGuardFailureReason(storyId, store, 'INIT_CHECK', root);
    assert.match(missingInitCheck ?? '', /missing_init_check/);
    assertIncludesInitPreflight(missingInitCheck, storyId, 'missing init-check guidance');

    createInitCheckHandlers({ root, store, scanRoot: join(root, 'packages/main') }).init_check_set({
      storyId,
      issues: [],
      agentId: 'lattice-review-story-init',
    });
    const missingInitAgent = getGuardFailureReason(storyId, store, 'INIT_CHECK', root);
    assert.match(missingInitAgent ?? '', /missing_init_check_agent/);
    assert.match(missingInitAgent ?? '', /product-reviewer/);
    assertIncludesInitPreflight(missingInitAgent, storyId, 'missing init-check agent guidance');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertScopePlanDispatchAndReviewGuidance() {
  const storyId = 'B-review';
  const root = makeRoot();
  try {
    const store = new StoryStore(root);
    seedStory(store, storyId, 'PLAN');
    store.writeUnderstanding(storyId, {
      task: 'Review story-level PLAN scope',
      outcome: 'Reviewer persists scope-check evidence through scope_check_save',
      facts: ['Story-level scope-plan dispatch does not require an itemId.'],
      constraints: ['Dispatch output itself is not gate evidence.'],
      unknowns: [],
      touchpoints: [],
      timestamp: '2026-07-08T12:00:00.000Z',
    });

    const dispatch = createStoryDispatchHandlers({ root, store, scanRoot: join(root, 'packages/main') });
    const result = dispatch.dispatch({ storyId, agentType: 'lattice-review-scope-plan' });
    assert.match(result.prompt, /Review PLAN scope coverage/);
    assert.match(result.prompt, /Must read story artifacts/);
    assert.match(result.prompt, /Dispatch output is not gate evidence/);
    assert.match(result.prompt, /lattice scope_check_save/);
    assert.equal(store.readScopeCheck(storyId), null, 'dispatch must not create scope-check gate evidence');

    const storyReview = createStoryReviewHandlers({ root, store, scanRoot: join(root, 'packages/main') })
      .story_review({ storyId });
    const issue = storyReview.issues.find((entry) => entry.type === 'missing_scope_check');
    assert.ok(issue, 'story_review should report missing_scope_check');
    assert.match(issue.message, new RegExp(`lattice dispatch --storyId=${storyId} --agentType=lattice-review-scope-plan`));
    assert.match(issue.message, /dispatch output is not gate evidence/);
    assert.match(issue.message, /lattice scope_check_save/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

assertInitCheckGuardGuidance();
assertScopePlanDispatchAndReviewGuidance();
console.log('b90d6-init-dispatch-guidance: ALL PASS');
