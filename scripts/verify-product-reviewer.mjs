#!/usr/bin/env node

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';

const root = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(args, opts = {}) {
  return execFileSync('node', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
}

function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('no JSON object found in output');
  return JSON.parse(text.slice(start));
}

function createTempProject() {
  const dir = mkdtempSync(join(tmpdir(), 'koala-product-reviewer-'));
  mkdirSync(join(dir, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  writeFileSync(join(dir, 'koala.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  return dir;
}

const agentPaths = [
  join(root, '.claude', 'agents', 'product-reviewer.md'),
  join(root, '.Codex', 'agents', 'product-reviewer.md'),
];
for (const path of agentPaths) {
  assert(existsSync(path), `missing product-reviewer agent: ${path}`);
  const text = readFileSync(path, 'utf8');
  assert(text.includes('用户视角') || text.includes('user-facing transcript'), `${path} missing user-value scope`);
  assert(text.includes('不修改代码') || text.includes('不改代码'), `${path} missing non-edit boundary`);
}

const temp = createTempProject();
try {
  const created = run([join(root, 'packages/main/dist/cli.js'), '--root', temp, 'story_create', JSON.stringify({
    name: 'product-reviewer-check',
    title: 'Product reviewer check',
    description: 'tmp',
    type: 'chore',
    priority: 'low',
    checklist: [{ title: 'review lane', context: 'tmp context' }],
  })]);
  const storyId = created.match(/B-[a-f0-9]+/)?.[0];
  assert(storyId, 'failed to parse temp story id');

  run([join(root, 'packages/main/dist/cli.js'), '--root', temp, 'understanding_set', JSON.stringify({
    storyId,
    task: '验证 product-reviewer advisory',
    outcome: '链路打通，事件触发，机制闭环。',
    facts: ['tmp fact'],
    constraints: ['tmp constraint'],
    unknowns: [],
    touchpoints: ['packages/main/src/handlers/story-review.ts'],
  })]);

  run([join(root, 'packages/main/dist/cli.js'), '--root', temp, 'checklist_update', JSON.stringify({
    storyId,
    itemId: 'CHK-001',
    testIntent: {
      happy: [{ desc: '正常场景 → 有产品验收提醒', type: 'cli_blackbox' }],
      edge: [{ desc: '抽象 outcome → 给出 advisory', type: 'cli_blackbox' }],
      adversarial: [{ desc: '工程完成但用户仍会问然后呢 → 暴露问题', type: 'cli_blackbox' }],
    },
    agent: 'test-intent',
  })]);

  const reviewRaw = run([join(root, 'packages/main/dist/cli.js'), '--root', temp, 'story_review', JSON.stringify({ storyId })]);
  const review = extractJsonObject(reviewRaw);
  assert((review.issues || []).some((issue) => issue.type === 'weak_outcome_transcript'), 'story_review missing weak_outcome_transcript advisory');

  const advanceSource = readFileSync(join(root, 'packages/main/src/handlers/story-advance.ts'), 'utf8');
  assert(advanceSource.includes('product-reviewer（第一版 advisory）'), 'DONE hint missing product-reviewer advisory');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log('product reviewer verified');
