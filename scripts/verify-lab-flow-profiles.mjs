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

function run(root, args) {
  return execFileSync('node', [cli, '--root', root, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function parseCliJson(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error(`JSON payload not found:\n${text}`);
  return JSON.parse(text.slice(start));
}

function createProject(filePath, content, id, profile) {
  const root = mkdtempSync(join(tmpdir(), 'koala-lab-flow-profile-'));
  mkdirSync(join(root, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(root, 'docs', 'requirements'), { recursive: true });
  mkdirSync(join(root, filePath, '..'), { recursive: true });
  writeFileSync(join(root, 'koala.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  writeFileSync(join(root, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(root, 'README.md'), '# temp\n');
  writeFileSync(join(root, filePath), content);
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.name', 'Koala Lab Test'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.email', 'koala-lab@example.com'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['add', '.'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  run(root, ['lab', 'create', JSON.stringify({ id, target: id, profile, editableFiles: [filePath] })]);
  return root;
}

function runAndCompare(root, id) {
  run(root, ['lab', 'run', '--config', `experiments/configs/${id}.json`, '--confirm']);
  return parseCliJson(run(root, ['lab', 'compare', '--config', `experiments/configs/${id}.json`]));
}

const sessionWeak = [
  '# koala session brief',
  '**Story**: B-test',
  '**Phase**: DEV',
  '## Checklist (1/3 done)',
].join('\n');

const sessionStrong = [
  '# koala session brief',
  '**Story**: B-test',
  '**Phase**: TEST_CASE_REVIEW',
  '## Checklist (3/3 done)',
  '## Runtime health',
  '  [✓] worktree registered',
  '## Reviewer status',
  '  [✓] story review',
  '## Artifacts',
  '  [✓] test evidence',
  '## Git',
  '  working tree clean',
  '## → Next step',
  '  story_advance --phase=TEST',
].join('\n');

const reviewWeak = JSON.stringify({
  storyId: 'B-test',
  summary: { issueCount: 1 },
}, null, 2);

const reviewStrong = JSON.stringify({
  storyId: 'B-test',
  summary: {
    issueCount: 2,
    blockerCount: 1,
    intentCoverage: { covered: 2, total: 3 },
  },
  issues: [
    { type: 'missing_intent', severity: 'blocker', message: '缺少 testIntent' },
    { type: 'risk_signals', severity: 'advisory', message: '高风险信号' },
  ],
  _hint: '修复 blocker 后重新 story_review',
  _reviewPrompt: '请审查 decision 和 preMortem',
}, null, 2);

const cases = {
  'session-happy': () => {
    const root = createProject('samples/session-brief.txt', sessionWeak, 'lab-session-brief-quality-v1', 'session-brief-quality-v1');
    try {
      writeFileSync(join(root, 'samples', 'session-brief.txt'), sessionStrong);
      const compare = runAndCompare(root, 'lab-session-brief-quality-v1');
      assert(compare.best.normalizedScore > compare.baseline.normalizedScore, 'session brief candidate should improve normalizedScore');
      assert(compare.best.contentSummary.some((item) => item === 'has nextStep'), 'session brief summary should include nextStep');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  'session-edge': () => {
    const root = createProject('samples/session-brief.txt', sessionWeak, 'lab-session-brief-quality-v1', 'session-brief-quality-v1');
    try {
      writeFileSync(join(root, 'samples', 'session-brief.txt'), '# koala session brief\n## → Next step\n  continue\n');
      const compare = runAndCompare(root, 'lab-session-brief-quality-v1');
      assert(compare.best.contentSummary.some((item) => item === 'missing reviewerStatus'), 'missing reviewer status should be summarized');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  'session-adversarial': () => {
    const root = createProject('samples/session-brief.txt', sessionWeak, 'lab-session-brief-quality-v1', 'session-brief-quality-v1');
    try {
      writeFileSync(join(root, 'samples', 'session-brief.txt'), '');
      const compare = runAndCompare(root, 'lab-session-brief-quality-v1');
      assert(compare.best.contentSummary.some((item) => item === 'missing nextStep'), 'empty session brief should mark missing nextStep');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  'review-happy': () => {
    const root = createProject('samples/story-review.json', reviewWeak, 'lab-story-review-quality-v1', 'story-review-quality-v1');
    try {
      writeFileSync(join(root, 'samples', 'story-review.json'), reviewStrong);
      const compare = runAndCompare(root, 'lab-story-review-quality-v1');
      assert(compare.best.normalizedScore > compare.baseline.normalizedScore, 'story review candidate should improve normalizedScore');
      assert(compare.best.contentSummary.some((item) => item === 'has blockerCount'), 'story review summary should include blockerCount');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  'review-edge': () => {
    const root = createProject('samples/story-review.json', reviewWeak, 'lab-story-review-quality-v1', 'story-review-quality-v1');
    try {
      writeFileSync(join(root, 'samples', 'story-review.json'), JSON.stringify({ summary: { issueCount: 1, blockerCount: 0 }, issues: [{ severity: 'advisory' }], _hint: '继续' }, null, 2));
      const compare = runAndCompare(root, 'lab-story-review-quality-v1');
      assert(compare.best.contentSummary.some((item) => item === 'has blockerCount'), 'advisory-only review should still identify blockerCount');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  'review-adversarial': () => {
    const root = createProject('samples/story-review.json', reviewWeak, 'lab-story-review-quality-v1', 'story-review-quality-v1');
    try {
      writeFileSync(join(root, 'samples', 'story-review.json'), '{}\n');
      const compare = runAndCompare(root, 'lab-story-review-quality-v1');
      assert(compare.best.contentSummary.some((item) => item === 'missing issueCount'), 'empty story review should mark missing issueCount');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  'compare-happy': () => {
    const root = createProject('samples/session-brief.txt', sessionWeak, 'lab-session-brief-quality-v1', 'session-brief-quality-v1');
    try {
      writeFileSync(join(root, 'samples', 'session-brief.txt'), sessionStrong);
      const compare = runAndCompare(root, 'lab-session-brief-quality-v1');
      assert(Array.isArray(compare.baselineContentSummary), 'compare should expose baselineContentSummary');
      assert(Array.isArray(compare.best.contentSummary), 'compare should expose best contentSummary');
      assert(compare.best.patch?.endsWith('patch.diff'), 'compare should still expose patch path');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  'compare-old-run': () => {
    const root = createProject('samples/session-brief.txt', sessionWeak, 'lab-session-brief-quality-v1', 'session-brief-quality-v1');
    try {
      writeFileSync(join(root, 'samples', 'session-brief.txt'), sessionStrong);
      run(root, ['lab', 'run', '--config', 'experiments/configs/lab-session-brief-quality-v1.json', '--confirm']);
      const resultPath = join(root, 'experiments', 'runs', 'lab-session-brief-quality-v1', 'run-001', 'result.json');
      const result = JSON.parse(readFileSync(resultPath, 'utf8'));
      delete result.contentSummary;
      writeFileSync(resultPath, JSON.stringify(result, null, 2));
      const compare = parseCliJson(run(root, ['lab', 'compare', '--config', 'experiments/configs/lab-session-brief-quality-v1.json']));
      assert(Array.isArray(compare.best.contentSummary), 'old run compare should return empty contentSummary array');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  'compare-adversarial': () => {
    const root = createProject('samples/session-brief.txt', sessionWeak, 'lab-session-brief-quality-v1', 'session-brief-quality-v1');
    try {
      writeFileSync(join(root, 'samples', 'session-brief.txt'), '# koala session brief\n**Story**: B-test\n**Phase**: DEV\n');
      const compare = runAndCompare(root, 'lab-session-brief-quality-v1');
      assert(compare.best.contentSummary.some((item) => item === 'missing nextStep'), 'compare should reveal missing nextStep even if score changes');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
};

if (mode !== 'all') {
  const target = cases[mode];
  if (!target) throw new Error(`unknown verify-lab-flow-profiles mode: ${mode}`);
  target();
  console.log(`ok ${mode}`);
  process.exit(0);
}

for (const [name, check] of Object.entries(cases)) {
  check();
  console.log(`ok ${name}`);
}

console.log('lab flow profiles verified');
