#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = process.cwd();
const cli = join(root, 'bin', 'lattice.js');
const mode = process.argv[2] || 'all';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(projectRoot, args) {
  return execFileSync('node', [cli, '--root', projectRoot, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function makeProject(baseline) {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-test-intent-prompt-profile-'));
  mkdirSync(join(dir, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  mkdirSync(join(dir, 'samples'), { recursive: true });
  writeFileSync(join(dir, 'lattice.config.json'), JSON.stringify({ scanRoot:'packages/main', rootDir:'src', outDir:'packages/main/dist', testsDir:'packages/main/tests', fixturesDir:'packages/main/tests/fixtures', storyDir:'docs/story/actives', requirementsDir:'docs/requirements', storyPrefix:'B' }, null, 2));
  writeFileSync(join(dir, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(dir, 'README.md'), '# prompt profile\n');
  writeFileSync(join(dir, 'samples', 'prompt.md'), baseline);
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.name', 'Lattice Lab'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.email', 'lattice@example.com'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  run(dir, ['lab', 'create', JSON.stringify({ id:'lab-test-intent-prompt-quality-v1', target:'test-intent-prompt', profile:'test-intent-prompt-quality-v1', editableFiles:['samples/prompt.md'] })]);
  return dir;
}

function evaluate(baseline, candidate) {
  const dir = makeProject(baseline);
  try {
    writeFileSync(join(dir, 'samples', 'prompt.md'), candidate);
    run(dir, ['lab', 'run', '--config', 'experiments/configs/lab-test-intent-prompt-quality-v1.json', '--confirm']);
    return JSON.parse(readFileSync(join(dir, 'experiments', 'runs', 'lab-test-intent-prompt-quality-v1', 'run-001', 'result.json'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const current = readFileSync('.claude/agents/test-intent.md', 'utf8');
const weak = current
  .replace(/### fixture-heavy item 的推荐字段[\s\S]*?### 写入/, '### 写入')
  .replace(/- fixture-heavy item 优先提供.*\n/, '');

const checks = {
  'prompt-high': () => {
    const result = evaluate(weak, current);
    assert(result.normalizedScore > 0.8, `expected high normalizedScore, got ${result.normalizedScore}`);
    assert(result.contentSummary.includes('has fixtureHeavy'), 'should detect fixtureHeavy');
    assert(result.contentSummary.includes('has inputExample'), 'should detect input');
    assert(result.contentSummary.includes('has expectExample'), 'should detect expect');
    assert(result.contentSummary.includes('has whyGuidance'), 'should detect WHY');
  },
  'prompt-low': () => {
    const result = evaluate(current, weak);
    assert(result.contentSummary.includes('missing fixtureHeavy'), 'weak prompt should miss fixtureHeavy');
    assert(result.normalizedScore < 0.8, `weak prompt should score lower, got ${result.normalizedScore}`);
  },
  'registry': () => {
    const out = execFileSync('node', ['-e', "import('./packages/lab/dist/core/profile.js').then(m=>console.log(m.listProfiles().join('\\n')))"], { cwd: root, encoding: 'utf8' });
    assert(out.includes('test-intent-prompt-quality-v1'), 'profile registry should include prompt profile');
    assert(out.includes('test-intent-quality-v1'), 'original output sample profile should remain');
  },
};

if (mode !== 'all') {
  const check = checks[mode];
  if (!check) throw new Error(`unknown mode ${mode}`);
  check();
  console.log(`ok ${mode}`);
  process.exit(0);
}

for (const [name, check] of Object.entries(checks)) {
  check();
  console.log(`ok ${name}`);
}
console.log('testIntent prompt profile verified');
