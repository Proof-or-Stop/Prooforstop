#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const worktreeRoot = dirname(dirname(__filename));
const cli = join(worktreeRoot, 'packages/main/dist/cli.js');
const scenario = process.argv[2] || 'all';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function run(cwd, command, payload, opts = {}) {
  const args = [cli, '--root', cwd, command];
  if (payload !== undefined) args.push(JSON.stringify(payload));
  return execFileSync('node', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
}

function runExpectFailure(cwd, command, payload) {
  try {
    run(cwd, command, payload);
  } catch (error) {
    return `${error.stdout || ''}\n${error.stderr || ''}`;
  }
  throw new Error(`${command} unexpectedly succeeded`);
}

function extractStoryId(text) {
  const storyId = text.match(/B-[a-f0-9]+/)?.[0];
  if (!storyId) throw new Error(`failed to parse story id from: ${text}`);
  return storyId;
}

function createTempProject() {
  const dir = mkdtempSync(join(tmpdir(), 'koala-phase-gate-'));
  mkdirSync(join(dir, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  mkdirSync(join(dir, 'packages', 'main', 'src'), { recursive: true });
  mkdirSync(join(dir, 'packages', 'main', 'tests', 'fixtures'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'requirements', 'placeholder.md'), '# placeholder\n');
  writeFileSync(join(dir, 'koala.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'koala@example.test']);
  git(dir, ['config', 'user.name', 'Koala Test']);
  try { git(dir, ['branch', '-M', 'main']); } catch { /* ignore */ }
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

const temp = createTempProject();

try {
  const { StoryStore } = await import(pathToFileURL(join(worktreeRoot, 'packages/main/dist/core/store.js')).href);
  const { getPhaseInvariantStatus } = await import(pathToFileURL(join(worktreeRoot, 'packages/main/dist/core/machine.js')).href);
  const shouldRun = (...names) => scenario === 'all' || names.includes(scenario);

  const store = new StoryStore(temp);
  if (shouldRun('empty-plan-status')) {
    const okId = extractStoryId(run(temp, 'story_create', {
      name: 'phase-ok',
      title: 'Phase invariant empty case',
      description: 'Ensure a phase with no extra checks still returns a legal empty structure.',
      type: 'chore',
      priority: 'low',
      phase: 'PLAN',
      checklist: [{
        title: 'Document the current gate policy',
        context: 'Need one trivial item so the story is valid.',
        testIntent: {
          happy: [{ desc: 'brief can show an empty invariant set', type: 'cli_blackbox' }],
          edge: [{ desc: 'no extra checks still yields a legal object', type: 'cli_blackbox' }],
          adversarial: [{ desc: 'consumers do not need to parse prose', type: 'cli_blackbox' }],
        },
      }],
    }));
    const okStatus = getPhaseInvariantStatus(okId, store, 'PLAN');
    assert(okStatus.ok === true, 'PLAN phase without extra gates should be ok');
    assert(okStatus.reasonCode === null, 'Empty invariant status should not have a reason code');
    assert(okStatus.humanHint === null, 'Empty invariant status should not have a human hint');
    assert(Array.isArray(okStatus.issues) && okStatus.issues.length === 0, 'Empty invariant status should have zero issues');
  }

  if (shouldRun('blocked-dev-missing-review')) {
    const blockedId = extractStoryId(run(temp, 'story_create', {
      name: 'phase-blocked',
      title: 'Blocked DEV transition',
      description: 'Need a blocked transition to verify structured phase gate failures.',
      type: 'feature',
      priority: 'high',
      phase: 'PLAN',
      checklist: [{
        title: 'Keep one valid intent so the missing review is the gate failure',
        context: 'This story intentionally skips story_review before entering DEV.',
        testIntent: {
          happy: [{ desc: 'valid happy intent exists', type: 'cli_blackbox' }],
          edge: [{ desc: 'edge intent exists', type: 'cli_blackbox' }],
          adversarial: [{ desc: 'adversarial intent exists', type: 'cli_blackbox' }],
        },
      }],
    }));

    const blockedOut = runExpectFailure(temp, 'story_advance', { storyId: blockedId, phase: 'DEV' });
    assert(blockedOut.includes('Reason code: story_review_missing'), 'blocked DEV transition missing reason code');
    assert(blockedOut.includes('Human hint:'), 'blocked DEV transition missing human hint');
    assert(blockedOut.includes('story_review --storyId='), 'blocked DEV transition missing recovery command');
  }

  if (shouldRun('dev-primary-reason')) {
    const invariantId = extractStoryId(run(temp, 'story_create', {
      name: 'phase-invariant-dev',
      title: 'DEV invariant primary reason',
      description: 'Show that missing test intent is the primary structured reason in DEV.',
      type: 'feature',
      priority: 'high',
      phase: 'DEV',
      checklist: [{
        title: 'This item intentionally omits testIntent',
        context: 'Primary reason should be missing_test_intent rather than an opaque error.',
      }],
    }));

    git(temp, ['checkout', '-b', `story/${invariantId}`]);
    const invariantStatus = getPhaseInvariantStatus(invariantId, store, 'DEV');
    assert(invariantStatus.reasonCode === 'missing_test_intent', 'DEV invariant primary reason should prefer missing_test_intent');
    assert((invariantStatus.humanHint || '').includes('testIntent.happy'), 'DEV invariant human hint should mention testIntent.happy');
    git(temp, ['checkout', 'main']);
  }

  if (shouldRun('rollback-review-failed')) {
    const rollbackId = extractStoryId(run(temp, 'story_create', {
      name: 'phase-rollback',
      title: 'Auto rollback from TEST_CASE_REVIEW',
      description: 'Verify TEST_CASE_REVIEW -> TEST auto rollback emits a stable reason code.',
      type: 'feature',
      priority: 'high',
      phase: 'TEST_CASE_REVIEW',
      checklist: [{
        title: 'One reviewer-failed intent should trigger rollback',
        context: 'TEST gate should return a rollback decision with review_failed code.',
        testIntent: {
          happy: [{
            desc: 'happy lane rejected by reviewer',
            type: 'cli_blackbox',
            results: [{ time: '2026-04-15T00:00:00Z', pass: false, note: 'fixture:1 WHY missing coverage severity=high', role: 'reviewer' }],
          }],
          edge: [{
            desc: 'edge lane already accepted',
            type: 'cli_blackbox',
            results: [{ time: '2026-04-15T00:00:00Z', pass: true, note: 'fixture:2 WHY covered severity=low', role: 'reviewer' }],
          }],
          adversarial: [{
            desc: 'adversarial lane already accepted',
            type: 'cli_blackbox',
            results: [{ time: '2026-04-15T00:00:00Z', pass: true, note: 'fixture:3 WHY covered severity=low', role: 'reviewer' }],
          }],
        },
      }],
    }));

    const rollbackOut = run(temp, 'story_advance', { storyId: rollbackId, phase: 'TEST' });
    assert(rollbackOut.includes('Gate failed → auto rollback to DEV'), 'rollback output missing rollback heading');
    assert(rollbackOut.includes('Reason code: review_failed'), 'rollback output missing review_failed reason code');
    assert(rollbackOut.includes('Human hint:'), 'rollback output missing human hint');

    const rollbackStory = store.readStory(rollbackId);
    assert(rollbackStory.phase === 'DEV', 'rollback story should be moved back to DEV');
    assert(rollbackStory.events?.at(-1)?.reason === 'review_failed', 'rollback event should persist review_failed reason');
  }

  if (shouldRun('successful-transition-hint')) {
    const successId = extractStoryId(run(temp, 'story_create', {
      name: 'phase-success',
      title: 'Successful transition still returns a human hint',
      description: 'Verify successful advances keep a structured human hint without inventing a reason code.',
      type: 'feature',
      priority: 'high',
      phase: 'TEST_CASE',
      checklist: [{
        title: 'Fixture writing finished and the next step is reviewer handoff',
        context: 'REQUEST_REVIEW should succeed and still print the next-step hint block.',
        testIntent: {
          happy: [{ desc: 'happy lane is already covered by a fixture', type: 'cli_blackbox' }],
          edge: [{ desc: 'edge lane is already covered by a fixture', type: 'cli_blackbox' }],
          adversarial: [{ desc: 'adversarial lane is already covered by a fixture', type: 'cli_blackbox' }],
        },
      }],
    }));

    const successOut = run(temp, 'story_advance', { storyId: successId, phase: 'TEST_CASE_REVIEW' });
    assert(successOut.includes('Human hint:'), 'successful transition missing Human hint block');
    assert(!successOut.includes('Reason code:'), 'successful transition should not invent a reason code');
  }

  console.log(`phase gate protocol verified (${scenario})`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
