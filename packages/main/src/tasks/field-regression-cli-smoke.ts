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
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
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

function initRepo(prefix: string, storyDir = '.koala/story/actives'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Koala Smoke']);
  write(root, 'koala.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir,
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
    assert.match(failed.stderr, /remove\+add bypass/);
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
    assert.match(stalePass.stderr, /already stale|stale/i);
    assert.match(stalePass.stderr, /DEV.*REVIEW|DEV → REVIEW/);
    assert.doesNotMatch(stalePass.stderr, /re-run koala review_run_start/);

    const unsupported = await runKoalaRaw(root, 'review_run_start', {
      storyId,
      lane: 'koala-review-delivery',
    });
    assert.notEqual(unsupported.code, 0);
    assert.match(unsupported.stderr, /Invalid enum value|Invalid option: expected one of|not in supported REVIEW reviewer lane/);

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
    assert.match(missingRound.stderr, /no currentReviewRound/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertReviewerListForceReviewerLaneContract(): Promise<void> {
  const root = initRepo('koala-field-force-reviewer-');
  try {
    const storyId = 'B-force';
    const store = new StoryStore(root);
    writeReviewStory(store, storyId);

    const output = await runKoala(root, 'reviewer_list', {
      storyId,
      json: true,
      forceReviewer: 'koala-review-docs, behavior, channel',
    });
    type ReviewerListEntry = { name: string; forced?: boolean };
    const parsed = JSON.parse(output) as { reviewers: ReviewerListEntry[] };
    const reviewers = new Map<string, ReviewerListEntry>(parsed.reviewers.map((entry) => [entry.name, entry]));
    assert.equal(reviewers.get('docs')?.forced, true, 'full built-in lane should normalize to a forced short reviewer name');
    assert.equal(reviewers.get('behavior')?.forced, true, 'built-in short reviewer name should remain supported');
    assert.equal(reviewers.get('channel')?.forced, true, 'retired compatibility lane should remain forceable while review_run_start supports it');
    assert.equal(reviewers.has('koala-review-docs'), false, 'forced reviewer output should not mix full lane names into opt-in names');

    const invalid = await runKoalaRaw(root, 'reviewer_list', {
      storyId,
      json: true,
      forceReviewer: 'koala-review-delivery',
    });
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.stderr, /not supported by review_run_start/);
    assert.match(invalid.stderr, /koala-review-quality/);
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
      desc: 'Docs consistency check passed: Step 1 extracted 2 symbols, Step 2 compared 3 sections; consistency check PASSED.',
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
    assert.match(passes[0].note, /Docs consistency check passed/);
    assertIsoReviewRound(passes[0].reviewRound, now(), 'pass-only converted review pass reviewRound');
    const emptyFindingList = await runKoala(root, 'finding_list', { storyId });
    assert.match(emptyFindingList, /"findings":\s*\[\]/, 'pass-only finding_add should not appear in finding_list');

    const noDriftOutput = await runKoala(root, 'finding_add', {
      storyId,
      desc: 'Docs consistency check passed: no inconsistencies found.',
      severity: 'low',
      category: 'happy',
      agent: 'koala-review-docs',
      reviewRunId: docsRunId,
    });
    assert.match(noDriftOutput, /Review pass B-passonly:RP-002 recorded by koala-review-docs/);
    assert.equal(store.readFindings(storyId).findings.length, 0, 'negated no-drift wording should remain a review pass');

    const conceptPassOutput = await runKoala(root, 'finding_add', {
      storyId,
      desc: 'No concept changes this round',
      severity: 'low',
      category: 'happy',
      agent: 'koala-review-concept',
      reviewRunId: conceptRunId,
    });
    assert.match(conceptPassOutput, /Review pass B-passonly:RP-003 recorded by koala-review-concept/);
    assert.equal(store.readFindings(storyId).findings.length, 0, 'concept pass-only finding_add should not write findings.json');

    const channelPassOutput = await runKoala(root, 'finding_add', {
      storyId,
      desc: 'Express channel (≤2 items, no riskSignals), main agent self-write compliant',
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
      desc: 'Check passed: all flow fact entry points have hardcoded fallback.',
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

    const localizedPassOutput = await runKoala(root, 'finding_add', {
      storyId,
      desc: '\u5ba1\u67e5\u901a\u8fc7\uff1a\u5df2\u68c0\u67e5\u8303\u56f4\uff0c\u65e0\u963b\u585e\u95ee\u9898\u3002',
      severity: 'low',
      category: 'happy',
      agent: 'koala-review-docs',
      reviewRunId: docsRunId,
    });
    assert.match(localizedPassOutput, /Review pass B-passonly:RP-008 recorded by koala-review-docs/);
    assert.equal(store.readFindings(storyId).findings.length, 0, 'localized pass-only finding_add should convert to review pass');

    const findingOutput = await runKoala(root, 'finding_add', {
      storyId,
      desc: 'Docs consistency check passed but README example command failed; docs need fixing.',
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
      desc: 'concept-cleanup: concept X deletion incomplete, Y file still has 2 references.',
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
      desc: 'doc-promise-undelivered: README promised koala foo command but it does not exist in registry.',
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

async function assertDecisionSetAcceptsLocalizedExclusionRationale(): Promise<void> {
  const root = initRepo('koala-field-decision-localized-');
  try {
    const storyId = 'B-decision';
    const store = new StoryStore(root);
    const timestamp = now();
    store.writeStory(storyId, {
      storyId,
      name: 'localized-decision',
      title: 'Localized decision',
      description: 'Synthetic story for localized decision rationale.',
      type: 'chore',
      phase: 'PLAN',
      priority: 'medium',
      createdAt: timestamp,
      startedAt: timestamp,
      endedAt: null,
      events: [{ phase: 'PLAN', action: 'advance', timestamp }],
    });
    store.writeChecklist(storyId, { items: [] });

    const rationale = [
      '\u6392\u9664\u5176\u4ed6\u5907\u9009\uff1a\u5f53\u524d\u5de5\u4f5c\u53ea\u662f\u6062\u590d\u5df2\u6709\u884c\u4e3a\uff0c',
      '\u66ff\u4ee3\u65b9\u6848\u4f1a\u6269\u5927\u8303\u56f4\u5e76\u589e\u52a0\u4e0d\u5fc5\u8981\u98ce\u9669\uff0c',
      '\u6240\u4ee5\u4fdd\u7559\u5355\u4e00\u65b9\u6848\u5e76\u8bb0\u5f55\u539f\u56e0\u3002',
    ].join('');

    const output = await runKoala(root, 'decision_set', {
      storyId,
      principles: ['Preserve behavior', 'Keep scope narrow', 'Prefer reversible changes'],
      drivers: ['Localized rationale must not be rejected by an English keyword check'],
      options: [],
      chosen: 'single-solution',
      rationale,
    });
    assert.match(output, /Decision saved for B-decision/);
    const decision = store.readDecision(storyId);
    assert.ok(decision);
    assert.equal(decision.rationale, rationale);
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
    commit(root, 'implement channel surface', 'main-agent');
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
  const root = initRepo('koala-field-evidence-', 'Docs/story/actives');
  try {
    const storyId = 'B-evidence';
    const store = new StoryStore(root);
    writeReviewStory(store, storyId);
    assert.equal(existsSync(join(root, 'Docs/story/actives', storyId, 'index.json')), true);
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
      '## Trigger Event',
      '2026-05-08 B-hotfix user reported hotfix fixes need to be recorded; even if the request is low priority, it should explicitly enter the high-risk review path to avoid emergency keywords being hidden by docs wording.',
      '',
      '## Key Insight',
      'What needs to be verified here is not the business function, but whether the CLI surface honestly explains that effective priority overrides the original priority, and lets the agent anticipate the preMortem gate.',
      '',
      '## Trade-offs',
      'Keep the hotfix auto-elevate behavior, since it protects production and emergency fix paths; this smoke only locks the output wording and persisted priority.',
      '',
      '## Conversation Texture',
      'The user previously observed that low priority hotfixes also require preMortem; this behavior is acceptable, but the documentation and command output must state it clearly.',
    ].join('\n');
    const result = await runKoalaRaw(root, 'story_create', {
      name: 'hotfix-priority-surface',
      title: 'Hotfix priority surface',
      description: 'low priority hotfix should still use effective high-risk gate',
      type: 'chore',
      priority: 'low',
      background,
      checklist: [{ title: 'Record effective priority wording', context: 'CLI output should explain low hotfix elevation' }],
    });
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stdout, /Auto-elevated priority|Original priority=low/);
    assert.match(result.stderr, /Auto-elevated priority: low → high/);
    assert.match(result.stderr, /Original priority=low/);
    const [storyId] = new StoryStore(root).listStoryIds();
    assert.ok(storyId);
    const story = new StoryStore(root).readStory(storyId);
    assert.equal(story.priority, 'high');
    assert.ok((story.riskSignals || []).some(sig => sig.matched.toLowerCase() === 'hotfix'));

    const localizedResult = await runKoalaRaw(root, 'story_create', {
      name: 'localized-risk-surface',
      title: '\u751f\u4ea7\u4e8b\u6545\u7d27\u6025\u4fee\u590d',
      description: '\u751f\u4ea7\u4e8b\u6545\u9700\u8981\u7d27\u6025\u4fee\u590d\uff0c\u6d89\u53ca\u5bc6\u7801\u548c\u9274\u6743\u98ce\u9669',
      type: 'chore',
      priority: 'low',
      background: [
        '## Trigger Event',
        '2026-06-03 B-localized-risk user wrote a localized production incident and credential-risk request; it should be treated the same as the English hotfix path.',
        '',
        '## Key Insights',
        'Risk auto-detection is behavior, not wording-only documentation; localized security and emergency terms must still trigger the high-risk gate.',
        '',
        '## Solution Tradeoffs',
        'Keep localized matching scoped to high-signal risk terms so ordinary prose does not auto-elevate.',
        '',
        '## Conversational Texture',
        'The user asked whether translations match real outcomes; this locks the real CLI behavior.',
      ].join('\n'),
      checklist: [{ title: 'Record localized risk detection', context: 'CLI output should elevate localized emergency/security wording' }],
    });
    assert.equal(localizedResult.code, 0);
    assert.doesNotMatch(localizedResult.stdout, /Auto-elevated priority|Original priority=low/);
    assert.match(localizedResult.stderr, /Auto-elevated priority: low → high/);
    const localizedStore = new StoryStore(root);
    const localizedStoryId = localizedStore.listStoryIds().find(id => localizedStore.readStory(id).name === 'localized-risk-surface');
    assert.ok(localizedStoryId);
    const localizedStory = localizedStore.readStory(localizedStoryId);
    assert.equal(localizedStory.priority, 'high');
    const localizedCategories = new Set((localizedStory.riskSignals || []).map(sig => sig.category));
    assert.ok(localizedCategories.has('Production/Emergency'));
    assert.ok(localizedCategories.has('Security/Credentials'));

    const localizedRiskCases = [
      {
        name: 'localized-data-migration-risk',
        title: '\u6570\u636e\u8fc1\u79fb\u7834\u574f\u6027\u53d8\u66f4',
        description: '\u6570\u636e\u5e93\u8fc1\u79fb\u9700\u8981\u8c03\u6574\u8868\u7ed3\u6784\u5e76\u9632\u6b62\u5220\u8868\u98ce\u9669',
        category: 'Data Migration/Destructive',
        backgroundSuffix: 'B-lr01',
      },
      {
        name: 'localized-state-machine-risk',
        title: '\u72b6\u6001\u673a\u95e8\u7981\u4fee\u6539',
        description: '\u9636\u6bb5\u6d41\u8f6c\u548c\u5b88\u536b\u903b\u8f91\u9700\u8981\u8c03\u6574',
        category: 'State Machine/Gate',
        backgroundSuffix: 'B-lr02',
      },
      {
        name: 'localized-validation-framework-risk',
        title: '\u9a8c\u8bc1\u6846\u67b6\u56de\u5f52',
        description: '\u9a8c\u8bc1\u534f\u8bae\u548c\u6d4b\u8bd5\u8fd0\u884c\u5668\u9700\u8981\u66f4\u65b0',
        category: 'Validation Framework',
        backgroundSuffix: 'B-lr03',
      },
      {
        name: 'localized-git-destructive-risk',
        title: 'git \u5f3a\u63a8\u9632\u62a4',
        description: 'git \u5f3a\u63a8\u548c\u91cd\u7f6e\u64cd\u4f5c\u9700\u8981\u9ad8\u98ce\u9669\u5ba1\u67e5',
        category: 'git Destructive Operation',
        backgroundSuffix: 'B-lr04',
      },
      {
        name: 'localized-compliance-risk',
        title: '\u9690\u79c1\u5408\u89c4\u4fee\u590d',
        description: '\u654f\u611f\u4fe1\u606f\u548c\u7528\u6237\u6570\u636e\u5904\u7406\u9700\u8981\u5408\u89c4\u5ba1\u67e5',
        category: 'Compliance/Privacy',
        backgroundSuffix: 'B-lr05',
      },
      {
        name: 'localized-breaking-api-risk',
        title: '\u516c\u5171 API \u7834\u574f\u6027\u53d8\u66f4',
        description: '\u516c\u5171 API \u4e0d\u517c\u5bb9\u53d8\u66f4\u9700\u8981\u9ad8\u98ce\u9669\u8def\u5f84',
        category: 'Breaking API Change',
        backgroundSuffix: 'B-lr06',
      },
    ];

    for (const riskCase of localizedRiskCases) {
      const riskResult = await runKoalaRaw(root, 'story_create', {
        name: riskCase.name,
        title: riskCase.title,
        description: riskCase.description,
        type: 'chore',
        priority: 'low',
        background: [
          '## Trigger Event',
          `2026-06-03 ${riskCase.backgroundSuffix} user wrote a localized high-risk request; it should be treated the same as the matching English risk category.`,
          '',
          '## Key Insights',
          'Localized wording must map to the same effective high-risk behavior and persisted riskSignals category.',
          '',
          '## Solution Tradeoffs',
          'Keep each localized case scoped to one category so this regression catches category drift.',
          '',
          '## Conversational Texture',
          'The user asked whether translation wording and real outcomes stay aligned.',
        ].join('\n'),
        checklist: [{ title: `Record ${riskCase.category} localized detection`, context: 'CLI output should elevate localized high-risk wording' }],
      });
      assert.equal(riskResult.code, 0, `${riskCase.name} should create successfully`);
      assert.doesNotMatch(riskResult.stdout, /Auto-elevated priority|Original priority=low/, `${riskCase.name} should keep advisory off stdout`);
      assert.match(riskResult.stderr, /Auto-elevated priority: low → high/, `${riskCase.name} should show auto-elevation on stderr`);
      const riskStoryId = localizedStore.listStoryIds().find(id => localizedStore.readStory(id).name === riskCase.name);
      assert.ok(riskStoryId, `${riskCase.name} should persist a story`);
      const riskStory = localizedStore.readStory(riskStoryId);
      assert.equal(riskStory.priority, 'high', `${riskCase.name} should persist elevated priority`);
      assert.ok((riskStory.riskSignals || []).some(sig => sig.category === riskCase.category), `${riskCase.name} should persist ${riskCase.category}`);
    }
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

    assert.match(output, /Cleaned untracked copy in main repo: .*review-passes\.json/);
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
      warning.replace(/\d+h(?: \d+ min)?|\d+ min/, '999h'),
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
await assertReviewerListForceReviewerLaneContract();
await assertReviewPassConcurrentCliSurface();
await assertPassOnlyFindingConvertsToReviewPassCliSurface();
await assertDecisionSetAcceptsLocalizedExclusionRationale();
await assertChannelGateAcceptsSubagentResultCliSurface();
await assertEvidenceFreshAfterMetadataOnlyCliSurface();
await assertVerificationEvidenceKindAliasesCliSurface();
await assertHotfixPriorityElevationCliSurface();
await assertDoneMergeCleansMainUntrackedReviewPasses();
await assertStaleWarningCooldownCliSurface();

console.log('✓ field regression CLI smoke passed');
