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
const { recomputeInitCheckHash } = await import(join(distRoot, 'core/init-check-gate.js'));
const { createInitCheckHandlers } = await import(join(distRoot, 'handlers/init-check.js'));
const { createInitPreflightHandlers } = await import(join(distRoot, 'handlers/init-preflight.js'));
const { createSessionHandlers } = await import(join(distRoot, 'handlers/session.js'));
const { createScopeAntiExpansionHandlers } = await import(join(distRoot, 'handlers/scope-anti-expansion.js'));
const { createStoryCreateHandlers } = await import(join(distRoot, 'handlers/story-create.js'));
const { createStoryDispatchHandlers } = await import(join(distRoot, 'handlers/story-dispatch.js'));
const { createStoryReviewHandlers } = await import(join(distRoot, 'handlers/story-review.js'));
const { buildNextSteps } = await import(join(distRoot, 'handlers/transition-effects.js'));
const { getGuardFailureReason: getTransitionGuardFailureReason } = await import(join(distRoot, 'core/guard-utils.js'));
const { decorateResult } = await import(join(distRoot, 'handlers/hints.js'));

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-b90d6-guidance-'));
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
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
  execFileSync('git', ['config', 'user.name', 'Harmonynet'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.email', '26995688+Harmonynet@users.noreply.github.com'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['add', 'proof-or-stop.config.json'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
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
  assert.match(reason, new RegExp(`proof-or-stop init_preflight --storyId=${storyId}`), label);
}

function assertInitCheckGuardGuidance() {
  const storyId = 'B-guidance';
  const root = makeRoot();
  try {
    initGitRoot(root);
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
    assert.match(missingInitCheck ?? '', /proof-or-stop host_run/);
    assert.match(missingInitCheck ?? '', /"agentType":"proof-or-stop-review-story-init","managedDispatch":true/);
    assert.match(missingInitCheck ?? '', /"agentType":"proof-or-stop-product-reviewer","managedDispatch":true/);
    assert.match(missingInitCheck ?? '', /returned nonempty runId/);
    assert.match(missingInitCheck ?? '', /host_run_status/);
    assert.match(missingInitCheck ?? '', /init_check_set accepts only a matching live managed dispatch/);
    assert.match(missingInitCheck ?? '', /Never use a host wait with an empty receiver set/);
    assert.doesNotMatch(missingInitCheck ?? '', /spawn_agent\(|followup_task\(/);
    assertIncludesInitPreflight(missingInitCheck, storyId, 'missing init-check guidance');

    const initDispatch = createStoryDispatchHandlers(ctx(root, store));
    const storyInitPrompt = initDispatch.dispatch({ storyId, agentType: 'proof-or-stop-review-story-init' }).prompt;
    const productInitPrompt = initDispatch.dispatch({ storyId, agentType: 'proof-or-stop-product-reviewer' }).prompt;
    assert.match(storyInitPrompt, /fresh context/i);
    assert.match(storyInitPrompt, /do not carry over the main agent's conclusions/i);
    assert.match(storyInitPrompt, /do not spawn or delegate another reviewer/i);
    assert.match(storyInitPrompt, /collaboration tools, if visible, are outside this role/i);
    assert.doesNotMatch(storyInitPrompt, /spawn_agent\(|Agent\(\{ subagent_type:/);
    assert.match(productInitPrompt, /fresh context/i);
    assert.match(productInitPrompt, /do not carry over the main agent's conclusions/i);
    assert.match(productInitPrompt, /do not spawn or delegate another reviewer/i);
    assert.match(productInitPrompt, /collaboration tools, if visible, are outside this role/i);
    assert.doesNotMatch(productInitPrompt, /spawn_agent\(|Agent\(\{ subagent_type:/);

    const legacyInitCheckWithoutRequiredReviewers = {
      storyId,
      checkedAt: '2026-07-08T12:00:00.000Z',
      reviewRound: '',
      agentId: 'legacy-unknown-reviewer',
      issues: [],
      agentResults: [],
      _hash: '',
    };
    legacyInitCheckWithoutRequiredReviewers._hash = recomputeInitCheckHash(
      storyId,
      store,
      root,
      legacyInitCheckWithoutRequiredReviewers,
    );
    store.writeInitCheck(storyId, legacyInitCheckWithoutRequiredReviewers);
    const bothInitAgentsMissing = getGuardFailureReason(storyId, store, 'INIT_CHECK', root);
    assert.doesNotMatch(bothInitAgentsMissing ?? '', /init_check_tampered/);
    assert.match(bothInitAgentsMissing ?? '', /missing_init_check_agent/);
    assert.match(bothInitAgentsMissing ?? '', /managedDispatch/);
    assert.match(bothInitAgentsMissing ?? '', /returned nonempty runId/);

    assert.throws(
      () => createInitCheckHandlers(ctx(root, store)).init_check_set({
        storyId,
        issues: [],
        agentId: 'proof-or-stop-review-story-init',
      }),
      /delivery_not_acknowledged/,
      'a caller-supplied role cannot create partial independent INIT evidence',
    );
    const stillMissingBoth = getGuardFailureReason(storyId, store, 'INIT_CHECK', root);
    assert.match(stillMissingBoth ?? '', /missing_init_check_agent/);
    assert.match(stillMissingBoth ?? '', /proof-or-stop-review-story-init/);
    assert.match(stillMissingBoth ?? '', /proof-or-stop-product-reviewer/);
    assert.match(stillMissingBoth ?? '', /managedDispatch/);
    assert.doesNotMatch(stillMissingBoth ?? '', /spawn_agent\(|followup_task\(/);
    assertIncludesInitPreflight(stillMissingBoth, storyId, 'missing init-check agent guidance');
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
    assert.match(report, new RegExp(`proof-or-stop init_preflight --storyId=${storyId}`));
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
    assert.match(brief, new RegExp(`proof-or-stop init_preflight --storyId=${storyId}`));
    assert.match(brief, /read-only; it does not write evidence or create worktrees/);
    assert.match(brief, new RegExp(`proof-or-stop story_advance --storyId=${storyId} --phase=INIT_CHECK`));

    const next = session.next({ concise: true });
    assert.match(next, new RegExp(`proof-or-stop init_preflight --storyId=${storyId}`));
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
    assert.match(output, /managed INIT reviewers/i);
    assert.match(output, /proof-or-stop-review-story-init/);
    assert.match(output, /proof-or-stop-product-reviewer/);
    assert.match(output, /proof-or-stop host_run/);
    assert.match(output, /"agentType":"proof-or-stop-review-story-init","managedDispatch":true/);
    assert.match(output, /"agentType":"proof-or-stop-product-reviewer","managedDispatch":true/);
    assert.match(output, /nonempty runId/);
    assert.match(output, /host_run_status/);
    assert.match(output, /init_check_set accepts only a matching live managed dispatch/);
    assert.match(output, /empty receiver set/i);
    assert.doesNotMatch(output, /spawn_agent\(|followup_task\(/);
    assert.doesNotMatch(output, /subagent_type: "lattice-review-story-init"/);
    assert.doesNotMatch(output, /agentType":"lattice-review-story-init"/);
    assert.doesNotMatch(output, /subagent_type: "product-reviewer"/);
    assert.doesNotMatch(output, /agentType":"product-reviewer"/);
    assert.match(output, new RegExp(`proof-or-stop init_preflight --storyId=${storyId}`));
    assert.match(output, /read-only, writes no evidence, and creates no worktree/);
    assert.match(output, new RegExp(`"phase":"INIT_CHECK"`));

    const draftName = 'missing-draft-check-guidance';
    write(root, `docs/story/drafts/${draftName}/index.json`, JSON.stringify({
      title: 'Draft INIT guidance',
      description: 'Verify missing draft-check guidance uses the canonical reviewer ID.',
    }));
    write(root, `docs/story/drafts/${draftName}/background.md`, validBackground());
    write(root, `docs/story/drafts/${draftName}/checklist.json`, JSON.stringify({ items: [] }));
    assert.throws(
      () => createStoryCreateHandlers(ctx(root, store)).story_create({ fromDraft: draftName }),
      (error) => {
        assert.match(error.message, /proof-or-stop-review-story-init/);
        assert.doesNotMatch(error.message, /lattice-review-story-init/);
        return true;
      },
      'fromDraft guidance should name the canonical story-init reviewer',
    );

    const helpRoot = makeRoot();
    try {
      const help = execFileSync(process.execPath, [join(distRoot, 'cli.js'), '--root', helpRoot, 'help', '--full'], {
        cwd: helpRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      assert.match(help, /proof-or-stop story_create/);
      assert.match(help, /proof-or-stop init_preflight --storyId=B-xxx/);
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
    initGitRoot(root);
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
    const verificationIntent = dispatch.dispatch({
      storyId,
      itemId: 'CHK-001',
      agentType: 'proof-or-stop-verification-intent',
    });
    assert.match(verificationIntent.prompt, /do not spawn or delegate another reviewer/i);
    assert.match(verificationIntent.prompt, /collaboration tools, if visible, are outside this role/i);
    const result = dispatch.dispatch({ storyId, agentType: 'proof-or-stop-review-scope-plan' });
    assert.match(result.prompt, /Review PLAN scope coverage/);
    assert.match(result.prompt, /No canonical process-fact owner paths are selected.*do not search the process-fact registry/i,
      'consumer Story with no ProofStory topology must not send the scope reviewer through PoS-only registry discovery');
    assert.match(result.prompt, /decisions directory is absent.*review the Story description/i,
      'absent consumer decisions corpus must be projected before the reviewer starts searching for it');
    assert.match(result.prompt, /candidate_spec_route is owner-only.*do not call it/i,
      'reviewer guidance must not invite an owner-gated routing command');
    write(root, 'docs/requirements/decisions/fixture.md', '# Existing project decision\n');
    const withDecisions = dispatch.dispatch({ storyId, agentType: 'proof-or-stop-review-scope-plan' });
    assert.doesNotMatch(withDecisions.prompt, /decisions directory is absent/i,
      'a present decisions corpus must retain the normal review path');
    assert.doesNotMatch(result.prompt, /spawn_agent\(/);
    assert.doesNotMatch(result.prompt, /Agent\(\{ subagent_type:/);
    assert.match(result.prompt, /execute this (?:scope )?review directly in the current reviewer task/i);
    assert.match(result.prompt, /(?:must|do) not spawn or delegate another reviewer/i);
    assert.match(result.prompt, /fresh context/i);
    assert.match(result.prompt, /do not carry over the main agent's or Story owner's conclusions/i);
    assert.match(result.prompt, /Must read story artifacts/);
    assert.match(result.prompt, /Dispatch output is not gate evidence/);
    assert.match(result.prompt, /proof-or-stop scope_check_save/);
    assert.equal(store.readScopeCheck(storyId), null, 'dispatch must not create scope-check gate evidence');

    const storyReview = createStoryReviewHandlers(ctx(root, store))
      .story_review({ storyId });
    const issue = storyReview.issues.find((entry) => entry.type === 'missing_scope_check');
    assert.ok(issue, 'story_review should report missing_scope_check');
    assert.match(issue.message, new RegExp(`"storyId":"${storyId}".*"agentType":"proof-or-stop-review-scope-plan".*"managedDispatch":true`));
    assert.match(issue.message, new RegExp(`proof-or-stop dispatch --storyId=${storyId} --agentType=proof-or-stop-review-scope-plan`));
    assert.match(issue.message, /spawn_agent/);
    assert.match(issue.message, /fork_turns.*none/);
    assert.match(issue.message, /Agent\(\{ subagent_type: "proof-or-stop-review-scope-plan"/);
    assert.match(issue.message, /returned child agent id/);
    assert.match(issue.message, /(?:must|do) not spawn or delegate another reviewer/i);
    assert.match(issue.message, /empty target\/receiver set/i);
    assert.match(issue.message, /dispatch output is not gate evidence/);
    assert.match(issue.message, /proof-or-stop scope_check_save/);
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
        () => dispatch.dispatch({ storyId, agentType: 'proof-or-stop-review-scope-plan' }),
        new RegExp(`(?:scope_check_save is PLAN-only; current phase ${phase} is unsupported|proof-or-stop-review-scope-plan cannot be dispatched during ${phase})`),
      );
      assert.throws(
        () => dispatch.dispatch({ storyId, agentType: 'lattice-review-scope-plan' }),
        /unknown agentType/,
        'retired scope reviewer spelling has no active dispatch authority in any phase',
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

function assertLifecycleReviewerLaunchGuidance() {
  const storyId = 'B-lifecycle-guidance';
  const root = makeRoot();
  try {
    initGitRoot(root);
    const store = new StoryStore(root);
    seedStory(store, storyId, 'REVIEW');
    const next = buildNextSteps(store, root, storyId);
    for (const value of [next.REVIEW, next.TEST]) {
      assert.match(value, /proof-or-stop dispatch/);
      assert.match(value, /spawn_agent\(\{ task_name:/);
      assert.match(value, /fork_turns: "none"/);
      assert.match(value, /followup_task\(\{ target: <returned reviewer target>, message: <the same exact prompt> \}\)/);
      assert.match(value, /agent id or canonical task name/i);
      assert.match(value, /do not wait until the reviewer has acknowledged the assignment/i);
      assert.match(value, /Agent\(\{ subagent_type:/);
      assert.match(value, /Other hosts launch one equivalent fresh-context reviewer task without parent conversation history/);
      assert.match(value, /Retain every returned child agent id/);
      assert.match(value, /never call wait with an empty target\/receiver set/);
    }
    assert.match(next.REVIEW, /every child id must be nonempty and distinct/i);
    assert.match(next.REVIEW, /task_name: "review_test_coverage"/);
    assert.doesNotMatch(next.REVIEW, /task_name: "[^"]*-/);
    assert.match(next.REVIEW, /issue all host launch calls/);
    assert.match(next.TEST, /proof-or-stop-review-delivery/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertReviewerRecoveryGuidance() {
  const storyId = 'B-review-recovery';
  const root = makeRoot();
  try {
    initGitRoot(root);
    const store = new StoryStore(root);
    seedStory(store, storyId, 'REVIEW');

    const blocked = getTransitionGuardFailureReason(storyId, store, 'TEST', root);
    assert.match(blocked ?? '', /proof-or-stop reviewer_batch/);
    assert.match(blocked ?? '', /canonical fresh-context launchInstruction/);
    assert.match(blocked ?? '', /nonempty, mutually distinct child ids/);

    const decorated = decorateResult({
      cmd: 'dev_finish',
      args: { storyId },
      result: 'advanced',
      store,
      root,
      activeStory: { storyId, phase: 'REVIEW' },
    });
    assert.match(decorated, /proof-or-stop reviewer_batch/);
    assert.match(decorated, /canonical fresh-context launchInstruction/);
    assert.match(decorated, /非空且互异的 child IDs/);

    const story = store.readStory(storyId);
    const worktree = join(root, '.worktrees', storyId);
    store.writeStory(storyId, {
      ...story,
      currentReviewRound: '2026-07-08T12:00:00.000Z',
      worktree: { path: `.worktrees/${storyId}`, branch: `story/${storyId}` },
    });
    execFileSync('git', ['add', '.proof-or-stop'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    execFileSync('git', ['commit', '-m', 'seed review story'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    execFileSync('git', ['branch', `story/${storyId}`], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    mkdirSync(dirname(worktree), { recursive: true });
    execFileSync('git', ['worktree', 'add', worktree, `story/${storyId}`], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    const worktreeStore = new StoryStore(worktree);
    const brief = createSessionHandlers(ctx(worktree, worktreeStore)).session_brief({ concise: true });
    assert.match(brief, /proof-or-stop reviewer_batch/);
    assert.match(brief, /canonical dispatch prompt unchanged/);
    assert.match(brief, /nonempty returned child id/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

assertInitCheckGuardGuidance();
assertInitPreflightFailureRouting();
assertSessionAndNextInitGuidance();
assertStoryCreateAndGlobalHelpInitGuidance();
assertScopePlanDispatchAndReviewGuidance();
assertScopePlanDispatchPhaseGate();
assertLifecycleReviewerLaunchGuidance();
assertReviewerRecoveryGuidance();
console.log('b90d6-init-dispatch-guidance: ALL PASS');
