#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const repoRoot = process.cwd();
const cli = join(repoRoot, 'packages/main/dist/cli.js');

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

const temp = mkdtempSync(join(tmpdir(), 'proof-or-stop-null-intent-'));

try {
  mkdirSync(join(temp, 'docs', 'story', 'actives', 'B-test'), { recursive: true });
  mkdirSync(join(temp, 'docs', 'requirements'), { recursive: true });
  writeJson(join(temp, 'proof-or-stop.config.json'), {
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  });

  git(temp, ['init', '-b', 'main']);
  git(temp, ['config', 'user.name', 'ProofOrStop Test']);
  git(temp, ['config', 'user.email', 'proofOrStop@example.com']);
  writeFileSync(join(temp, '.gitignore'), 'node_modules\n');
  git(temp, ['add', '.']);
  git(temp, ['commit', '-m', 'init']);
  git(temp, ['checkout', '-b', 'story/B-test']);

  const storyDir = join(temp, 'docs', 'story', 'actives', 'B-test');
  const timestamp = new Date().toISOString();
  const reviewSalt = 'proof-or-stop-review-integrity-v1';
  const hashInput = `B-test:${timestamp}:0:0:${reviewSalt}`;

  writeJson(join(storyDir, 'index.json'), {
    storyId: 'B-test',
    name: 'null-intent-doc-story',
    title: 'Null intent doc story',
    description: 'doc-only story with explicit null testIntent',
    type: 'chore',
    phase: 'TEST',
    priority: 'medium',
    createdAt: timestamp,
    startedAt: timestamp,
    endedAt: null,
    worktree: {
      path: '.',
      branch: 'story/B-test',
      createdAt: timestamp,
    },
  });

  writeJson(join(storyDir, 'checklist.json'), {
    items: [
      {
        id: 'CHK-001',
        title: 'doc-only item',
        status: 'done',
        startTime: timestamp,
        endTime: timestamp,
        testIntent: null,
      },
    ],
  });

  writeJson(join(storyDir, 'review.json'), {
    reviews: [
      {
        timestamp,
        issueCount: 0,
        blockerCount: 0,
        issues: [],
        _hash: createHash('sha256').update(hashInput).digest('hex'),
      },
    ],
  });

  writeJson(join(storyDir, 'implementation-review.json'), {
    storyId: 'B-test',
    verdict: 'pass',
    findings: [],
    summary: 'doc-only story has no implementation regression risk',
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  writeJson(join(storyDir, 'test-evidence.json'), {
    command: 'test_story',
    output: JSON.stringify({ allPassed: true, totalCases: 0 }),
    result: 'PASS',
    timestamp,
  });

  writeJson(join(storyDir, 'bug.json'), { bugs: [] });

  writeJson(join(storyDir, 'summary.json'), {
    storyId: 'B-test',
    changes: 'Clarified doc-only story completion behavior for explicit null testIntent items.',
    usage: 'Create doc-only checklist items with testIntent:null when no fixture coverage is required.',
    limitations: 'none — fully covered',
    pitfalls: 'DONE gate and reviewer status must treat explicit null as exempt rather than missing.',
    realMachineCoverage: {
      ran: [],
      skipped: [],
    },
    skipReasons: {},
    generatedAt: timestamp,
  });

  git(temp, ['add', '.']);
  git(temp, ['commit', '-m', 'story']);

  const { StoryStore } = await import(join(repoRoot, 'packages/main/dist/core/store.js'));
  const { getPhaseInvariantStatus } = await import(join(repoRoot, 'packages/main/dist/core/machine.js'));
  const { getReviewerStatus } = await import(join(repoRoot, 'packages/main/dist/core/reviewer-status.js'));
  const { getArtifactContractStatus } = await import(join(repoRoot, 'packages/main/dist/core/artifact-contract.js'));

  const store = new StoryStore(temp);
  const phaseStatus = getPhaseInvariantStatus('B-test', store, 'TEST');
  assert(phaseStatus.ok === true, `TEST invariant should pass, got ${JSON.stringify(phaseStatus.issues)}`);

  const reviewerStatus = getReviewerStatus('B-test', store, 'DONE');
  const testIntentReview = reviewerStatus.entries.find((entry) => entry.key === 'test_intent_review');
  assert(testIntentReview?.verdict === 'pass', `test-intent review should pass, got ${testIntentReview?.verdict}`);
  assert(testIntentReview?.blocking === false, 'test-intent review should not block DONE');

  const artifactStatus = getArtifactContractStatus('B-test', store, 'DONE');
  const testIntentArtifact = artifactStatus.entries.find((entry) => entry.key === 'test_intent_review');
  assert(testIntentArtifact?.required === true, 'DONE should still mark test-intent review as required');
  assert(testIntentArtifact?.present === true, 'null-only doc story should satisfy required reviewer artifact');

  const brief = run(temp, [cli, '--root', temp, 'session_brief']);
  assert(brief.includes('[✓] test-intent review (required) — pass'), 'session_brief should show reviewer pass');

  const dryRun = run(temp, [cli, '--root', temp, 'story_advance', JSON.stringify({ storyId: 'B-test', phase: 'DONE', dryRun: true })]);
  assert(!dryRun.includes('test-intent review: missing'), 'DONE dry-run should not report missing test-intent review');

  console.log('testIntent:null gate handling verified');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
