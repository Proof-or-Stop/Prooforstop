#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { currentMaterialHash } from '../core/evidence-freshness.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, DeliveryCheckData, StoryInfo, StorySummaryData, TestEvidenceData } from '../core/types.js';
import { getRuntimeActivityLogPath } from '../core/activity-log.js';
import { signDeliveryCheck } from '../handlers/delivery-check.js';
import { createFindingHandlers } from '../handlers/finding.js';

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

function allowEmptyCommit(cwd: string, message: string, author = 'koala-implementer'): string {
  git(cwd, [
    '-c', `user.name=${author}`,
    '-c', 'user.email=smoke@example.test',
    '-c', 'commit.gpgsign=false',
    'commit',
    '--allow-empty',
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

function extractReviewRunId(output: string): string {
  const match = output.match(/B-[^:\s]+:RR-\d+/);
  assert.ok(match?.[0], `expected review_run_start output to include a review run id, got: ${output}`);
  return match![0];
}

async function startReviewRun(cwd: string, storyId: string, agent: string, extra: Record<string, unknown> = {}): Promise<string> {
  const output = await runKoala(cwd, 'review_run_start', {
    storyId,
    agent,
    ...extra,
  });
  return extractReviewRunId(output);
}

function now(): string {
  return '2026-05-08T10:00:00.000Z';
}

function assertIsoReviewRound(value: string | undefined, expected: string, context: string): void {
  assert.equal(value, expected, `${context} should use story.currentReviewRound`);
  assert.match(value || '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `${context} should be ISO 8601`);
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
    commit(root, 'implement cluster fix\n\nResolves: CL-001 CL-002', 'koala-implementer');

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
      }, {
        id: `${storyId}:F-002`,
        desc: 'second clustered finding',
        severity: 'medium',
        category: 'edge',
        status: 'open',
        agent: 'koala-review-concept',
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
      }, {
        clusterId: 'CL-002',
        rootCause: 'Second synthetic root cause',
        severity: 'medium',
        files: ['packages/main/src/clustered.ts'],
        findingIds: [`${storyId}:F-002`],
        createdAt: now(),
      }],
    });

    const output = await runKoala(root, 'finding_list', { storyId });
    assert.match(output, /"id":\s*"B-clsync:F-001"[\s\S]*"status":\s*"resolved"/);
    assert.match(output, /"resolvedBy":\s*"CL-001@/);
    assert.match(output, /"id":\s*"B-clsync:F-002"[\s\S]*"status":\s*"resolved"/);
    assert.match(output, /"resolvedBy":\s*"CL-002@/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDirectFindingAutoResolveCliSurface(): Promise<void> {
  const root = initRepo('koala-field-finding-sync-');
  try {
    const storyId = 'B-fsync';
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const store = new StoryStore(root);
    writeReviewStory(store, storyId);

    const qualityRunId = await startReviewRun(root, storyId, 'koala-review-quality');
    await runKoala(root, 'finding_add', {
      storyId,
      desc: 'direct finding should resolve from commit tag',
      severity: 'high',
      category: 'happy',
      agent: 'koala-review-quality',
      reviewRunId: qualityRunId,
    });
    allowEmptyCommit(root, `resolve direct finding\n\nResolves: ${storyId}:F-001`);

    const output = await runKoala(root, 'finding_list', { storyId });
    assert.match(output, /"status":\s*"resolved"/);
    assert.match(output, /"resolvedBy":\s*"B-fsync:F-001@/);

    const conceptRunId = await startReviewRun(root, storyId, 'koala-review-concept');
    await runKoala(root, 'finding_add', {
      storyId,
      desc: 'validate entry should also resolve direct finding',
      severity: 'medium',
      category: 'edge',
      agent: 'koala-review-concept',
      reviewRunId: conceptRunId,
    });
    allowEmptyCommit(root, 'resolve short direct finding\n\nResolves: F-002');
    const validateOutput = await runKoala(root, 'validate', { story: storyId, json: true });
    assert.match(validateOutput, /"allPass":\s*true/);
    const findings = new StoryStore(root).readFindings(storyId).findings;
    const directFinding = findings.find(f => f.id === `${storyId}:F-002`);
    assert.equal(directFinding?.status, 'resolved');
    assert.match(directFinding?.resolvedBy || '', /^F-002@/);
    assertIsoReviewRound(directFinding?.reviewRound, now(), 'CLI-created finding reviewRound');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertReviewRunStartCliSurface(): Promise<void> {
  const root = initRepo('koala-field-review-run-');
  try {
    const storyId = 'B-runcli';
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const store = new StoryStore(root);
    writeReviewStory(store, storyId);

    const output = await runKoala(root, 'review_run_start', {
      storyId,
      agent: 'koala-review-quality',
      prompt: 'Inspect current diff for REVIEW blockers.',
    });
    assert.match(output, /Review run B-runcli:RR-001 started for koala-review-quality/);
    const runs = store.readReviewRuns(storyId).runs;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].lane, 'koala-review-quality');
    assert.equal(runs[0].agent, 'koala-review-quality');
    assert.equal(runs[0].storyId, storyId);
    assert.ok(runs[0].headHash);
    assert.ok(runs[0].materialHash);
    assert.ok(runs[0].promptHash);

    write(root, 'packages/main/src/review-run-fresh.ts', 'export const reviewRunFresh = true;\n');
    commit(root, 'change after review run', 'koala-implementer');
    const stalePass = await runKoalaRaw(root, 'review_pass_set', {
      storyId,
      agent: 'koala-review-quality',
      reviewRunId: runs[0].reviewRunId,
      note: 'stale run should be rejected after material change.',
    });
    assert.notEqual(stalePass.code, 0);
    assert.match(stalePass.stderr, /已 stale|stale/i);

    const unsupported = await runKoalaRaw(root, 'review_run_start', {
      storyId,
      lane: 'koala-review-delivery',
    });
    assert.notEqual(unsupported.code, 0);
    assert.match(unsupported.stderr, /Invalid enum value|不在受支持的 REVIEW reviewer lane/);

    const mainStoryId = 'B-main';
    store.writeStory(mainStoryId, {
      storyId: mainStoryId,
      name: 'review-run-dev-cli',
      title: 'review run dev cli',
      description: 'Synthetic REVIEW story without currentReviewRound.',
      type: 'chore',
      phase: 'REVIEW',
      priority: 'medium',
      createdAt: now(),
      startedAt: now(),
      endedAt: null,
      events: [{ phase: 'REVIEW', action: 'advance', timestamp: now() }],
    });
    store.writeChecklist(mainStoryId, { items: [] });
    git(root, ['checkout', '-b', `story/${mainStoryId}`]);
    const missingRound = await runKoalaRaw(root, 'review_run_start', {
      storyId: mainStoryId,
      agent: 'koala-review-quality',
    });
    assert.notEqual(missingRound.code, 0);
    assert.match(missingRound.stderr, /没有 currentReviewRound/);
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
    const runIds = new Map(await Promise.all(agents.map(async (agent) => [agent, await startReviewRun(root, storyId, agent)] as const)));
    const outputs = await Promise.all(agents.map(agent => runKoala(root, 'review_pass_set', {
      storyId,
      agent,
      reviewRunId: runIds.get(agent),
      note: `${agent} checked current round and found no blocking findings.`,
    })));
    const ids = outputs.map(out => out.match(/B-rpcli:RP-\d+/)?.[0]).filter(Boolean);
    assert.equal(ids.length, agents.length);
    assert.equal(new Set(ids).size, agents.length, 'review_pass_set CLI outputs should all report unique durable ids');
    const passes = new StoryStore(root).readReviewPasses(storyId).passes;
    assert.equal(passes.length, agents.length);
    for (const pass of passes) {
      assertIsoReviewRound(pass.reviewRound, now(), `CLI-created review pass ${pass.id} reviewRound`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertPassOnlyFindingConvertsToReviewPassCliSurface(): Promise<void> {
  const root = initRepo('koala-field-pass-only-finding-');
  try {
    const storyId = 'B-passonly';
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const store = new StoryStore(root);
    writeReviewStory(store, storyId);
    const docsRunId = await startReviewRun(root, storyId, 'koala-review-docs');
    const conceptRunId = await startReviewRun(root, storyId, 'koala-review-concept');
    const channelRunId = await startReviewRun(root, storyId, 'koala-review-channel');
    const qualityRunId = await startReviewRun(root, storyId, 'koala-review-quality');
    const behaviorRunId = await startReviewRun(root, storyId, 'koala-review-behavior');

    const passOutput = await runKoala(root, 'finding_add', {
      storyId,
      desc: '文档一致性检查通过：Step 1 抽出 2 个符号，Step 2 比对 3 个段落；consistency check PASSED。',
      severity: 'low',
      category: 'happy',
      agent: 'koala-review-docs',
      reviewRunId: docsRunId,
    });
    assert.match(passOutput, /Review pass B-passonly:RP-001 recorded by koala-review-docs/);
    assert.equal(store.readFindings(storyId).findings.length, 0, 'pass-only finding_add should not write findings.json');
    const passes = store.readReviewPasses(storyId).passes;
    assert.equal(passes.length, 1);
    assert.equal(passes[0].agent, 'koala-review-docs');
    assert.match(passes[0].note, /文档一致性检查通过/);
    assertIsoReviewRound(passes[0].reviewRound, now(), 'pass-only converted review pass reviewRound');
    const emptyFindingList = await runKoala(root, 'finding_list', { storyId });
    assert.match(emptyFindingList, /"findings":\s*\[\]/, 'pass-only finding_add should not appear in finding_list');

    const noDriftOutput = await runKoala(root, 'finding_add', {
      storyId,
      desc: '文档一致性检查通过：未发现不一致。',
      severity: 'low',
      category: 'happy',
      agent: 'koala-review-docs',
      reviewRunId: docsRunId,
    });
    assert.match(noDriftOutput, /Review pass B-passonly:RP-002 recorded by koala-review-docs/);
    assert.equal(store.readFindings(storyId).findings.length, 0, 'negated no-drift wording should remain a review pass');

    const conceptPassOutput = await runKoala(root, 'finding_add', {
      storyId,
      desc: '本次无概念变更',
      severity: 'low',
      category: 'happy',
      agent: 'koala-review-concept',
      reviewRunId: conceptRunId,
    });
    assert.match(conceptPassOutput, /Review pass B-passonly:RP-003 recorded by koala-review-concept/);
    assert.equal(store.readFindings(storyId).findings.length, 0, 'concept pass-only finding_add should not write findings.json');

    const channelPassOutput = await runKoala(root, 'finding_add', {
      storyId,
      desc: '极速通道（≤2 items，无 riskSignals），主 agent 自写合规',
      severity: 'low',
      category: 'happy',
      agent: 'koala-review-channel',
      reviewRunId: channelRunId,
    });
    assert.match(channelPassOutput, /Review pass B-passonly:RP-004 recorded by koala-review-channel/);
    assert.equal(store.readFindings(storyId).findings.length, 0, 'channel pass-only finding_add should not write findings.json');

    const noFindingsOutput = await runKoala(root, 'finding_add', {
      storyId,
      desc: 'No findings after checking process facts.',
      severity: 'low',
      category: 'happy',
      agent: 'koala-review-quality',
      reviewRunId: qualityRunId,
    });
    assert.match(noFindingsOutput, /Review pass B-passonly:RP-005 recorded by koala-review-quality/);
    assert.equal(store.readFindings(storyId).findings.length, 0, 'no findings wording should convert to review pass');

    const genericPassOutput = await runKoala(root, 'finding_add', {
      storyId,
      desc: '检查通过：流程事实入口都有 hardcoded fallback。',
      severity: 'low',
      category: 'happy',
      agent: 'koala-review-behavior',
      reviewRunId: behaviorRunId,
    });
    assert.match(genericPassOutput, /Review pass B-passonly:RP-006 recorded by koala-review-behavior/);
    assert.equal(store.readFindings(storyId).findings.length, 0, 'generic check-pass wording should convert to review pass');

    const explicitPassOutput = await runKoala(root, 'finding_add', {
      storyId,
      desc: 'PASS: schema and handler fallback are aligned.',
      severity: 'low',
      category: 'happy',
      agent: 'koala-review-docs',
      reviewRunId: docsRunId,
    });
    assert.match(explicitPassOutput, /Review pass B-passonly:RP-007 recorded by koala-review-docs/);
    assert.equal(store.readFindings(storyId).findings.length, 0, 'explicit PASS wording should convert to review pass');

    const findingOutput = await runKoala(root, 'finding_add', {
      storyId,
      desc: '文档一致性检查通过但是 README 示例命令失败，需修正文档。',
      severity: 'low',
      category: 'edge',
      agent: 'koala-review-docs',
      reviewRunId: docsRunId,
    });
    assert.match(findingOutput, /Finding B-passonly:F-001 created by koala-review-docs/);
    const findings = store.readFindings(storyId).findings;
    assert.equal(findings.length, 1);
    assert.equal(findings[0].status, 'open');

    const cleanupOutput = await runKoala(root, 'finding_add', {
      storyId,
      desc: 'concept-cleanup: 概念 X 删除不完整，Y 文件仍有 2 处引用。',
      severity: 'critical',
      category: 'cleanup',
      agent: 'koala-review-concept',
      reviewRunId: conceptRunId,
    });
    assert.match(cleanupOutput, /Finding B-passonly:F-002 created by koala-review-concept: \[critical\/missing\]/);
    const cleanupFindings = store.readFindings(storyId).findings;
    assert.equal(cleanupFindings.length, 2);
    assert.equal(cleanupFindings[1].category, 'missing');

    const docPromiseOutput = await runKoala(root, 'finding_add', {
      storyId,
      desc: 'doc-promise-undelivered: README 承诺了 koala foo 命令，但 registry 中不存在。',
      severity: 'critical',
      category: 'doc-promise-undelivered',
      agent: 'koala-review-quality',
      reviewRunId: qualityRunId,
    });
    assert.match(docPromiseOutput, /Finding B-passonly:F-003 created by koala-review-quality: \[critical\/missing\]/);
    const docPromiseFindings = store.readFindings(storyId).findings;
    assert.equal(docPromiseFindings.length, 3);
    assert.equal(docPromiseFindings[2].category, 'missing');

    const nonLowPassOutput = await runKoala(root, 'finding_add', {
      storyId,
      desc: 'PASS: docs consistency check PASSED with reviewer approval.',
      severity: 'medium',
      category: 'happy',
      agent: 'koala-review-docs',
      reviewRunId: docsRunId,
    });
    assert.match(nonLowPassOutput, /Finding B-passonly:F-004 created by koala-review-docs/);
    assert.equal(store.readFindings(storyId).findings.length, 4, 'non-low pass-like finding_add should remain a finding');

    const nonReviewerPassOutput = await runKoala(root, 'finding_add', {
      storyId,
      desc: 'No findings after checking process facts.',
      severity: 'low',
      category: 'happy',
      agent: 'main',
    });
    assert.match(nonReviewerPassOutput, /Finding B-passonly:F-005 created by main/);
    assert.equal(store.readFindings(storyId).findings.length, 5, 'non-reviewer pass-like finding_add should remain a finding');

    assert.throws(
      () => createFindingHandlers({ store, root, scanRoot: join(root, 'packages/main') }).finding_add({
        storyId,
        desc: 'novel category should be rejected by handler fallback.',
        severity: 'medium',
        category: 'docs',
        agent: 'koala-review-quality',
        reviewRunId: qualityRunId,
      }),
      /category must be one of happy\|edge\|adversarial\|missing/,
      'unknown finding category should be rejected even when bypassing CLI schema',
    );
    assert.throws(
      () => createFindingHandlers({ store, root, scanRoot: join(root, 'packages/main') }).finding_add({
        storyId,
        desc: 'PASS: schema and handler fallback are aligned.',
        severity: 'low',
        category: 'docs',
        agent: 'koala-review-quality',
        reviewRunId: qualityRunId,
      }),
      /category must be one of happy\|edge\|adversarial\|missing/,
      'unknown finding category must be rejected before pass-only review normalization',
    );
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

async function assertVerificationEvidenceKindAliasesCliSurface(): Promise<void> {
  const root = initRepo('koala-field-evidence-alias-');
  try {
    const storyId = 'B-evalias';
    const store = new StoryStore(root);
    store.writeStory(storyId, {
      storyId,
      name: 'evidence-kind-alias-cli',
      title: 'Evidence kind alias CLI',
      description: 'Synthetic story for verification evidence kind alias CLI surface.',
      type: 'chore',
      phase: 'DEV',
      priority: 'medium',
      createdAt: now(),
      startedAt: now(),
      endedAt: null,
      events: [{ phase: 'DEV', action: 'advance', timestamp: now() }],
    });
    store.writeChecklist(storyId, {
      items: [{
        id: 'CHK-001',
        title: 'Evidence aliases item',
        context: 'Evidence aliases context',
        status: 'in_progress',
        startTime: now(),
        endTime: null,
        verificationIntent: {
          happy: [{ desc: 'cli alias records a manual transcript evidence kind', type: 'cli', priority: 'must' }],
          edge: [{ desc: 'logic alias records a logic test evidence kind', type: 'logic', priority: 'must' }],
          adversarial: [],
        },
      }],
    });

    const cliOutput = await runKoala(root, 'verification_evidence_add', {
      storyId,
      itemId: 'CHK-001',
      intentRef: 'CHK-001:happy:0',
      kind: 'cli',
      result: 'pass',
      note: 'CLI alias should persist as manual transcript evidence',
    });
    assert.match(cliOutput, /manual_transcript, alias cli/);

    const batchOutput = await runKoala(root, 'verification_evidence_batch_add', {
      storyId,
      evidences: [{
        itemId: 'CHK-001',
        intentRef: 'CHK-001:edge:0',
        kind: 'logic',
        result: 'pass',
        note: 'Logic alias should persist as logic test evidence',
      }],
    });
    assert.match(batchOutput, /1 item intent/);

    const evidence = new StoryStore(root).readChecklist(storyId).items[0].verificationEvidence || [];
    assert.equal(evidence.find(ev => ev.intentRef === 'CHK-001:happy:0')?.kind, 'manual_transcript');
    assert.equal(evidence.find(ev => ev.intentRef === 'CHK-001:edge:0')?.kind, 'logic_test');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertHotfixPriorityElevationCliSurface(): Promise<void> {
  const root = initRepo('koala-field-hotfix-priority-');
  try {
    const background = [
      '## 触发事件',
      '2026-05-08 B-hotfix 用户报告 hotfix 修复需要记录，即使请求低优先级也应该显式进入高风险审查路径，避免紧急词被文档口径隐藏。',
      '',
      '## 关键洞察',
      '这里要验证的不是业务功能，而是 CLI surface 是否诚实说明 effective priority 会覆盖原始 priority，并让 agent 预期 preMortem gate。',
      '',
      '## 方案取舍',
      '保留 hotfix 自动 elevate 行为，因为它保护生产和紧急修复路径；本 smoke 只锁住输出文案和持久化 priority。',
      '',
      '## 对话纹理',
      '用户之前观察到 low priority hotfix 也会要求 preMortem，这个行为可以接受，但文档和命令输出必须直接讲清楚。',
    ].join('\n');
    const output = await runKoala(root, 'story_create', {
      name: 'hotfix-priority-surface',
      title: 'Hotfix priority surface',
      description: 'low priority hotfix should still use effective high-risk gate',
      type: 'chore',
      priority: 'low',
      background,
      checklist: [{ title: 'Record effective priority wording', context: 'CLI output should explain low hotfix elevation' }],
    });
    assert.match(output, /已自动 elevate priority: low → high/);
    assert.match(output, /原始 priority=low/);
    const [storyId] = new StoryStore(root).listStoryIds();
    assert.ok(storyId);
    const story = new StoryStore(root).readStory(storyId);
    assert.equal(story.priority, 'high');
    assert.ok((story.riskSignals || []).some(sig => sig.matched.toLowerCase() === 'hotfix'));
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
    const logPath = getRuntimeActivityLogPath(root);
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    assert.ok(Array.isArray(last.staleWarnings));
    last.staleWarnings = last.staleWarnings.map((warning: string) =>
      warning.replace(/\d+h(?: \d+ 分钟)?|\d+ 分钟/, '999h'),
    );
    lines[lines.length - 1] = JSON.stringify(last);
    writeFileSync(logPath, `${lines.join('\n')}\n`);
    const second = await runKoalaRaw(root, 'session_brief');
    assert.equal(second.code, 0);
    assert.doesNotMatch(second.stderr, /koala stale state warnings/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await assertPlanRemoveIsHardBlocked();
await assertClusterAutoResolveCliSurface();
await assertDirectFindingAutoResolveCliSurface();
await assertReviewRunStartCliSurface();
await assertReviewPassConcurrentCliSurface();
await assertPassOnlyFindingConvertsToReviewPassCliSurface();
await assertChannelGateAcceptsSubagentResultCliSurface();
await assertEvidenceFreshAfterMetadataOnlyCliSurface();
await assertVerificationEvidenceKindAliasesCliSurface();
await assertHotfixPriorityElevationCliSurface();
await assertDoneMergeCleansMainUntrackedReviewPasses();
await assertStaleWarningCooldownCliSurface();

console.log('✓ field regression CLI smoke passed');
