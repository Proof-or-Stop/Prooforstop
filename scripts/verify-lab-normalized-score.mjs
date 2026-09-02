#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const repoRoot = process.cwd();
const cli = join(repoRoot, 'bin', 'proof-or-stop.js');
const mode = process.argv[2] || 'all';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(projectRoot, args) {
  return execFileSync('node', [cli, '--root', projectRoot, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function parseCliJson(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error(`JSON payload not found in CLI output:\n${text}`);
  return JSON.parse(text.slice(start));
}

function createProject(prompt) {
  const dir = mkdtempSync(join(tmpdir(), 'proof-or-stop-lab-normalized-'));
  mkdirSync(join(dir, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  mkdirSync(join(dir, '.proof-or-stop-codex', 'agents'), { recursive: true });
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
  writeFileSync(join(dir, 'README.md'), '# temp\n');
  writeFileSync(join(dir, '.proof-or-stop-codex', 'agents', 'test-case-reviewer.md'), prompt);
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.name', 'ProofOrStop Test'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.email', 'proofOrStop@example.com'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  run(dir, ['lab', 'create', '--target=test-case-reviewer', '--profile=reviewer-quality-v1']);
  return dir;
}

const strongPrompt = [
  '# reviewer',
  '判定权在你',
  '不要运行 test_auto',
  'file:line',
  'severity',
  '5 轮 cap',
  '不修改代码',
  '不修改测试',
  'testintent_check',
  '原样转告',
  '',
].join('\n');

const cases = {
  'normalized-high': () => {
    const temp = createProject(strongPrompt.replace('5 轮 cap\n', ''));
    try {
      writeFileSync(join(temp, '.proof-or-stop-codex', 'agents', 'test-case-reviewer.md'), strongPrompt);
      run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
      const compare = parseCliJson(run(temp, ['lab', 'compare', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json']));
      assert(compare.best.normalizedScore > 0.8, 'normalizedScore should exceed 0.8 for high-quality reviewer prompt');
      assert(compare.best.score < compare.best.normalizedScore, 'internal score should remain separate from display score');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
  'normalized-penalty': () => {
    const temp = createProject(strongPrompt);
    try {
      writeFileSync(join(temp, '.proof-or-stop-codex', 'agents', 'test-case-reviewer.md'), `${strongPrompt}${'padding line\n'.repeat(260)}`);
      run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
      const result = JSON.parse(readFileSync(join(temp, 'experiments', 'runs', 'lab-reviewer-reviewer-quality-v1', 'run-001', 'result.json'), 'utf8'));
      assert(result.normalizedScore >= 0 && result.normalizedScore <= 1, 'normalizedScore should stay in 0..1');
      assert(result.normalizedScore < 1, 'penalties should reduce normalizedScore');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
  'promote-gate': () => {
    const temp = createProject(strongPrompt);
    try {
      run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
      let failed = false;
      try {
        run(temp, ['lab', 'promote', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json']);
      } catch (error) {
        const text = String(error.stdout || '') + String(error.stderr || '');
        failed = text.includes('kept run');
      }
      assert(failed, 'promote should still fail without kept run even if normalizedScore exists');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
};

if (mode !== 'all') {
  const target = cases[mode];
  if (!target) throw new Error(`unknown verify-lab-normalized-score mode: ${mode}`);
  target();
  console.log(`ok ${mode}`);
  process.exit(0);
}

for (const [name, check] of Object.entries(cases)) {
  check();
  console.log(`ok ${name}`);
}

console.log('lab normalized score verified');
