#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const repoRoot = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(args, cwd = repoRoot) {
  return execFileSync('node', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function parseCliJson(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error(`JSON payload not found in CLI output:\n${text}`);
  return JSON.parse(text.slice(start));
}

function createTempProject() {
  const dir = mkdtempSync(join(tmpdir(), 'koala-lab-foundation-'));
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
  execFileSync('git', ['config', 'user.name', 'Koala Lab Test'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.email', 'koala-lab@example.com'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  return dir;
}

const temp = createTempProject();

try {
  const createOut = run([
    'bin/koala.js',
    '--root', temp,
    'lab',
    'create',
    '--target=test-case-reviewer',
    '--profile=reviewer-quality-v1',
  ]);
  assert(createOut.includes('Created experiment'), 'lab create should report the created experiment');

  const configPath = join(temp, 'experiments', 'configs', 'lab-reviewer-reviewer-quality-v1.json');
  assert(existsSync(configPath), 'lab create should write experiment config');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert(config.candidatePolicy.allowStoryMutation === false, 'lab config should keep allowStoryMutation=false');
  assert(config.candidatePolicy.allowFixtureMutation === false, 'lab config should keep allowFixtureMutation=false');

  const dryRunOut = run([
    'bin/koala.js',
    '--root', temp,
    'lab',
    'run',
    '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json',
    '--dry-run',
  ]);
  assert(dryRunOut.includes('[lab] sandbox ready at'), 'lab run --dry-run should print sandbox path');
  assert(dryRunOut.includes('No project files outside the sandbox were modified'), 'lab run --dry-run should confirm no mutation');

  const runOut = run([
    'bin/koala.js',
    '--root', temp,
    'lab',
    'run',
    '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json',
    '--confirm',
  ]);
  const sandboxPath = runOut.match(/\[lab\] sandbox ready at (.+)/)?.[1]?.trim();
  assert(Boolean(sandboxPath), 'lab run --confirm should print sandbox path');
  assert(Boolean(sandboxPath && existsSync(sandboxPath)), 'lab run --confirm should create sandbox worktree');
  const resultPath = join(temp, 'experiments', 'runs', 'lab-reviewer-reviewer-quality-v1', 'run-001', 'result.json');
  assert(existsSync(resultPath), 'lab run should write result.json placeholder');

  const allowedEval = run([
    'bin/koala.js',
    '--root', temp,
    'lab',
    'eval',
    JSON.stringify({
      config: 'experiments/configs/lab-reviewer-reviewer-quality-v1.json',
      files: ['.Codex/agents/test-case-reviewer.md'],
    }),
  ]);
  assert(parseCliJson(allowedEval).ok === true, 'lab eval should allow editableFiles');

  const blockedEval = run([
    'bin/koala.js',
    '--root', temp,
    'lab',
    'eval',
    JSON.stringify({
      config: 'experiments/configs/lab-reviewer-reviewer-quality-v1.json',
      files: ['docs/story/actives/B-1234/index.json'],
    }),
  ]);
  const blocked = parseCliJson(blockedEval);
  assert(blocked.ok === false, 'lab eval should reject docs/story writes');
  assert(blocked.violations.some((line) => line.includes('blocked protected path')), 'lab eval should explain blocked protected path');

  console.log('lab foundation verified');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
