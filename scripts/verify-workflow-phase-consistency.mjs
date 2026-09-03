import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = process.cwd();
const cli = join(repoRoot, 'packages/main/dist/cli.js');
const temp = mkdtempSync(join(tmpdir(), 'proof-or-stop-phase-consistency-'));

function git(args, cwd = temp) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function proofOrStop(command, payload, cwd = temp, rootArg = temp) {
  const args = [cli, '--root', rootArg, command];
  if (payload !== undefined) args.push(JSON.stringify(payload));
  return execFileSync('node', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function proofOrStopExpectFail(command, payload, cwd = temp) {
  try {
    proofOrStop(command, payload, cwd);
    throw new Error(`${command} unexpectedly passed`);
  } catch (error) {
    return `${error.stdout || ''}${error.stderr || ''}${error.message || ''}`;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(text, needle, label) {
  assert(text.includes(needle), `${label}: expected ${JSON.stringify(needle)} in:\n${text}`);
}

function storyIdFrom(output) {
  const storyId = output.match(/B-[a-f0-9]+/)?.[0];
  if (!storyId) throw new Error(`story id not found:\n${output}`);
  return storyId;
}

function parseProofOrStopJson(output) {
  const start = output.indexOf('{');
  assert(start >= 0, `JSON payload not found:\n${output}`);
  return JSON.parse(output.slice(start));
}

function initRepo() {
  mkdirSync(join(temp, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(temp, 'docs', 'requirements'), { recursive: true });
  mkdirSync(join(temp, 'packages', 'main', 'tests', 'fixtures'), { recursive: true });
  mkdirSync(join(temp, 'bin'), { recursive: true });
  writeFileSync(join(temp, 'README.md'), '# temp\n');
  writeFileSync(join(temp, 'bin', 'proofOrStop.js'), '#!/usr/bin/env node\n');
  writeFileSync(join(temp, '.gitignore'), '.worktrees\nnode_modules\n');
  writeFileSync(join(temp, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2) + '\n');
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'ProofOrStop Test']);
  git(['config', 'user.email', 'proofOrStop@example.com']);
  git(['add', '.']);
  git(['commit', '-m', 'init']);
}

function makeIntent(desc) {
  return {
    happy: [{ desc: `${desc} happy`, type: 'cli_blackbox' }],
    edge: [{ desc: `${desc} edge`, type: 'cli_blackbox' }],
    adversarial: [{ desc: `${desc} adversarial`, type: 'cli_blackbox' }],
  };
}

try {
  initRepo();

  const devStory = storyIdFrom(proofOrStop('story_create', {
    name: 'dev-done-no-fixture',
    title: 'DEV done no fixture',
    description: 'DEV done should not require fixture coverage.',
    type: 'bug',
    priority: 'high',
    phase: 'DEV',
    checklist: [{ title: 'implement behavior', context: 'coverage belongs to TEST_CASE', testIntent: makeIntent('dev done') }],
  }));
  const doneOut = proofOrStop('checklist_update', { storyId: devStory, itemId: 'CHK-001', status: 'done' });
  assertIncludes(doneOut, 'status → done', 'DEV done gate no longer requires fixture coverage');

  const reviewStory = storyIdFrom(proofOrStop('story_create', {
    name: 'coverage-check',
    title: 'Coverage check',
    description: 'testintent_check should report missing fixture coverage.',
    type: 'bug',
    priority: 'high',
    phase: 'TEST_CASE_REVIEW',
    checklist: [{ title: 'review coverage', context: 'coverage belongs to review', testIntent: makeIntent('coverage') }],
  }));
  for (const lane of ['happy', 'edge', 'adversarial']) {
    proofOrStop('testintent_record', {
      storyId: reviewStory,
      itemId: 'CHK-001',
      lane,
      index: 0,
      pass: true,
      note: 'scripts/verify-workflow-phase-consistency.mjs: reviewer pass for fixture coverage regression',
      agent: 'test-case-reviewer',
    });
  }
  const check = parseProofOrStopJson(proofOrStop('testintent_check', { storyId: reviewStory }));
  assert(check.allPass === false, 'testintent_check should fail when fixture intentRef coverage is missing');
  assert(check.summary.fixtureCoverage.missing === 3, 'fixture coverage missing count should be exposed');

  const testCaseStory = storyIdFrom(proofOrStop('story_create', {
    name: 'test-case-can-run-story-test',
    title: 'TEST_CASE can run story test',
    description: 'TEST_CASE phase should allow story-level fixture verification.',
    type: 'bug',
    priority: 'high',
    phase: 'TEST_CASE',
    checklist: [{ title: 'write fixture', context: 'verify immediately', testIntent: makeIntent('test case') }],
  }));
  git(['checkout', '-b', `story/${testCaseStory}`]);
  const testStoryOut = proofOrStop('test_story', { storyId: testCaseStory });
  const testStoryResult = parseProofOrStopJson(testStoryOut);
  assert(testStoryResult.storyId === testCaseStory, 'TEST_CASE story branch can run test_story through phase gate');
  git(['checkout', 'main']);

  const driftStory = storyIdFrom(proofOrStop('story_create', {
    name: 'phase-drift',
    title: 'Phase drift',
    description: 'session_brief should show linked worktree phase.',
    type: 'bug',
    priority: 'high',
    checklist: [{ title: 'make drift visible', context: 'linked worktree phase should win in brief' }],
  }));
  proofOrStop('story_advance', { storyId: driftStory, phase: 'INIT_CHECK', confirm: true });
  const wtPath = join(temp, '.worktrees', driftStory);
  proofOrStop('story_advance', { storyId: driftStory, phase: 'PLAN' }, wtPath, wtPath);
  const brief = proofOrStop('session_brief');
  assertIncludes(brief, 'worktree phase: PLAN', 'session_brief should show linked worktree phase drift');

  const auxFail = proofOrStopExpectFail('aux_doc_list');
  assertIncludes(auxFail, 'node bin/proof-or-stop.js aux_doc_list', 'core-only aux fallback should be visible');

  const fixtureHelp = execFileSync('node', [cli, '--root', temp, 'fixture_batch_add', '--help'], { cwd: temp, encoding: 'utf8' });
  assertIncludes(fixtureHelp, 'Story is still in DEV', 'fixture_batch_add help should document DEV compatibility path');

  console.log('workflow phase consistency verified');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
