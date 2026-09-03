#!/usr/bin/env node

import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = process.cwd();
const cli = join(root, 'packages/main/dist/cli.js');
const mode = process.argv[2] || 'all';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(projectRoot, command, payload, cwd = root) {
  const args = [cli, '--root', projectRoot, command];
  if (payload !== undefined) args.push(JSON.stringify(payload));
  return execFileSync('node', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runAllowWarning(projectRoot, command, payload, cwd = root) {
  try {
    return run(projectRoot, command, payload, cwd);
  } catch (e) {
    return `${e.stdout || ''}${e.stderr || ''}`.trim();
  }
}

function runConcurrentInitCheck(projectRoot, storyId) {
  return new Promise((resolve, reject) => {
    const args = [cli, '--root', projectRoot, 'story_advance', JSON.stringify({ storyId, phase: 'INIT_CHECK', confirm: true })];
    const child = spawn('node', args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${stdout}\n${stderr}`.trim() || `INIT_CHECK exited with ${code}`));
    });
  });
}

function createTempProject() {
  const dir = mkdtempSync(join(tmpdir(), 'proof-or-stop-init-check-'));
  mkdirSync(join(dir, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  writeFileSync(join(dir, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  writeFileSync(join(dir, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(dir, 'README.md'), '# temp project\n');
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.name', 'ProofOrStop Test'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.email', 'proofOrStop@example.com'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  return dir;
}

function makeBackground(label) {
  return [
    '## Trigger Event',
    `2026-05-01 B-0000 ${label} verifier needs a realistic story_create input before it can exercise INIT_CHECK bootstrap behavior.`,
    '## Key Insights',
    'The bootstrap smoke owns worktree creation behavior, so its synthetic stories must satisfy the current background truth-source contract first.',
    '## Solution Tradeoffs',
    'Use one reusable four-section background helper instead of weakening story_create or duplicating long literals in every regression case.',
    '## Conversational Texture',
    'The visible outcome remains the same for a maintainer: the verifier should fail only when INIT_CHECK bootstrap behavior regresses.',
  ].join('\n\n');
}

function extractStoryId(text) {
  const storyId = text.match(/B-[a-f0-9]+/)?.[0];
  if (!storyId) throw new Error(`failed to parse story id from: ${text}`);
  return storyId;
}

// INIT_CHECK now requires confirmed scope/execution boundaries + a scope-freeze
// check before the worktree is created. Fold the current prerequisites into the
// test bootstrap so scenarios exercise real INIT_CHECK behavior.
function setupInitCheckGates(projectRoot, storyId) {
  run(projectRoot, 'scope_boundary_set', {
    storyId,
    mode: 'feature',
    allowedScope: ['Create the story worktree for bootstrap regression coverage'],
    excludedScope: ['Unrelated source changes'],
    userConfirmed: true,
    confirmation: 'init-check bootstrap smoke fixture',
  });
  run(projectRoot, 'execution_boundary_set', {
    storyId,
    allowedPaths: ['docs/story'],
    notes: 'init-check bootstrap smoke fixture',
  });
  run(projectRoot, 'scope_freeze_check', { storyId });
}

function recordInitCheck(projectRoot, storyId) {
  run(projectRoot, 'init_check_set', {
    storyId,
    issues: [],
    agentId: 'proof-or-stop-review-story-init',
  });
  run(projectRoot, 'init_check_set', {
    storyId,
    issues: [],
    agentId: 'product-reviewer',
  });
  setupInitCheckGates(projectRoot, storyId);
}

function extractWorktreePath(text) {
  const path = text.match(/(?:路径|Path):\s*(.+)/)?.[1]?.trim();
  if (!path) throw new Error(`failed to parse worktree path from: ${text}`);
  return path;
}

function readStoryIndex(projectRoot, storyId) {
  return JSON.parse(readFileSync(join(projectRoot, 'docs', 'story', 'actives', storyId, 'index.json'), 'utf8'));
}

function git(projectRoot, args) {
  return execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

async function verifyConcurrentInitCheck() {
  const temp = createTempProject();
  try {
    const storyIds = Array.from({ length: 4 }, (_, index) => extractStoryId(run(temp, 'story_create', {
      name: `concurrent-${index}`,
      title: `Concurrent story ${index}`,
      description: 'Verify concurrent INIT_CHECK bootstrap serialization.',
      background: makeBackground(`concurrent-${index}`),
      type: 'feature',
      priority: 'high',
      checklist: [{ title: 'bootstrap worktree', context: 'concurrency regression case' }],
    })));
    for (const storyId of storyIds) recordInitCheck(temp, storyId);

    await Promise.all(storyIds.map(storyId => runConcurrentInitCheck(temp, storyId)));

    for (let i = 0; i < storyIds.length; i++) {
      const storyId = storyIds[i];
      // Construct the expected worktree path deterministically instead of parsing
      // concurrent output (whose ordering/format is not guaranteed under races).
      const worktreePath = join(temp, '.worktrees', storyId);
      assert(existsSync(worktreePath), `${storyId} worktree was not created under ${worktreePath} after concurrent INIT_CHECK`);
      const storyIndex = join(worktreePath, 'docs', 'story', 'actives', storyId, 'index.json');
      assert(existsSync(storyIndex), `${storyId} missing story file inside ${worktreePath}`);
      const advanced = run(temp, 'story_advance', { storyId, phase: 'PLAN' }, worktreePath);
      assert(advanced.includes('advanced to PLAN'), `${storyId} failed to enter PLAN after INIT_CHECK`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function verifyScopedStage() {
  const temp = createTempProject();
  try {
    const storyId = extractStoryId(run(temp, 'story_create', {
      name: 'scoped-stage',
      title: 'Scoped stage story',
      description: 'Verify INIT_CHECK only stages story bootstrap files.',
      background: makeBackground('scoped-stage'),
      type: 'feature',
      priority: 'high',
      checklist: [{ title: 'bootstrap worktree', context: 'scoped stage regression case' }],
    }));
    recordInitCheck(temp, storyId);

    writeFileSync(join(temp, 'README.md'), '# temp project\n\nlocal dirty change\n');
    run(temp, 'story_advance', { storyId, phase: 'INIT_CHECK', confirm: true });

    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: temp,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert(status.includes(' M README.md'), 'INIT_CHECK unexpectedly consumed unrelated dirty README.md');

    const lastCommitFiles = execFileSync('git', ['show', '--name-only', '--format=', `story/${storyId}`], {
      cwd: temp,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert(!lastCommitFiles.split('\n').includes('README.md'), 'story bootstrap commit should not include unrelated README.md changes');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function verifyBadBranchFailsFast() {
  const temp = createTempProject();
  try {
    const storyId = extractStoryId(run(temp, 'story_create', {
      name: 'bad-branch',
      title: 'Bad branch story',
      description: 'Verify INIT_CHECK fails fast when branch points at an older commit.',
      background: makeBackground('bad-branch'),
      type: 'feature',
      priority: 'high',
      checklist: [{ title: 'bootstrap worktree', context: 'bad branch regression case' }],
    }));
    recordInitCheck(temp, storyId);

    execFileSync('git', ['branch', `story/${storyId}`], { cwd: temp, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = runAllowWarning(temp, 'story_advance', { storyId, phase: 'INIT_CHECK', confirm: true });
    assert(output.includes('⚠ worktree 创建失败'), 'expected INIT_CHECK warning when stale branch is reused');
    assert(output.includes('does not contain docs/story/actives'), 'expected clear fail-fast message for stale branch commit');

    const storyIndex = readStoryIndex(temp, storyId);
    assert(!storyIndex.worktree, 'failed bootstrap should clear stale worktree metadata');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function verifyMainBranchNotPolluted() {
  const temp = createTempProject();
  try {
    const storyId = extractStoryId(run(temp, 'story_create', {
      name: 'branch-isolation',
      title: 'Branch isolation story',
      description: 'Verify INIT_CHECK bootstrap commit only advances the story branch.',
      background: makeBackground('branch-isolation'),
      type: 'feature',
      priority: 'high',
      checklist: [{ title: 'bootstrap worktree', context: 'branch isolation regression case' }],
    }));
    recordInitCheck(temp, storyId);

    const mainHeadBefore = git(temp, ['rev-parse', 'HEAD']);
    const output = run(temp, 'story_advance', { storyId, phase: 'INIT_CHECK', confirm: true });
    const worktreePath = extractWorktreePath(output);
    const mainHeadAfter = git(temp, ['rev-parse', 'HEAD']);
    const storyBranchHead = git(temp, ['rev-parse', `story/${storyId}`]);
    const mainLog = git(temp, ['log', '--oneline', '-n', '1']);
    // The story branch HEAD may be the main-merge commit after reconciliation;
    // the scoped bootstrap commit lives in its history, not necessarily at HEAD.
    const branchLog = git(temp, ['log', '--oneline', '-n', '10', `story/${storyId}`]);

    // INIT_CHECK reconciles the story metadata onto main as a single mirror
    // commit; it must never put the scoped bootstrap commit on main.
    assert(
      mainHeadAfter === mainHeadBefore || mainLog.includes(`INIT_CHECK metadata ${storyId}`),
      'main may only advance by the INIT_CHECK metadata mirror commit, never the bootstrap',
    );
    assert(storyBranchHead !== mainHeadBefore, 'story branch should receive a dedicated bootstrap commit');
    assert(!mainLog.includes(`proof-or-stop: story ${storyId} init`), 'main should not receive bootstrap init commit');
    assert(branchLog.includes(`proof-or-stop: story ${storyId} init`), 'story branch should keep the bootstrap init commit');
    assert(existsSync(join(worktreePath, 'docs', 'story', 'actives', storyId, 'index.json')), 'story file should exist inside worktree');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function verifyDryRunDoesNotMutate() {
  const temp = createTempProject();
  try {
    const storyId = extractStoryId(run(temp, 'story_create', {
      name: 'dry-run-isolation',
      title: 'Dry-run isolation story',
      description: 'Verify INIT_CHECK dry-run only previews bootstrap changes.',
      background: makeBackground('dry-run-isolation'),
      type: 'feature',
      priority: 'high',
      checklist: [{ title: 'bootstrap worktree', context: 'dry-run regression case' }],
    }));
    recordInitCheck(temp, storyId);

    const mainHeadBefore = git(temp, ['rev-parse', 'HEAD']);
    const output = run(temp, 'story_advance', { storyId, phase: 'INIT_CHECK', dryRun: true });
    const mainHeadAfter = git(temp, ['rev-parse', 'HEAD']);

    assert(output.includes('[DRY-RUN] INIT_CHECK bootstrap plan'), 'dry-run should render bootstrap preview');
    assert(mainHeadAfter === mainHeadBefore, 'INIT_CHECK dry-run should not move main HEAD');
    try {
      git(temp, ['rev-parse', '--verify', `story/${storyId}`]);
      throw new Error('INIT_CHECK dry-run should not create the story branch');
    } catch (error) {
      const text = String(error.stdout || '') + String(error.stderr || '') + String(error.message || error);
      assert(text.includes('Needed a single revision') || text.includes('unknown revision') || text.includes('not a valid ref'), 'dry-run branch lookup should fail because branch was not created');
    }
    assert(!existsSync(join(temp, '.worktrees', storyId)), 'INIT_CHECK dry-run should not create the worktree directory');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// B-4e06 CHK-003: wrapper-root project — metadata root is NOT a git repo; the
// real repo is a configured gitRoot subdir, and story metadata lives inside it.
function createWrapperRootProject({ gitRootName = 'repo', initGit = true } = {}) {
  const wrapper = mkdtempSync(join(tmpdir(), 'proof-or-stop-wrapper-'));
  const repo = join(wrapper, gitRootName);
  const storyDirRel = `${gitRootName}/docs/story/actives`;
  mkdirSync(join(wrapper, storyDirRel), { recursive: true });
  mkdirSync(join(wrapper, gitRootName, 'docs', 'requirements'), { recursive: true });
  writeFileSync(join(wrapper, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: storyDirRel,
    requirementsDir: `${gitRootName}/docs/requirements`,
    storyPrefix: 'B',
    gitRoot: gitRootName,
  }, null, 2));
  if (initGit) {
    writeFileSync(join(repo, '.gitignore'), '.worktrees/\n');
    writeFileSync(join(repo, 'README.md'), '# wrapper repo\n');
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
    execFileSync('git', ['config', 'user.name', 'ProofOrStop Test'], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
    execFileSync('git', ['config', 'user.email', 'proofOrStop@example.com'], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
    execFileSync('git', ['add', '.'], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  return { wrapper, repo };
}

function verifyNestedGitRootSuccess() {
  const { wrapper, repo } = createWrapperRootProject();
  try {
    const storyId = extractStoryId(run(wrapper, 'story_create', {
      name: 'nested-gitroot',
      title: 'Nested gitRoot story',
      description: 'Verify INIT_CHECK bootstrap honors a configured gitRoot subdir.',
      background: makeBackground('nested-gitroot'),
      type: 'feature',
      priority: 'high',
      checklist: [{ title: 'bootstrap worktree', context: 'nested gitRoot regression case' }],
    }));
    recordInitCheck(wrapper, storyId);

    const output = run(wrapper, 'story_advance', { storyId, phase: 'INIT_CHECK', confirm: true });
    const worktreePath = extractWorktreePath(output);

    // Worktree + branch must be created inside the configured gitRoot, not the wrapper.
    assert(worktreePath.includes(join(gitBasename(repo), '.worktrees', storyId)) || worktreePath.includes(join('.worktrees', storyId)),
      `worktree should live under the gitRoot .worktrees: ${worktreePath}`);
    assert(!existsSync(join(wrapper, '.git')), 'wrapper root must NOT become a git repo');
    const branchHead = git(repo, ['rev-parse', `story/${storyId}`]);
    assert(branchHead && branchHead.length >= 7, 'story branch must exist in the configured gitRoot');
    assert(existsSync(join(worktreePath, 'docs', 'story', 'actives', storyId, 'index.json')),
      'story metadata must be checked out inside the worktree');
    // Story metadata index must still resolve under the configured story root.
    assert(existsSync(join(wrapper, 'repo', 'docs', 'story', 'actives', storyId, 'index.json')),
      'story metadata must remain under the configured storyDir inside the gitRoot');
  } finally {
    rmSync(wrapper, { recursive: true, force: true });
  }
}

function gitBasename(p) {
  return p.split('/').filter(Boolean).pop();
}

function verifyInvalidGitRootFailsClosed() {
  // gitRoot points at an existing directory that is NOT a git repository.
  const { wrapper } = createWrapperRootProject({ initGit: false });
  try {
    const storyId = extractStoryId(run(wrapper, 'story_create', {
      name: 'invalid-gitroot',
      title: 'Invalid gitRoot story',
      description: 'Verify INIT_CHECK fails closed when the configured gitRoot is not a git repo.',
      background: makeBackground('invalid-gitroot'),
      type: 'feature',
      priority: 'high',
      checklist: [{ title: 'bootstrap worktree', context: 'invalid gitRoot regression case' }],
    }));
    run(wrapper, 'init_check_set', { storyId, issues: [], agentId: 'proof-or-stop-review-story-init' });
    run(wrapper, 'init_check_set', { storyId, issues: [], agentId: 'product-reviewer' });
    setupInitCheckGates(wrapper, storyId);

    const output = runAllowWarning(wrapper, 'story_advance', { storyId, phase: 'INIT_CHECK', confirm: true });
    assert(/configured_gitRoot_is_not_git_repository|gitRoot is unusable|not a git/i.test(output),
      `expected a clear signed-workspace reason for the invalid gitRoot, got: ${output}`);
    assert(!existsSync(join(wrapper, 'repo', '.worktrees', storyId)), 'no worktree should be created for an invalid gitRoot');
  } finally {
    rmSync(wrapper, { recursive: true, force: true });
  }
}

// B-4e06 CHK-004: regression guard for the verified P3 state — `checklist_update
// --help` must exit zero without triggering sourceManifestDigest/help-import work.
function verifyChecklistUpdateHelpHealth() {
  execFileSync('node', [cli, 'checklist_update', '--help'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  console.log('checklist_update --help exits zero (help-health)');
}

async function main() {
  if (mode === 'help-health' || mode === 'all') {
    verifyChecklistUpdateHelpHealth();
  }
  if (mode === 'concurrent' || mode === 'all') {
    await verifyConcurrentInitCheck();
  }
  if (mode === 'nested-gitroot' || mode === 'all') {
    verifyNestedGitRootSuccess();
  }
  if (mode === 'invalid-gitroot' || mode === 'all') {
    verifyInvalidGitRootFailsClosed();
  }
  if (mode === 'branch-isolation' || mode === 'all') {
    verifyMainBranchNotPolluted();
  }
  if (mode === 'dry-run' || mode === 'all') {
    verifyDryRunDoesNotMutate();
  }
  if (mode === 'scoped-stage' || mode === 'all') {
    verifyScopedStage();
  }
  if (mode === 'bad-branch' || mode === 'all') {
    verifyBadBranchFailsFast();
  }
  console.log(`init-check bootstrap verified (${mode})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
