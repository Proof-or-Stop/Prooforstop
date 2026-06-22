#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const repoRoot = process.cwd();
const cli = join(repoRoot, 'bin', 'lattice.js');
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

function createTempProject(initialPrompt) {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-lab-scoring-'));
  mkdirSync(join(dir, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  mkdirSync(join(dir, '.lattice-codex', 'agents'), { recursive: true });
  writeFileSync(join(dir, 'lattice.config.json'), JSON.stringify({
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
  writeFileSync(join(dir, '.lattice-codex', 'agents', 'test-case-reviewer.md'), initialPrompt);
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.name', 'Lattice Lab Test'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.email', 'lattice-lab@example.com'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  run(dir, ['lab', 'create', '--target=test-case-reviewer', '--profile=reviewer-quality-v1']);
  return dir;
}

function readRunArtifacts(projectRoot) {
  const runRoot = join(projectRoot, 'experiments', 'runs', 'lab-reviewer-reviewer-quality-v1', 'run-001');
  return {
    metrics: JSON.parse(readFileSync(join(runRoot, 'metrics.json'), 'utf8')),
    result: JSON.parse(readFileSync(join(runRoot, 'result.json'), 'utf8')),
    compare: parseCliJson(run(projectRoot, ['lab', 'compare', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json'])),
  };
}

function rewritePrompt(projectRoot, prompt) {
  writeFileSync(join(projectRoot, '.lattice-codex', 'agents', 'test-case-reviewer.md'), prompt);
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

const cases = {
  'score-happy': () => {
    const temp = createTempProject(weakPrompt);
    try {
      rewritePrompt(temp, strongPrompt);
      run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
      const { result } = readRunArtifacts(temp);
      assert(result.score > result.baselineScore, 'happy score should beat baseline');
      assert(Number.isFinite(result.score), 'happy score should be finite');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
  'score-edge': () => {
    const temp = createTempProject(strongPrompt);
    try {
      rewritePrompt(temp, `${strongPrompt}${'padding line\n'.repeat(260)}`);
      const out = run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
      assert(out.includes('decision: rejected'), 'edge score should reject high-penalty candidate');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
  'score-invalid': () => {
    const temp = createTempProject(weakPrompt);
    try {
      const configPath = join(temp, 'experiments', 'configs', 'lab-reviewer-reviewer-quality-v1.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      config.scoring.qualityWeight = 'oops';
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      let failed = false;
      try {
        run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
      } catch (error) {
        const text = String(error.stdout || '') + String(error.stderr || '');
        failed = text.includes('qualityWeight') || text.includes('invalid baselineScore');
      }
      assert(failed, 'invalid scoring weights should fail explicitly');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
  'profile-happy': () => {
    const temp = createTempProject(weakPrompt);
    try {
      rewritePrompt(temp, strongPrompt);
      run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
      const { metrics } = readRunArtifacts(temp);
      assert(metrics.profile === 'reviewer-quality-v1', 'metrics should record reviewer profile name');
      assert(typeof metrics.submetrics.fileLineEvidence === 'number', 'profile should emit numeric submetrics');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
  'profile-edge': () => {
    const temp = createTempProject(weakPrompt);
    try {
      rewritePrompt(temp, weakPrompt);
      run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
      const { metrics } = readRunArtifacts(temp);
      assert(Object.prototype.hasOwnProperty.call(metrics.submetrics, 'capGuidance'), 'profile should keep default submetric shape even when cap guidance is absent');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
  'profile-unknown': () => {
    const temp = createTempProject(weakPrompt);
    try {
      const configPath = join(temp, 'experiments', 'configs', 'lab-reviewer-reviewer-quality-v1.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      config.dataset.profile = 'unknown-profile';
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      let failed = false;
      try {
        run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
      } catch (error) {
        const text = String(error.stdout || '') + String(error.stderr || '');
        failed = text.includes('未知 lattice-lab profile');
      }
      assert(failed, 'unknown profile should fail with explicit error');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
  'compare-kept': () => {
    const temp = createTempProject(weakPrompt);
    try {
      rewritePrompt(temp, strongPrompt);
      run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
      const { compare } = readRunArtifacts(temp);
      assert(compare.decision === 'kept', 'compare should report kept for improved candidate');
      assert(compare.best.delta > 0, 'compare should expose a positive delta');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
  'compare-discard': () => {
    const temp = createTempProject(strongPrompt);
    try {
      rewritePrompt(temp, `${strongPrompt}${'padding line\n'.repeat(260)}`);
      run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
      const { compare } = readRunArtifacts(temp);
      assert(compare.decision === 'rejected', 'compare should report rejected for discarded candidate');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
  'promote-no-kept': () => {
    const temp = createTempProject(strongPrompt);
    try {
      rewritePrompt(temp, `${strongPrompt}${'padding line\n'.repeat(260)}`);
      run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
      let failed = false;
      try {
        run(temp, ['lab', 'promote', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json']);
      } catch (error) {
        const text = String(error.stdout || '') + String(error.stderr || '');
        failed = text.includes('还没有可晋升的 kept run');
      }
      assert(failed, 'promote should fail when no kept run exists');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
  'stability-stable': () => {
    const temp = createTempProject(weakPrompt);
    try {
      rewritePrompt(temp, strongPrompt);
      run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
      const { metrics } = readRunArtifacts(temp);
      assert(metrics.stabilityPenalty === 0, 'stable candidate should have zero stability penalty');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
  'stability-soft-volatile': () => {
    const temp = createTempProject(weakPrompt);
    try {
      rewritePrompt(temp, [
        '# reviewer',
        '判定权在你',
        '不要运行 test_auto',
        'file:line',
        'severity',
        '5 轮 cap',
        '不修改代码',
        '不修改测试',
        'testintent_check',
        '[lab:soft-volatile]',
        '',
      ].join('\n'));
      run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
      const { metrics } = readRunArtifacts(temp);
      assert(metrics.submetrics.stabilityStdDev > 0, 'soft volatile candidate should report non-zero stddev');
      assert(metrics.stabilityPenalty === 0, 'soft volatility below threshold should not be penalized');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
  'stability-crash': () => {
    const temp = createTempProject(weakPrompt);
    try {
      rewritePrompt(temp, `${strongPrompt}[lab:crash-on-repeat]\n`);
      run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
      const { metrics, result } = readRunArtifacts(temp);
      assert(metrics.stabilityPenalty > 0, 'crash-on-repeat candidate should be penalized');
      assert(result.status === 'rejected', 'crash-on-repeat candidate should not be kept');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
};

if (mode !== 'all') {
  const target = cases[mode];
  if (!target) {
    throw new Error(`unknown verify-lab-scoring-core mode: ${mode}`);
  }
  target();
  console.log(`ok ${mode}`);
  process.exit(0);
}

for (const [name, check] of Object.entries(cases)) {
  check();
  console.log(`ok ${name}`);
}

console.log('lab scoring core verified');
