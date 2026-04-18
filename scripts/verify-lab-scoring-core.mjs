#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const repoRoot = process.cwd();
const cli = join(repoRoot, 'bin', 'koala.js');

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

function createTempProject(initialPrompt) {
  const dir = mkdtempSync(join(tmpdir(), 'koala-lab-scoring-'));
  mkdirSync(join(dir, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  mkdirSync(join(dir, '.Codex', 'agents'), { recursive: true });
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
  writeFileSync(join(dir, '.Codex', 'agents', 'test-case-reviewer.md'), initialPrompt);
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.name', 'Koala Lab Test'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.email', 'koala-lab@example.com'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
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

const weakPrompt = [
  '# reviewer',
  '判定权在你',
  '不要运行 test_auto',
  'file:line',
  'severity',
  '不修改代码',
  '不修改测试',
  'testintent_check',
  '原样转告',
  '',
].join('\n');

const checks = [];

checks.push(() => {
  const temp = createTempProject(weakPrompt);
  try {
    writeFileSync(join(temp, '.Codex', 'agents', 'test-case-reviewer.md'), strongPrompt);
    const runOut = run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
    const compare = parseCliJson(run(temp, ['lab', 'compare', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json']));
    const promote = parseCliJson(run(temp, ['lab', 'promote', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json']));
    assert(runOut.includes('decision: kept'), 'candidate should be kept when reviewer prompt adds missing rubric');
    assert(compare.decision === 'kept', 'compare should report kept decision');
    assert(promote.status === 'ready_for_review', 'promote should succeed for kept run');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

checks.push(() => {
  const temp = createTempProject(strongPrompt);
  try {
    writeFileSync(join(temp, '.Codex', 'agents', 'test-case-reviewer.md'), `${strongPrompt}${'padding line\\n'.repeat(260)}`);
    const runOut = run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
    assert(runOut.includes('decision: rejected'), 'candidate with heavy latency/complexity should be rejected');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

checks.push(() => {
  const temp = createTempProject(weakPrompt);
  try {
    const distPath = join(temp, '.Codex', 'agents', 'test-case-reviewer.md');
    writeFileSync(distPath, `${weakPrompt}[lab:volatile]\n5 轮 cap\n`);
    run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
    const result = JSON.parse(readFileSync(join(temp, 'experiments', 'runs', 'lab-reviewer-reviewer-quality-v1', 'run-001', 'result.json'), 'utf8'));
    const metrics = JSON.parse(readFileSync(join(temp, 'experiments', 'runs', 'lab-reviewer-reviewer-quality-v1', 'run-001', 'metrics.json'), 'utf8'));
    assert(metrics.stabilityPenalty > 0, 'volatile candidate should carry a stability penalty');
    assert(result.score < 1, 'stability penalty should reduce the total score');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

checks.push(() => {
  const temp = createTempProject(strongPrompt);
  try {
    let failed = false;
    try {
      run(temp, ['lab', 'compare', '--config', 'experiments/configs/missing.json']);
    } catch {
      failed = true;
    }
    assert(failed, 'compare should fail for missing config');

    const configPath = join(temp, 'experiments', 'configs', 'lab-reviewer-reviewer-quality-v1.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.dataset.profile = 'unknown-profile';
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    failed = false;
    try {
      run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
    } catch (error) {
      const text = String(error.stdout || '') + String(error.stderr || '');
      failed = text.includes('未知 koala-lab profile');
    }
    assert(failed, 'unknown profile should fail with explicit profile error');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

for (const [index, check] of checks.entries()) {
  check();
  console.log(`ok ${index + 1}/${checks.length}`);
}

console.log('lab scoring core verified');
