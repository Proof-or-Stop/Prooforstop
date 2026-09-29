import { strict as assert } from 'node:assert';

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { resetConfigCache } from '../../core/config.js';

import { StoryStore } from '../../core/store.js';

import { runReviewToTestPreflightGate, runValidateGate } from '../../handlers/phase-gates.js';

import { buildNextSteps, renderRelatedDocsHint } from '../../handlers/transition-effects.js';

import { acquireOwnerLease } from '../../core/story-owner-lease.js';
import { ORIGINAL_TASKS_DIR } from './support.js';
import { git, write, persistSyntheticAdmittedWindowForTest, createReviewStore } from './support.js';

export async function assertPhaseGatesAndEffectsExtraction(): Promise<void> {
  const srcRoot = join(resolve(ORIGINAL_TASKS_DIR, '..', '..'), 'src');

  // --- 1. Static layering check ---
  const phaseGatesSrc = readFileSync(join(srcRoot, 'handlers', 'phase-gates.ts'), 'utf-8');
  const transitionEffectsSrc = readFileSync(join(srcRoot, 'handlers', 'transition-effects.ts'), 'utf-8');
  const transitionOrchestratorSrc = readFileSync(join(srcRoot, 'handlers', 'transition-orchestrator.ts'), 'utf-8');
  const storyAdvanceSrc = readFileSync(join(srcRoot, 'handlers', 'story-advance.ts'), 'utf-8');

  for (const [name, src] of [
    ['phase-gates.ts', phaseGatesSrc],
    ['transition-effects.ts', transitionEffectsSrc],
    ['transition-orchestrator.ts', transitionOrchestratorSrc],
  ] as const) {
    const importLines = src
      .split('\n')
      .filter(l => l.trimStart().startsWith('import'))
      .join('\n');
    assert.doesNotMatch(
      importLines,
      /story-advance/,
      `${name} must not import from handlers/story-advance.js (circular import guard — preMortem #2)`,
    );
  }
  // story-advance.ts must delegate, not import or inline the gate/effect bodies.
  assert.match(
    storyAdvanceSrc,
    /runStoryTransition/,
    'story-advance.ts must delegate the transition to handlers/transition-orchestrator.js',
  );
  assert.match(
    storyAdvanceSrc,
    /renderTransitionResult/,
    'story-advance.ts must format transition-orchestrator results',
  );
  assert.doesNotMatch(
    storyAdvanceSrc,
    /from '\.\/(?:phase-gates|transition-effects|done-effects)\.js'/,
    'story-advance.ts must not import gate/effect modules directly',
  );
  assert.match(
    transitionOrchestratorSrc,
    /from '\.\/phase-gates\.js'/,
    'transition-orchestrator.ts must own the phase-gates dependency',
  );
  assert.match(
    transitionOrchestratorSrc,
    /from '\.\/transition-effects\.js'/,
    'transition-orchestrator.ts must own the transition-effects dependency',
  );
  // The inline gate body markers are gone — story-advance.ts no longer
  // re-implements the preflight orchestration or the inline validate gate.
  assert.doesNotMatch(
    storyAdvanceSrc,
    /const \{ runReviewCliGates, renderPreflight \} = await import/,
    'the REVIEW->TEST preflight body must live in phase-gates.ts, not inline in story-advance.ts',
  );
  assert.doesNotMatch(
    storyAdvanceSrc,
    /const verifierHandlers = createVerifierHandlers\(ctx\)/,
    'the proof-or-stop validate gate body must live in phase-gates.ts, not inline in story-advance.ts',
  );
  // TEST is an evidence consumer, never a second validate executor. This
  // source-level fence complements the behavioral marker assertion below.
  assert.doesNotMatch(
    phaseGatesSrc,
    /createVerifierHandlers|verifierHandlers\.validate/,
    'runValidateGate must not retain a verifier execution path in TEST',
  );
  assert.match(
    phaseGatesSrc,
    /if \(e\?\.message\?\.startsWith\('Cannot enter TEST'\)\) throw e;/,
    'runReviewToTestPreflightGate catch must rethrow gate errors before the execution exception throw',
  );
  assert.doesNotMatch(
    phaseGatesSrc,
    /actor\.stop\(\)/,
    'phase-gates.ts must not stop the actor directly; transition-orchestrator owns the lifecycle',
  );
  assert.match(
    transitionOrchestratorSrc,
    /finally \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*actor\?\.stop\(\);/s,
    'transition-orchestrator.ts must stop the actor in a single finally',
  );

  // --- 2. Fail-closed gate behavior ---
  // 2a. runValidateGate: an ADMITTED window without a signed routine PASS
  //     blocks TEST before the configured child can execute.
  const failRoot = mkdtempSync(join(tmpdir(), 'lattice-phase-gates-validate-fail-'));
  try {
    // Official validation now requires the configured workspace to resolve one
    // Git identity before it enters the capacity queue. Seed only that identity
    // so this fixture still reaches, and is classified by, configured exit 5.
    git(failRoot, ['init']);
    git(failRoot, ['config', 'user.email', '26995688+Harmonynet@users.noreply.github.com']);
    git(failRoot, ['config', 'user.name', 'Harmonynet']);
    git(failRoot, ['checkout', '-B', 'main']);
    git(failRoot, ['commit', '--allow-empty', '-m', 'base']);
    const store = new StoryStore(failRoot);
    write(failRoot, 'proof-or-stop.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      validate: { commands: [{ label: 'must not run from TEST', command: 'node', args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(join(failRoot, 'unexpected-test-gate-child.marker'))}, 'ran')`] }] },
      workflow: { profile: 'balanced' },
    }));
    resetConfigCache();
    const storyId = 'B-failgate';
    const now = '2026-05-16T02:00:00.000Z';
    store.writeStory(storyId, {
      storyId, name: 'phase-gate-fail', title: 'Phase gate fail',
      description: 'missing REVIEW routine PASS must block TEST', type: 'chore', phase: 'TEST',
      priority: 'medium', createdAt: now, startedAt: now, endedAt: null,
      currentReviewRound: now, events: [],
    });
    store.writeChecklist(storyId, {
      items: [{
        id: 'CHK-001',
        title: 'Configured validation failure reaches the gate',
        context: 'Minimal checklist required for the verifier to execute the configured failing command.',
        status: 'done',
        startTime: now,
        endTime: now,
      }],
    });
    // Bind a test-only signed window: no test evidence is written, so TEST
    // must reject with the routine-PASS recovery instead of executing the
    // configured marker command.
    persistSyntheticAdmittedWindowForTest({ store, storyId, projectRoot: failRoot });
    acquireOwnerLease(store.storyDirPath(storyId), { command: 'validate', cwd: failRoot });
    let stopped = false;
    const actor = { stop() { stopped = true; } };
    let rejectionMessage = '';
    await assert.rejects(
      () => runValidateGate({ store, root: failRoot, scanRoot: join(failRoot, 'packages/main') }, storyId, actor),
      /\[pre_cert_routine_pass_required\] Cannot enter TEST/,
      'runValidateGate must reject TEST when the signed REVIEW routine PASS is absent',
    );
    assert.equal(stopped, false, 'runValidateGate must leave actor stop to transition-orchestrator');
    assert.equal(store.readTestEvidence(storyId), null, 'TEST refusal must not create replacement validation evidence');
    assert.equal(existsSync(join(failRoot, 'unexpected-test-gate-child.marker')), false, 'TEST refusal must not execute configured validation children');
  } finally {
    rmSync(failRoot, { recursive: true, force: true });
    resetConfigCache();
  }

  // 2b. runReviewToTestPreflightGate: a failing CLI gate must block TEST.
  //     A riskSignal forces the normal channel (review-preflight's
  //     detectFastChannel routes ≤5-item, no-risk stories to the fast channel,
  //     where all gates skip). A main-agent-authored commit with no implementer
  //     evidence then trips the channel gate → preflight.ok=false → block.
  const preflightRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-phase-gates-preflight-'));
  try {
    const { store, storyId } = createReviewStore(preflightRoot);
    // Promote to the normal channel so the CLI gates actually run.
    const normalStory = store.readStory(storyId);
    normalStory.riskSignals = [{ category: 'state machine', matched: 'gate' }];
    store.writeStory(storyId, normalStory);
    git(preflightRoot, ['init']);
    git(preflightRoot, ['config', 'user.email', 'proofOrStop@example.test']);
    git(preflightRoot, ['config', 'user.name', 'Proof-or-Stop Smoke']);
    git(preflightRoot, ['checkout', '-B', 'main']);
    git(preflightRoot, ['add', '.']);
    git(preflightRoot, ['commit', '-m', 'base']);
    git(preflightRoot, ['checkout', '-b', `story/${storyId}`]);
    // Add a main-agent-authored commit so the channel gate has a real diff to
    // judge — normal channel with no implementer evidence → channel gate fail.
    write(preflightRoot, 'src/core/feature.ts', 'export const feature = 1;\n');
    git(preflightRoot, ['add', '.']);
    git(preflightRoot, ['commit', '-m', `${storyId}: main agent writes feature`]);
    let stopped = false;
    const actor = { stop() { stopped = true; } };
    await assert.rejects(
      () => runReviewToTestPreflightGate(
        { store, root: preflightRoot, scanRoot: join(preflightRoot, 'packages/main') },
        storyId,
        actor,
      ),
      /Cannot enter TEST: CLI gate preflight/,
      'runReviewToTestPreflightGate must block TEST when a CLI gate fails (fail-closed)',
    );
    assert.equal(stopped, false, 'runReviewToTestPreflightGate must leave actor stop to transition-orchestrator');
  } finally {
    rmSync(preflightRoot, { recursive: true, force: true });
    resetConfigCache();
  }

  // --- 3. Effect snapshot byte-identical ---
  const effectRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-phase-gates-effects-'));
  try {
    const { store, storyId } = createReviewStore(effectRoot);

    // 3a. buildNextSteps: PLAN / TEST / DONE entries are static strings —
    //     pin them byte-for-byte against the inline originals.
    const nextSteps = buildNextSteps(store, effectRoot, storyId);
    assert.equal(
      nextSteps.PLAN,
      `→ Recommend switching to Claude Code plan mode immediately (shift-tab twice to plan mode) — the PLAN stage only breaks down checklist / writes understanding_set / decision_set, and should not modify code. Edit/Write being disabled in plan mode prevents accidental edits.
→ Next step: checklist_get(${storyId}) to view pending items, then story_advance(${storyId}, DEV) to begin development
⚠ User value acceptance (mandatory): the outcome field of understanding_set must be written as a concrete user-facing transcript — the exact text the user will see in the terminal/UI after running this story, not an abstract description like "event X is wired up". Judgment method: outcome must read in a way that lets one imagine the moment when the user considers the work done. See the "User value acceptance" section in CLAUDE.md for details.`,
      'buildNextSteps PLAN text must be byte-identical to the inline original',
    );
    assert.equal(
      nextSteps.TEST_CASE,
      `→ Legacy phase. Recommend directly story_advance(${storyId}, TEST) to enter verification`,
      'buildNextSteps TEST_CASE text must be byte-identical to the inline original',
    );
    assert.equal(
      nextSteps.DONE,
      `→ Must execute immediately: tell the user the Story summary paragraph below in your own words (what changed / how to use / real-machine coverage / limitations / pitfalls), then convergence_check to check project convergence state
⚠ DONE self-check 5 questions (CLAUDE.md "User value acceptance" section): (1) Is the PLAN outcome a concrete transcript or abstract? (2) During real-machine testing, did you read the user-perspective output or only look at the event log? (3) When the user sees the last line of the actual transcript, would they consider the work done or still wonder what comes next? (4) Are there any engineering logs that are noise/duplicates in the user's eyes? (5) Is there a plain-language summary of the task result? If any question is answered "not done", return to DEV and do not force-push DONE.`,
      'buildNextSteps DONE text must be byte-identical to the inline original',
    );
    // The REVIEW entry depends on opt-in routing; it must at least surface the
    // reviewer Agent call lines and the liveness reminder unchanged.
    assert.match(nextSteps.REVIEW, /launches the reviewers in parallel/);
    assert.match(nextSteps.REVIEW, /reviewer liveness: each reviewer should first output REVIEW_START after starting/);
    assert.match(nextSteps.REVIEW, /Host-native task liveness policy/);
    assert.match(nextSteps.REVIEW, /foreground, running, or background/);
    assert.match(nextSteps.REVIEW, /unknown or temporarily unavailable/);
    assert.match(nextSteps.REVIEW, /authoritative failed, cancelled, missing, or dead status/);
    assert.doesNotMatch(nextSteps.REVIEW, /no result for 10 minutes\/600s treat as stalled, restart/i);
    assert.match(nextSteps.TEST, /routine suite already executed once in REVIEW after PRE_CERT became ADMITTED/);
    assert.match(nextSteps.TEST, /do not start a second unscoped proof-or-stop validate --story run here/);

    // 3b. renderRelatedDocsHint: with checklist relatedDocs, the DEV header +
    //     line shape must be byte-identical to the inline original.
    store.writeChecklist(storyId, {
      items: [{
        id: 'CHK-001',
        title: 'Item with related docs',
        context: 'snapshot fixture',
        status: 'done',
        startTime: '2026-04-27T12:00:00.000Z',
        endTime: '2026-04-27T12:00:00.000Z',
        relatedDocs: ['docs/requirements/decisions/story-lifecycle.md'],
      }],
    });
    const devHint = renderRelatedDocsHint(store, effectRoot, storyId, 'DEV');
    assert.equal(
      devHint,
      `\n\n📄 Documents associated with this story (note synchronization when modifying code):\n  - docs/requirements/decisions/story-lifecycle.md  (CHK-001)`,
      'renderRelatedDocsHint DEV output must be byte-identical to the inline original',
    );
    const doneHint = renderRelatedDocsHint(store, effectRoot, storyId, 'DONE');
    assert.equal(
      doneHint,
      `\n\n📄 Documents associated with this story (verify synchronization before DONE wrap-up):\n  - docs/requirements/decisions/story-lifecycle.md  (CHK-001)`,
      'renderRelatedDocsHint DONE output must be byte-identical to the inline original',
    );
  } finally {
    rmSync(effectRoot, { recursive: true, force: true });
    resetConfigCache();
  }
}
