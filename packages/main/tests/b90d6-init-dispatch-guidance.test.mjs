/**
 * B-90d6 slice C — INIT preflight guidance + story-level scope-plan dispatch.
 *
 * Run after build:
 *   npm --prefix packages/main run build
 *   node packages/main/tests/b90d6-init-dispatch-guidance.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const { resetConfigCache } = await import(join(distRoot, 'core/config.js'));
const { StoryStore } = await import(join(distRoot, 'core/store.js'));
const { getGuardFailureReason } = await import(join(distRoot, 'core/machine.js'));
const { createInitCheckHandlers } = await import(join(distRoot, 'handlers/init-check.js'));
const { createInitPreflightHandlers } = await import(join(distRoot, 'handlers/init-preflight.js'));
const { createSessionHandlers } = await import(join(distRoot, 'handlers/session.js'));
const { createScopeAntiExpansionHandlers } = await import(join(distRoot, 'handlers/scope-anti-expansion.js'));
const { createStoryCreateHandlers } = await import(join(distRoot, 'handlers/story-create.js'));
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

function ctx(root, store) {
  return { root, store, scanRoot: join(root, 'packages/main') };
}

function initGitRoot(root) {
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.name', 'B90d6 Test'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.email', 'b90d6@example.local'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['add', 'lattice.config.json'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
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
  return createScopeAntiExpansionHandlers(ctx(root, store));
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

    createInitCheckHandlers(ctx(root, store)).init_check_set({
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

function assertInitPreflightFailureRouting() {
  const storyId = 'B-preflight';
  const root = makeRoot();
  try {
    const store = new StoryStore(root);
    seedStory(store, storyId);

    const report = createInitPreflightHandlers(ctx(root, store)).init_preflight({ storyId });
    assert.match(report, new RegExp(`INIT preflight \\(${storyId}`));
    assert.match(report, /mode: read-only \(no commands run, no evidence written\)/);
    assert.match(report, /\[MISSING\] scope-boundary/);
    assert.match(report, /gate: BLOCKED/);
    assert.match(report, new RegExp(`lattice init_preflight --storyId=${storyId}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertSessionAndNextInitGuidance() {
  const storyId = 'B-session';
  const root = makeRoot();
  try {
    initGitRoot(root);
    const store = new StoryStore(root);
    seedStory(store, storyId);
    const session = createSessionHandlers(ctx(root, store));

    const brief = session.session_brief({ concise: true });
    assert.match(brief, new RegExp(`Story ${storyId} is in INIT with no worktree`));
    assert.match(brief, new RegExp(`lattice init_preflight --storyId=${storyId}`));
    assert.match(brief, /read-only; it does not write evidence or create worktrees/);
    assert.match(brief, new RegExp(`lattice story_advance --storyId=${storyId} --phase=INIT_CHECK`));

    const next = session.next({ concise: true });
    assert.match(next, new RegExp(`lattice init_preflight --storyId=${storyId}`));
    assert.match(next, /INIT_CHECK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function validBackground() {
  return [
    '## Trigger Event',
    'B-90d6 review found that INIT guidance evidence named high-traffic command surfaces that needed direct executable coverage.',
    'The trigger is specific and current enough for intake validation while staying focused on command guidance behavior.',
    '',
    '## Key Insights',
    'Agents repeatedly start from session restoration, story creation output, and global help before they inspect lower-level docs.',
    'Those surfaces should point toward init_preflight before INIT_CHECK without suggesting evidence writes or worktree creation.',
    '',
    '## Solution Tradeoffs',
    'Focused assertions on stable command names provide useful regression coverage without freezing complete human-readable output.',
    'The test keeps temporary project state small and avoids depending on the developer checkout branch or story metadata.',
    '',
    '## Conversational Texture',
    'The reviewer feedback asks for practical guidance a working agent can follow during the first moments of a story lifecycle.',
    'The desired experience is plain and procedural: read status, run preflight, then advance only after the preflight is ready.',
  ].join('\n');
}

function assertStoryCreateAndGlobalHelpInitGuidance() {
  const root = makeRoot();
  try {
    const store = new StoryStore(root);
    const output = createStoryCreateHandlers(ctx(root, store)).story_create({
      name: 'init-guidance',
      title: 'INIT guidance coverage',
      description: 'Cover story_create guidance that points agents through INIT preflight.',
      type: 'chore',
      priority: 'medium',
      background: validBackground(),
      checklist: [{
        title: 'Check INIT guidance surfaces',
        context: 'Review findings require direct coverage of story_create INIT routing text.',
      }],
      forceNew: true,
    });
    const storyId = output.match(/Story (B-[a-f0-9]+) created/)?.[1];
    assert.ok(storyId, 'story_create output should include the created story id');
    assert.match(output, /spawn two INIT reviewers in parallel/);
    assert.match(output, /lattice-review-story-init/);
    assert.match(output, /product-reviewer/);
    assert.match(output, new RegExp(`lattice init_preflight --storyId=${storyId}`));
    assert.match(output, /read-only, writes no evidence, and creates no worktree/);
    assert.match(output, new RegExp(`"phase":"INIT_CHECK"`));

    const helpRoot = makeRoot();
    try {
      const help = execFileSync(process.execPath, [join(distRoot, 'cli.js'), '--root', helpRoot, 'help'], {
        cwd: helpRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      assert.match(help, /lattice story_create/);
      assert.match(help, /lattice init_preflight --storyId=B-xxx/);
      assert.match(help, /Read-only INIT_CHECK prerequisite report; writes no evidence and creates no worktree/);
      assert.match(help, /After preflight READY; create local worktree\/local branch/);
    } finally {
      rmSync(helpRoot, { recursive: true, force: true });
    }
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

    const dispatch = createStoryDispatchHandlers(ctx(root, store));
    const result = dispatch.dispatch({ storyId, agentType: 'lattice-review-scope-plan' });
    assert.match(result.prompt, /Review PLAN scope coverage/);
    assert.match(result.prompt, /Must read story artifacts/);
    assert.match(result.prompt, /Dispatch output is not gate evidence/);
    assert.match(result.prompt, /lattice scope_check_save/);
    assert.equal(store.readScopeCheck(storyId), null, 'dispatch must not create scope-check gate evidence');

    const storyReview = createStoryReviewHandlers(ctx(root, store))
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

function assertScopePlanDispatchPhaseGate() {
  for (const phase of ['DEV', 'REVIEW']) {
    const storyId = `B-${phase.toLowerCase()}`;
    const root = makeRoot();
    try {
      const store = new StoryStore(root);
      seedStory(store, storyId, phase);
      const dispatch = createStoryDispatchHandlers(ctx(root, store));

      assert.throws(
        () => dispatch.dispatch({ storyId, agentType: 'lattice-review-scope-plan' }),
        new RegExp(`scope_check_save is PLAN-only; current phase ${phase} is unsupported`),
      );
      assert.equal(
        store.readProcessEvents(storyId).some((event) => event.targetKind === 'scope-plan-review'),
        false,
        'refused scope-plan dispatch must not append a dispatch event',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

assertInitCheckGuardGuidance();
assertInitPreflightFailureRouting();
assertSessionAndNextInitGuidance();
assertStoryCreateAndGlobalHelpInitGuidance();
assertScopePlanDispatchAndReviewGuidance();
assertScopePlanDispatchPhaseGate();
console.log('b90d6-init-dispatch-guidance: ALL PASS');
