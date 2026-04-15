#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const worktreeRoot = '/Users/jek/Documents/Work/Orchestrate/.worktrees/B-8f6a';
const cli = join(worktreeRoot, 'packages/main/dist/cli.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(cwd, args) {
  return execFileSync('node', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function parseJsonOutput(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error(`No JSON object in output:\n${text}`);
  return JSON.parse(text.slice(start));
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

const temp = mkdtempSync(join(tmpdir(), 'koala-runtime-review-'));

try {
  mkdirSync(join(temp, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(temp, 'docs', 'requirements'), { recursive: true });
  writeJson(join(temp, 'koala.config.json'), {
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  });

  git(temp, ['init']);
  git(temp, ['config', 'user.name', 'Koala Test']);
  git(temp, ['config', 'user.email', 'koala@example.com']);
  writeFileSync(join(temp, '.gitignore'), 'node_modules\n');
  git(temp, ['add', '.']);
  git(temp, ['commit', '-m', 'init']);

  const storyId = 'B-test';
  const branch = `story/${storyId}`;
  const stalePath = '.worktrees/B-test-stale';
  const livePath = '.worktrees/B-test-live';
  const absLivePath = join(temp, livePath);
  const storyDir = join(temp, 'docs', 'story', 'actives', storyId);
  mkdirSync(storyDir, { recursive: true });

  writeJson(join(storyDir, 'index.json'), {
    storyId,
    name: 'runtime-reviewer-contract',
    title: 'Runtime reviewer contract',
    description: 'tmp',
    type: 'feature',
    phase: 'TEST_CASE_REVIEW',
    priority: 'high',
    lane: 'mainline',
    parallelSafe: 'no',
    sharedHotspots: ['packages/main/src/handlers/session.ts'],
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    worktree: {
      path: stalePath,
      branch,
      createdAt: new Date().toISOString(),
    },
  });

  writeJson(join(storyDir, 'checklist.json'), {
    items: [
      {
        id: 'CHK-001',
        title: 'tmp',
        status: 'done',
        startTime: null,
        endTime: null,
        testIntent: {
          happy: [{ desc: 'happy', type: 'cli_blackbox', results: [{ time: new Date().toISOString(), pass: true, note: 'fixture:1 WHY ok severity=info', role: 'reviewer' }] }],
          edge: [{ desc: 'edge', type: 'cli_blackbox', results: [{ time: new Date().toISOString(), pass: true, note: 'fixture:2 WHY ok severity=info', role: 'reviewer' }] }],
          adversarial: [{ desc: 'adv', type: 'cli_blackbox', results: [{ time: new Date().toISOString(), pass: true, note: 'fixture:3 WHY ok severity=info', role: 'reviewer' }] }],
        },
      },
    ],
  });

  const reviewTimestamp = new Date().toISOString();
  const blockerCount = 0;
  const issueCount = 0;
  const reviewSalt = 'koala-review-integrity-v1';
  const hashInput = `${storyId}:${reviewTimestamp}:${issueCount}:${blockerCount}:${reviewSalt}`;
  writeJson(join(storyDir, 'review.json'), {
    reviews: [
      {
        timestamp: reviewTimestamp,
        issueCount,
        blockerCount,
        issues: [],
        _hash: createHash('sha256').update(hashInput).digest('hex'),
      },
    ],
  });

  writeJson(join(storyDir, 'implementation-review.json'), {
    storyId,
    verdict: 'fail',
    findings: [
      {
        file: 'packages/main/src/handlers/session.ts',
        line: 1,
        why: 'runtime/reviewer contract should block TEST until fixed',
        severity: 'high',
      },
    ],
    summary: 'implementation reviewer found a blocking issue',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  git(temp, ['add', '.']);
  git(temp, ['commit', '-m', 'story']);

  git(temp, ['worktree', 'add', '-b', branch, absLivePath]);
  writeFileSync(join(absLivePath, 'scratch.txt'), 'live worktree\n');
  git(absLivePath, ['add', 'scratch.txt']);
  git(absLivePath, ['commit', '-m', 'live-worktree']);

  const brief = run(absLivePath, [cli, '--root', temp, 'session_brief']);
  assert(brief.includes('## Runtime health'), 'session_brief missing runtime health');
  assert(brief.includes('story record drifted'), 'session_brief missing drift summary');
  assert(brief.includes('## Reviewer status'), 'session_brief missing reviewer status');
  assert(brief.includes('implementation review'), 'session_brief missing implementation review line');
  assert(brief.includes('implementation review 已标记为 fail') || brief.includes('implementation review 当前为 fail'), 'session_brief missing implementation fail next step');

  const storyGet = parseJsonOutput(run(temp, [cli, '--root', temp, 'story_get', JSON.stringify({ storyId, detail: true })]));
  assert(storyGet.runtimeHealth?.status === 'drift', 'story_get detail missing drift runtime status');
  assert(storyGet.reviewers?.primary?.key === 'implementation_review', 'story_get detail missing implementation_review as primary reviewer');
  assert(Array.isArray(storyGet.artifactContract?.entries), 'story_get detail missing artifact contract');

  const advance = run(absLivePath, [cli, '--root', temp, 'story_advance', JSON.stringify({ storyId, phase: 'TEST' })]);
  assert(advance.includes('rolled back to DEV'), 'story_advance TEST should rollback on implementation review fail');
  assert(advance.includes('implementation review'), 'story_advance rollback should mention implementation review');

  const updatedStory = JSON.parse(readFileSync(join(storyDir, 'index.json'), 'utf8'));
  assert(updatedStory.phase === 'DEV', 'story should be rolled back to DEV');
  assert(updatedStory.worktree?.path === livePath, 'cwd gate should auto-repair story.worktree.path to live worktree');

  console.log('runtime reviewer contract verified');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
