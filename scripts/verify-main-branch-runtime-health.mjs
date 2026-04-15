#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
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

const temp = mkdtempSync(join(tmpdir(), 'koala-main-runtime-'));

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

  const storyId = 'B-main';
  const branch = `story/${storyId}`;
  const stalePath = '.worktrees/B-main-stale';
  const livePath = '.worktrees/B-main-live';
  const absLivePath = join(temp, livePath);
  const storyDir = join(temp, 'docs', 'story', 'actives', storyId);
  mkdirSync(storyDir, { recursive: true });

  writeJson(join(storyDir, 'index.json'), {
    storyId,
    name: 'main-branch-runtime-health',
    title: 'Main branch runtime health',
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
  const hashInput = `${storyId}:${reviewTimestamp}:0:0:koala-review-integrity-v1`;
  writeJson(join(storyDir, 'review.json'), {
    reviews: [
      {
        timestamp: reviewTimestamp,
        issueCount: 0,
        blockerCount: 0,
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
        why: 'main-branch briefing should surface reviewer/runtime risk',
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

  const brief = run(temp, [cli, '--root', temp, 'session_brief']);
  assert(brief.includes('## Active stories'), 'main-branch session_brief missing active stories');
  assert(brief.includes('## Primary lane'), 'main-branch session_brief missing primary lane');
  assert(brief.includes('## Runtime health'), 'main-branch session_brief missing runtime health');
  assert(brief.includes('story record drifted'), 'main-branch session_brief missing drift summary');
  assert(brief.includes('## Reviewer status'), 'main-branch session_brief missing reviewer status');
  assert(
    brief.includes('implementation review 当前为 fail') ||
    brief.includes('implementation review 当前为 fail (1 findings)') ||
    brief.includes('implementation review (advisory) — fail'),
    'main-branch session_brief missing implementation-review fail signal',
  );
  assert(
    brief.includes('Resume: cd') || brief.includes('runtime is drift') || brief.includes('先修这条 reviewer 结论'),
    'main-branch session_brief missing recovery/next-step hint',
  );

  console.log('main branch runtime health verified');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
