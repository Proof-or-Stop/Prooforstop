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
    const args = [cli, '--root', projectRoot, 'story_advance', JSON.stringify({ storyId, phase: 'INIT_CHECK' })];
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
  const dir = mkdtempSync(join(tmpdir(), 'koala-init-check-'));
  mkdirSync(join(dir, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
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
  writeFileSync(join(dir, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(dir, 'README.md'), '# temp project\n');
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.name', 'Koala Test'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.email', 'koala@example.com'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  return dir;
}

function extractStoryId(text) {
  const storyId = text.match(/B-[a-f0-9]+/)?.[0];
  if (!storyId) throw new Error(`failed to parse story id from: ${text}`);
  return storyId;
}

function extractWorktreePath(text) {
  const path = text.match(/路径:\s*(.+)/)?.[1]?.trim();
  if (!path) throw new Error(`failed to parse worktree path from: ${text}`);
  return path;
}

function readStoryIndex(projectRoot, storyId) {
  return JSON.parse(readFileSync(join(projectRoot, 'docs', 'story', 'actives', storyId, 'index.json'), 'utf8'));
}

async function verifyConcurrentInitCheck() {
  const temp = createTempProject();
  try {
    const storyIds = Array.from({ length: 4 }, (_, index) => extractStoryId(run(temp, 'story_create', {
      name: `concurrent-${index}`,
      title: `Concurrent story ${index}`,
      description: 'Verify concurrent INIT_CHECK bootstrap serialization.',
      type: 'feature',
      priority: 'high',
      checklist: [{ title: 'bootstrap worktree', context: 'concurrency regression case' }],
    })));

    const outputs = await Promise.all(storyIds.map(storyId => runConcurrentInitCheck(temp, storyId)));
    const worktreePaths = outputs.map(extractWorktreePath);

    for (let i = 0; i < storyIds.length; i++) {
      const storyId = storyIds[i];
      const worktreePath = worktreePaths[i];
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
      type: 'feature',
      priority: 'high',
      checklist: [{ title: 'bootstrap worktree', context: 'scoped stage regression case' }],
    }));

    writeFileSync(join(temp, 'README.md'), '# temp project\n\nlocal dirty change\n');
    run(temp, 'story_advance', { storyId, phase: 'INIT_CHECK' });

    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: temp,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert(status.includes(' M README.md'), 'INIT_CHECK unexpectedly consumed unrelated dirty README.md');

    const lastCommitFiles = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], {
      cwd: temp,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert(!lastCommitFiles.split('\n').includes('README.md'), 'bootstrap commit should not include unrelated README.md changes');
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
      type: 'feature',
      priority: 'high',
      checklist: [{ title: 'bootstrap worktree', context: 'bad branch regression case' }],
    }));

    execFileSync('git', ['branch', `story/${storyId}`], { cwd: temp, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = runAllowWarning(temp, 'story_advance', { storyId, phase: 'INIT_CHECK' });
    assert(output.includes('⚠ worktree 创建失败'), 'expected INIT_CHECK warning when stale branch is reused');
    assert(output.includes('不包含 docs/story/actives'), 'expected clear fail-fast message for stale branch commit');

    const storyIndex = readStoryIndex(temp, storyId);
    assert(!storyIndex.worktree, 'failed bootstrap should clear stale worktree metadata');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function main() {
  if (mode === 'concurrent' || mode === 'all') {
    await verifyConcurrentInitCheck();
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
