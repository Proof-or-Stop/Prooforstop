#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { currentMaterialHash } from '../core/evidence-freshness.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, DeliveryCheckData, StoryInfo, StorySummaryData, TestEvidenceData } from '../core/types.js';
import { signDeliveryCheck } from '../handlers/delivery-check.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function commit(cwd: string, message: string, author = 'Koala Smoke'): string {
  git(cwd, ['add', '.']);
  git(cwd, [
    '-c', `user.name=${author}`,
    '-c', 'user.email=smoke@example.test',
    '-c', 'commit.gpgsign=false',
    'commit',
    '-m', message,
  ]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function initRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Koala Smoke']);
  write(root, 'koala.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
    workflow: { profile: 'balanced' },
  }, null, 2));
  write(root, '.gitignore', [
    '.worktrees/',
    '.koala/*',
    '!.koala/story/',
    '!.koala/story/**',
    '',
  ].join('\n'));
  write(root, 'README.md', 'field regression CLI smoke\n');
  write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
  commit(root, 'base');
  resetConfigCache();
  return root;
}

function runKoalaRaw(cwd: string, command: string, args: Record<string, unknown> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, command, JSON.stringify(args)], {
      cwd,
      env: { ...process.env, KOALA_PROJECT_ROOT: cwd },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', code => resolvePromise({ code: code ?? 0, stdout, stderr }));
  });
}

async function runKoala(cwd: string, command: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await runKoalaRaw(cwd, command, args);
  if (result.code !== 0) {
    throw new Error(`${command} exited ${result.code}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return result.stdout;
}

function now(): string {
  return '2026-05-08T10:00:00.000Z';
}

function writeReviewStory(store: StoryStore, storyId: string): void {
  const timestamp = now();
  const story: StoryInfo = {
    storyId,
    name: `${storyId.toLowerCase()}-field-regression`,
    title: `${storyId} field regression`,
    description: 'Synthetic story for field regression CLI smoke.',
    type: 'chore',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: timestamp,
    startedAt: timestamp,
    endedAt: null,
    currentReviewRound: timestamp,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp }],
  };
  const checklist: ChecklistData = {
    items: ['001', '002', '003'].map(suffix => ({
      id: `CHK-${suffix}`,
      title: `Synthetic item ${suffix}`,
      context: 'Synthetic context',
      status: 'done' as const,
      startTime: timestamp,
      endTime: timestamp,
    })),
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
}

async function assertPlanRemoveIsHardBlocked(): Promise<void> {
  const root = initRepo('koala-field-plan-freeze-');
  try {
    const storyId = 'B-freeze';
    const store = new StoryStore(root);
    const timestamp = now();
    store.writeStory(storyId, {
      storyId,
      name: 'plan-freeze-cli',
      title: 'Plan freeze CLI',
      description: 'Synthetic story for PLAN remove+add freeze CLI surface.',
      type: 'chore',
      phase: 'PLAN',
      priority: 'medium',
      createdAt: timestamp,
      startedAt: timestamp,
      endedAt: null,
      events: [{ phase: 'PLAN', action: 'advance', timestamp }],
    });
    store.writeChecklist(storyId, {
      items: [{
        id: 'CHK-001',
        title: 'Frozen title',
        context: 'Frozen context',
        status: 'pending',
        startTime: null,
        endTime: null,
      }],
    });

    const failed = await runKoalaRaw(root, 'checklist_remove', {
      storyId,
      itemId: 'CHK-001',
      disposition: 'accept',
      justification: 'Trying to replace a frozen checklist item',
    });
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /remove\+add 绕过/);
    assert.equal(new StoryStore(root).readChecklist(storyId).items.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertClusterAutoResolveCliSurface(): Promise<void> {
  const root = initRepo('koala-field-cluster-sync-');
  try {
    const storyId = 'B-clsync';
    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, 'packages/main/src/clustered.ts', 'export const clustered = true;\n');
    commit(root, 'implement cluster fix\n\nResolves: CL-001', 'koala-implementer');

    const store = new StoryStore(root);
    writeReviewStory(store, storyId);
    store.writeFindings(storyId, {
      findings: [{
        id: `${storyId}:F-001`,
        desc: 'clustered finding',
        severity: 'high',
        category: 'happy',
        status: 'open',
        agent: 'koala-review-quality',
        createdAt: now(),
        reviewRound: now(),
      }],
    });
    store.writeClusters(storyId, {
      clusters: [{
        clusterId: 'CL-001',
        rootCause: 'Synthetic root cause',
        severity: 'high',
        files: ['packages/main/src/clustered.ts'],
        findingIds: [`${storyId}:F-001`],
        createdAt: now(),
      }],
    });

    const output = await runKoala(root, 'finding_list', { storyId });
    assert.match(output, /"status":\s*"resolved"/);
    assert.match(output, /"resolvedBy":\s*"CL-001@/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertReviewPassConcurrentCliSurface(): Promise<void> {
  const root = initRepo('koala-field-review-pass-');
  try {
    const storyId = 'B-rpcli';
    const store = new StoryStore(root);
    writeReviewStory(store, storyId);
    const agents = ['concept', 'quality', 'test-coverage', 'docs', 'behavior']
      .map(name => `koala-review-${name}`);
    const outputs = await Promise.all(agents.map(agent => runKoala(root, 'review_pass_set', {
      storyId,
      agent,
      note: `${agent} checked current round and found no blocking findings.`,
    })));
    const ids = outputs.map(out => out.match(/B-rpcli:RP-\d+/)?.[0]).filter(Boolean);
    assert.equal(ids.length, agents.length);
    assert.equal(new Set(ids).size, agents.length, 'review_pass_set CLI outputs should all report unique durable ids');
    assert.equal(new StoryStore(root).readReviewPasses(storyId).passes.length, agents.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertChannelGateAcceptsSubagentResultCliSurface(): Promise<void> {
  const root = initRepo('koala-field-channel-');
  try {
    const storyId = 'B-channel';
    const store = new StoryStore(root);
    writeReviewStory(store, storyId);
    const story = store.readStory(storyId);
    story.riskSignals = [{ category: 'gate', matched: 'normal-channel-smoke' }];
    store.writeStory(storyId, story);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, 'packages/main/src/channel.ts', 'export const channel = true;\n');
    commit(root, 'implement channel surface', 'koala-implementer');
    for (const suffix of ['001', '002', '003']) {
      store.appendProcessEvent(storyId, {
        type: 'subagent_result',
        checklistId: `CHK-${suffix}`,
        success: true,
      });
    }

    const output = await runKoala(root, 'validate', { story: storyId, channel: true, json: true });
    assert.match(output, /"status":\s*"pass"/);
    assert.match(output, /subagent_result/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertEvidenceFreshAfterMetadataOnlyCliSurface(): Promise<void> {
  const root = initRepo('koala-field-evidence-');
  try {
    const storyId = 'B-evidence';
    const store = new StoryStore(root);
    writeReviewStory(store, storyId);
    const head = git(root, ['rev-parse', 'HEAD']);
    const materialHash = currentMaterialHash(root);
    assert.ok(materialHash);
    store.writeChecklist(storyId, {
      items: [{
        id: 'CHK-001',
        title: 'Evidence item',
        context: 'Evidence context',
        status: 'done',
        startTime: now(),
        endTime: now(),
        verificationIntent: {
          happy: [{ desc: 'metadata-only commits do not stale evidence', type: 'logic', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
        verificationEvidence: [{
          intentRef: 'CHK-001:happy:0',
          kind: 'logic_test',
          command: 'node packages/main/dist/tasks/verification-freshness-smoke.js',
          result: 'pass',
          note: 'field regression metadata-only freshness smoke',
          headHash: head,
          materialHash,
        }],
      }],
    });
    commit(root, 'metadata only story evidence');

    const output = await runKoala(root, 'validate', { story: storyId, json: true });
    assert.match(output, /"allPass":\s*true/);
    assert.match(output, /"covered":\s*1/);
    assert.doesNotMatch(output, /"status":\s*"stale"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeDoneReadyStory(worktree: string, storyId: string): void {
  const store = new StoryStore(worktree);
  const timestamp = now();
  const materialHash = currentMaterialHash(worktree);
  assert.ok(materialHash);
  const head = git(worktree, ['rev-parse', 'HEAD']);
  store.writeStory(storyId, {
    storyId,
    name: 'done-stray-review-passes',
    title: 'DONE stray review-passes',
    description: 'Synthetic DONE story for untracked review-passes cleanup.',
    type: 'chore',
    phase: 'TEST',
    priority: 'medium',
    createdAt: timestamp,
    startedAt: timestamp,
    endedAt: null,
    currentReviewRound: timestamp,
    worktree: {
      path: `.worktrees/${storyId}`,
      branch: `story/${storyId}`,
      createdAt: timestamp,
    },
    events: [{ phase: 'TEST', action: 'advance', timestamp }],
  });
  store.writeChecklist(storyId, {
    items: [{
      id: 'CHK-001',
      title: 'DONE cleanup item',
      context: 'DONE cleanup item',
      status: 'done',
      startTime: timestamp,
      endTime: timestamp,
    }],
  });
  const evidence: TestEvidenceData = {
    command: 'field regression validation',
    output: JSON.stringify({ allPass: true }),
    result: 'PASS',
    timestamp,
    headHash: head,
    materialHash,
    verificationCoverage: {
      total: 0,
      required: 0,
      covered: 0,
      missingRequired: 0,
      entries: [],
    },
  };
  store.writeTestEvidence(storyId, evidence);
  store.writeReviewPasses(storyId, {
    passes: [{
      id: `${storyId}:RP-001`,
      agent: 'koala-review-quality',
      note: 'Synthetic review pass tracked on story branch.',
      createdAt: timestamp,
      reviewRound: timestamp,
    }],
  });
  const summary: StorySummaryData = {
    storyId,
    createdAt: timestamp,
    updatedAt: timestamp,
    changes: 'Synthetic DONE cleanup change for review-passes whitelist.',
    usage: 'Run story_advance DONE from the linked worktree.',
    expectedOutcome: 'DONE merge should clean main untracked review-passes metadata.',
    actualTranscript: 'story_advance DONE should report cleanup and merge successfully.',
    outcomeDiff: 'No expected gap in synthetic CLI smoke.',
    acceptanceVerdict: 'accepted',
    outcomeKind: 'success',
    realMachineCoverage: { ran: [], skipped: [] },
    limitations: 'none',
    pitfalls: 'Main worktree untracked whitelist files must be cleaned before merge.',
  };
  store.writeSummary(storyId, summary);
  const docsPromises = [{
    docPath: 'CLAUDE.md',
    promise: 'review-passes.json is generated metadata that must not block DONE merge.',
    status: 'verified' as const,
    verifiedBy: 'field-regression-cli-smoke',
    evidence: 'story_advance DONE output reports cleanup.',
  }];
  const realMachineTests = [{
    featureId: 'CHK-001',
    transcript: 'Synthetic CLI DONE merge run.',
  }];
  const closingSelfCheck = {
    hasRealMachineTest: true,
    hasEdgeCaseCoverage: true,
    hasUnresolvedTodos: false,
    summary: 'Synthetic delivery check closes the DONE merge cleanup path.',
  };
  const delivery: DeliveryCheckData = {
    storyId,
    checkedAt: timestamp,
    reviewRound: timestamp,
    agentId: 'koala-review-delivery',
    docsPromises,
    realMachineTests,
    closingSelfCheck,
    _hash: signDeliveryCheck(storyId, docsPromises, realMachineTests, closingSelfCheck, timestamp),
  };
  store.writeDeliveryCheck(storyId, delivery);
}

async function assertDoneMergeCleansMainUntrackedReviewPasses(): Promise<void> {
  const root = initRepo('koala-field-done-stray-');
  try {
    const storyId = 'B-done';
    git(root, ['branch', `story/${storyId}`]);
    const worktree = join(root, '.worktrees', storyId);
    git(root, ['worktree', 'add', worktree, `story/${storyId}`]);
    writeDoneReadyStory(worktree, storyId);
    commit(worktree, 'prepare done story', 'koala-implementer');

    write(root, `.koala/story/actives/${storyId}/review-passes.json`, '{"passes":[]}\n');
    const output = await runKoala(worktree, 'story_advance', { storyId, phase: 'DONE' });

    assert.match(output, /清理主仓未追踪副本: .*review-passes\.json/);
    assert.match(output, /advanced to DONE/);
    assert.equal(git(root, ['status', '--porcelain', '--', `.koala/story/actives/${storyId}/review-passes.json`]), '');
    assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '');
    assert.equal(existsSync(worktree), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertStaleWarningCooldownCliSurface(): Promise<void> {
  const root = initRepo('koala-field-stale-warning-');
  try {
    const storyId = 'B-stale';
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const store = new StoryStore(root);
    const old = '2026-05-08T06:00:00.000Z';
    store.writeStory(storyId, {
      storyId,
      name: 'stale-warning-cli',
      title: 'Stale warning CLI',
      description: 'Synthetic story for stale warning cooldown.',
      type: 'chore',
      phase: 'REVIEW',
      priority: 'medium',
      createdAt: old,
      startedAt: old,
      endedAt: null,
      events: [{ phase: 'REVIEW', action: 'advance', timestamp: old }],
    });
    store.writeChecklist(storyId, { items: [] });

    const first = await runKoalaRaw(root, 'session_brief');
    assert.equal(first.code, 0);
    assert.match(first.stderr, /koala stale state warnings/);
    const second = await runKoalaRaw(root, 'session_brief');
    assert.equal(second.code, 0);
    assert.doesNotMatch(second.stderr, /koala stale state warnings/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await assertPlanRemoveIsHardBlocked();
await assertClusterAutoResolveCliSurface();
await assertReviewPassConcurrentCliSurface();
await assertChannelGateAcceptsSubagentResultCliSurface();
await assertEvidenceFreshAfterMetadataOnlyCliSurface();
await assertDoneMergeCleansMainUntrackedReviewPasses();
await assertStaleWarningCooldownCliSurface();

console.log('✓ field regression CLI smoke passed');
