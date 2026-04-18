#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const repoRoot = process.cwd();
const cli = join(repoRoot, 'bin', 'koala.js');
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

function createTempProject(initialPrompt, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'koala-lab-reviewer-mvp-'));
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
  if (options.trackedProtectedFile) {
    mkdirSync(join(dir, 'docs', 'story', 'actives', 'B-bad'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'story', 'actives', 'B-bad', 'index.json'), '{"phase":"INIT"}\n');
  }
  writeFileSync(join(dir, '.Codex', 'agents', 'test-case-reviewer.md'), initialPrompt);
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.name', 'Koala Lab Test'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.email', 'koala-lab@example.com'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  run(dir, ['lab', 'create', '--target=test-case-reviewer', '--profile=reviewer-quality-v1']);
  return dir;
}

function readRunArtifacts(projectRoot, runId = 'run-001') {
  const runRoot = join(projectRoot, 'experiments', 'runs', 'lab-reviewer-reviewer-quality-v1', runId);
  return {
    metrics: JSON.parse(readFileSync(join(runRoot, 'metrics.json'), 'utf8')),
    result: JSON.parse(readFileSync(join(runRoot, 'result.json'), 'utf8')),
    summary: readFileSync(join(runRoot, 'summary.md'), 'utf8'),
    patchPath: join(runRoot, 'patch.diff'),
    compare: parseCliJson(run(projectRoot, ['lab', 'compare', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json'])),
  };
}

function rewritePrompt(projectRoot, prompt) {
  writeFileSync(join(projectRoot, '.Codex', 'agents', 'test-case-reviewer.md'), prompt);
}

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
  'patch-happy': () => {
    const temp = createTempProject(weakPrompt);
    try {
      rewritePrompt(temp, strongPrompt);
      run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
      const { result, patchPath } = readRunArtifacts(temp);
      assert(result.candidatePatch?.endsWith('patch.diff'), 'run should record patch.diff path');
      assert(existsSync(patchPath), 'patch.diff should exist for real reviewer changes');
      assert(readFileSync(patchPath, 'utf8').includes('+5 轮 cap'), 'patch.diff should capture reviewer prompt delta');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
  'patch-none': () => {
    const temp = createTempProject(weakPrompt);
    try {
      const out = run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
      const { result } = readRunArtifacts(temp);
      assert(out.includes('patch: (none)'), 'run output should surface missing patch');
      assert(result.candidatePatch === null, 'no-op reviewer run should not write patch path');
      assert(result.status === 'rejected', 'no-op reviewer run should be rejected');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
  'patch-policy-reject': () => {
    const temp = createTempProject(weakPrompt, { trackedProtectedFile: true });
    try {
      const configPath = join(temp, 'experiments', 'configs', 'lab-reviewer-reviewer-quality-v1.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      config.target.editableFiles.push('docs/story/actives/B-bad/index.json');
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      writeFileSync(join(temp, 'docs', 'story', 'actives', 'B-bad', 'index.json'), '{"phase":"DEV"}\n');
      rewritePrompt(temp, strongPrompt);
      const out = run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
      const { result } = readRunArtifacts(temp);
      assert(out.includes('decision: rejected'), 'policy-breaching patch should be rejected');
      assert(result.reason.includes('patch policy'), 'rejected patch should explain patch policy violation');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
  'compare-promote-happy': () => {
    const temp = createTempProject(weakPrompt);
    try {
      rewritePrompt(temp, strongPrompt);
      run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
      const compare = parseCliJson(run(temp, ['lab', 'compare', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json']));
      const promote = parseCliJson(run(temp, ['lab', 'promote', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json']));
      assert(compare.best.patch?.endsWith('patch.diff'), 'compare should expose patch path');
      assert(compare.baseline.ref === 'HEAD', 'compare should expose baseline ref');
      assert(promote.promotePatch?.endsWith('patch.diff'), 'promote should expose patch path');
      assert(promote.baselineRef === 'HEAD', 'promote should expose baseline ref');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
  'compare-tiebreak': () => {
    const temp = createTempProject(weakPrompt);
    try {
      rewritePrompt(temp, strongPrompt);
      run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
      rewritePrompt(temp, `${strongPrompt}\n<!-- extra -->\n`);
      run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
      const run1Path = join(temp, 'experiments', 'runs', 'lab-reviewer-reviewer-quality-v1', 'run-001', 'result.json');
      const run2Path = join(temp, 'experiments', 'runs', 'lab-reviewer-reviewer-quality-v1', 'run-002', 'result.json');
      const run1 = JSON.parse(readFileSync(run1Path, 'utf8'));
      const run2 = JSON.parse(readFileSync(run2Path, 'utf8'));
      run1.score = 0.6;
      run2.score = 0.6;
      run1.delta = 0.05;
      run2.delta = 0.05;
      run1.changedLines = 2;
      run2.changedLines = 20;
      writeFileSync(run1Path, JSON.stringify(run1, null, 2));
      writeFileSync(run2Path, JSON.stringify(run2, null, 2));
      const compare = parseCliJson(run(temp, ['lab', 'compare', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json']));
      assert(compare.best.runId === 'run-001', 'equal scores should tie-break toward lower complexity');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
  'promote-rejected': () => {
    const temp = createTempProject(weakPrompt);
    try {
      const failed = (() => {
        try {
          run(temp, ['lab', 'promote', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json']);
          return false;
        } catch (error) {
          const text = String(error.stdout || '') + String(error.stderr || '');
          return text.includes('还没有任何 run') || text.includes('还没有可晋升的 kept run');
        }
      })();
      assert(failed, 'promote should refuse when reviewer run is rejected or missing');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
  'verify-happy': () => {
    const temp = createTempProject(weakPrompt);
    try {
      rewritePrompt(temp, strongPrompt);
      const out = run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
      const promote = parseCliJson(run(temp, ['lab', 'promote', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json']));
      assert(out.includes('decision: kept'), 'reviewer MVP happy path should keep the candidate');
      assert(promote.promotePatch?.endsWith('patch.diff'), 'reviewer MVP happy path should end with a patch artifact');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
  'verify-rejected': () => {
    const temp = createTempProject(weakPrompt);
    try {
      rewritePrompt(temp, `${strongPrompt}${'padding line\n'.repeat(260)}`);
      const out = run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
      let failed = false;
      try {
        run(temp, ['lab', 'promote', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json']);
      } catch (error) {
        const text = String(error.stdout || '') + String(error.stderr || '');
        failed = text.includes('kept run');
      }
      assert(out.includes('decision: rejected'), 'insufficient reviewer improvement should be rejected');
      assert(failed, 'rejected reviewer change should not promote');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
  'verify-volatile': () => {
    const temp = createTempProject(weakPrompt);
    try {
      rewritePrompt(temp, `${strongPrompt}[lab:crash-on-repeat]\n`);
      run(temp, ['lab', 'run', '--config', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', '--confirm']);
      const { metrics, result } = readRunArtifacts(temp);
      assert(metrics.stabilityPenalty > 0, 'volatile reviewer run should preserve stability penalty data');
      assert(result.status === 'rejected', 'volatile reviewer run should not promote');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
};

if (mode !== 'all') {
  const target = cases[mode];
  if (!target) throw new Error(`unknown verify-lab-reviewer-mvp mode: ${mode}`);
  target();
  console.log(`ok ${mode}`);
  process.exit(0);
}

for (const [name, check] of Object.entries(cases)) {
  check();
  console.log(`ok ${name}`);
}

console.log('lab reviewer mvp verified');
