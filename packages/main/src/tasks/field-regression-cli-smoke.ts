#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { digestCanonical } from '../core/authority-contracts.js';
import { currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, DeliveryCheckData, StoryInfo, StorySummaryData, TestEvidenceData } from '../core/types.js';
import { getRuntimeActivityLogPath } from '../core/activity-log.js';
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
import { createFindingHandlers } from '../handlers/finding.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');

const placeholderRollbackRef = {
  headHash: '0'.repeat(40),
  diffHash: '1'.repeat(64),
  materialHash: '2'.repeat(64),
};

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

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function commit(cwd: string, message: string, author = 'Proofbound Smoke'): string {
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

function allowEmptyCommit(cwd: string, message: string, author = 'lattice-implementer'): string {
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

function reviewLoopRollbackRef(root: string): { headHash: string; diffHash: string; materialHash: string } {
  const materialHash = currentMaterialHash(root);
  assert.ok(materialHash, 'review loop smoke requires a computable materialHash');
  return {
    headHash: git(root, ['rev-parse', 'HEAD']),
    diffHash: digestCanonical({ diff: git(root, ['diff', '--binary', 'HEAD']) }),
    materialHash,
  };
}

function initRepo(prefix: string, storyDir = '.lattice/story/actives'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Proofbound Smoke']);
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir,
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
    workflow: { profile: 'balanced' },
  }, null, 2));
  write(root, '.gitignore', [
    '.worktrees/',
    '.lattice/*',
    '!.lattice/story/',
    '!.lattice/story/**',
    '',
  ].join('\n'));
  write(root, 'README.md', 'field regression CLI smoke\n');
  write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
  commit(root, 'base');
  resetConfigCache();
  return root;
}

function initProjectWithoutGit(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
    workflow: { profile: 'balanced' },
  }, null, 2));
  write(root, 'README.md', 'field regression CLI smoke without git\n');
  write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
  resetConfigCache();
  return root;
}

function addImmediateChildGitRepo(root: string, name: string): string {
  const gitRoot = join(root, name);
  mkdirSync(gitRoot, { recursive: true });
  git(gitRoot, ['init']);
  git(gitRoot, ['checkout', '-B', 'main']);
  git(gitRoot, ['config', 'user.email', 'smoke@example.test']);
  git(gitRoot, ['config', 'user.name', 'Proofbound Smoke']);
  write(gitRoot, 'README.md', `${name} nested git material root\n`);
  write(gitRoot, 'packages/main/src/base.ts', `export const ${name.replace(/[^a-zA-Z0-9_$]/g, '_')} = true;\n`);
  commit(gitRoot, `${name} nested git material base`);
  resetConfigCache();
  return gitRoot;
}

function initWrapperProjectWithNestedGitRepo(
  prefix: string,
  configGitRoot?: string,
  configFilename = 'lattice.config.json',
): { root: string; gitRoot: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  write(root, configFilename, JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
    workflow: { profile: 'balanced' },
    ...(configGitRoot ? { gitRoot: configGitRoot } : {}),
  }, null, 2));
  write(root, 'README.md', 'wrapper metadata root without git\n');
  const gitRoot = addImmediateChildGitRepo(root, 'clawcreek');
  resetConfigCache();
  return { root, gitRoot };
}

function initRepoWithoutCommit(prefix: string): string {
  const root = initProjectWithoutGit(prefix);
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Proofbound Smoke']);
  resetConfigCache();
  return root;
}

function initRepoWithMetadataOnlyHead(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Proofbound Smoke']);
  git(root, [
    '-c', 'user.name=Proofbound Smoke',
    '-c', 'user.email=smoke@example.test',
    '-c', 'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-m', 'empty material base',
  ]);
  resetConfigCache();
  return root;
}

function runLatticeRaw(
  cwd: string,
  command: string,
  args: Record<string, unknown> = {},
  envOverrides: Record<string, string | undefined> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, command, JSON.stringify(args)], {
      cwd,
      env: { ...process.env, LATTICE_PROJECT_ROOT: cwd, ...envOverrides },
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

function runLatticeArgsRaw(
  cwd: string,
  args: string[],
  envOverrides: Record<string, string | undefined> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, LATTICE_PROJECT_ROOT: cwd, ...envOverrides },
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

async function runLattice(cwd: string, command: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await runLatticeRaw(cwd, command, args);
  if (result.code !== 0) {
    throw new Error(`${command} exited ${result.code}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return result.stdout;
}

async function runLatticeJson<T>(cwd: string, command: string, args: Record<string, unknown> = {}): Promise<T> {
  return JSON.parse(await runLattice(cwd, command, { ...args, json: true })) as T;
}

function extractReviewRunId(output: string): string {
  const match = output.match(/B-[^:\s]+:RR-\d+/);
  assert.ok(match?.[0], `expected review_run_start output to include a review run id, got: ${output}`);
  return match![0];
}

async function startReviewRunWithOutput(
  cwd: string,
  storyId: string,
  agent: string,
  extra: Record<string, unknown> = {},
): Promise<{ reviewRunId: string; output: string }> {
  const output = await runLattice(cwd, 'review_run_start', {
    storyId,
    agent,
    ...extra,
  });
  return { reviewRunId: extractReviewRunId(output), output };
}

async function startReviewRun(cwd: string, storyId: string, agent: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await startReviewRunWithOutput(cwd, storyId, agent, extra)).reviewRunId;
}

const localAuthorityCompletionFieldPattern = /\b(?:authorityDone|fullAuthorityDone|receiptVerified|productionDone)\b/;

function assertNoAuthorityCompletionClaims(label: string, value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.doesNotMatch(text, localAuthorityCompletionFieldPattern, `${label} must not claim Authority-backed completion`);
}

function assertLocalReviewEvidenceDoesNotClaimAuthority(root: string, storyId: string, outputs: string[]): void {
  const store = new StoryStore(root);
  assert.equal(store.readLegacyReceiptRefs(storyId), null, 'local review_run_start/review_pass_set must not persist legacy receipt refs');
  assert.equal(
    existsSync(store.storyFilePath(storyId, 'authority-receipt-refs.json')),
    false,
    'local review_run_start/review_pass_set must not create authority-receipt-refs.json',
  );
  outputs.forEach((output, index) => assertNoAuthorityCompletionClaims(`local review CLI output ${index + 1}`, output));
  for (const artifact of ['review-runs.json', 'review-passes.json']) {
    const path = store.storyFilePath(storyId, artifact);
    if (existsSync(path)) assertNoAuthorityCompletionClaims(`local review artifact ${artifact}`, readFileSync(path, 'utf-8'));
  }
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

function writeLegacyReviewStoryWithoutRound(store: StoryStore, storyId: string): void {
  const timestamp = now();
  store.writeStory(storyId, {
    storyId,
    name: `${storyId.toLowerCase()}-legacy-review`,
    title: `${storyId} legacy review`,
    description: 'Synthetic legacy REVIEW story without currentReviewRound.',
    type: 'chore',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: timestamp,
    startedAt: timestamp,
    endedAt: null,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp }],
  });
  store.writeChecklist(storyId, { items: [] });
}

async function assertPlanRemoveIsHardBlocked(): Promise<void> {
  const root = initRepo('lattice-field-plan-freeze-');
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

    const failed = await runLatticeRaw(root, 'checklist_remove', {
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
  const root = initRepo('lattice-field-cluster-sync-');
  try {
    const storyId = 'B-clsync';
    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, 'packages/main/src/clustered.ts', 'export const clustered = true;\n');
    commit(root, 'implement cluster fix\n\nResolves: CL-001 CL-002', 'lattice-implementer');

    const store = new StoryStore(root);
    writeReviewStory(store, storyId);
    store.writeFindings(storyId, {
      findings: [{
        id: `${storyId}:F-001`,
        desc: 'clustered finding',
        severity: 'high',
        category: 'happy',
        status: 'open',
        agent: 'lattice-review-quality',
        createdAt: now(),
        reviewRound: now(),
      }, {
        id: `${storyId}:F-002`,
        desc: 'second clustered finding',
        severity: 'medium',
        category: 'edge',
        status: 'open',
        agent: 'lattice-review-concept',
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

    const output = await runLattice(root, 'finding_list', { storyId });
    assert.match(output, /"id":\s*"B-clsync:F-001"[\s\S]*"status":\s*"resolved"/);
    assert.match(output, /"resolvedBy":\s*"CL-001@/);
    assert.match(output, /"id":\s*"B-clsync:F-002"[\s\S]*"status":\s*"resolved"/);
    assert.match(output, /"resolvedBy":\s*"CL-002@/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDirectFindingAutoResolveCliSurface(): Promise<void> {
  const root = initRepo('lattice-field-finding-sync-');
  try {
    const storyId = 'B-fsync';
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const store = new StoryStore(root);
    writeReviewStory(store, storyId);

    const qualityRunId = await startReviewRun(root, storyId, 'lattice-review-quality');
    await runLattice(root, 'finding_add', {
      storyId,
      desc: 'direct finding should resolve from commit tag',
      severity: 'high',
      category: 'happy',
      agent: 'lattice-review-quality',
      reviewRunId: qualityRunId,
    });
    allowEmptyCommit(root, `resolve direct finding\n\nResolves: ${storyId}:F-001`);

    const output = await runLattice(root, 'finding_list', { storyId });
    assert.match(output, /"status":\s*"resolved"/);
    assert.match(output, /"resolvedBy":\s*"B-fsync:F-001@/);

    const conceptRunId = await startReviewRun(root, storyId, 'lattice-review-concept');
    await runLattice(root, 'finding_add', {
      storyId,
      desc: 'validate entry should also resolve direct finding',
      severity: 'medium',
      category: 'edge',
      agent: 'lattice-review-concept',
      reviewRunId: conceptRunId,
    });
    allowEmptyCommit(root, 'resolve short direct finding\n\nResolves: F-002');
    const validateOutput = await runLattice(root, 'validate', { story: storyId, json: true });
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

async function assertDirectReviewStoryCreateInitializesReviewMetadata(): Promise<void> {
  const root = initRepo('lattice-field-direct-review-create-');
  try {
    const store = new StoryStore(root);
    const directCreated = await runLattice(root, 'story_create', {
      name: 'direct-review-round',
      title: 'Direct review round',
      description: 'Synthetic direct REVIEW creation should initialize review metadata.',
      type: 'chore',
      priority: 'medium',
      phase: 'REVIEW',
      background: [
        '## Trigger Event',
        '2026-06-12 B-direct-review-round reproduces a direct phase REVIEW story that previously lacked currentReviewRound and blocked reviewer commands.',
        '',
        '## Key Insights',
        'The direct create path must persist the same review round metadata expected by review_run_start and review_loop_start.',
        '',
        '## Solution Tradeoffs',
        'Initialize only the REVIEW direct phase instead of changing other onboarding/backfill phases.',
        '',
        '## Conversational Texture',
        'The operator expects a review-only docs pass to start immediately after creating the story in REVIEW.',
      ].join('\n'),
      checklist: [{ title: 'Start review commands after direct creation', context: 'Covers review-only usage' }],
    });
    const directStoryId = directCreated.match(/B-[a-f0-9]+/)?.[0];
    assert.ok(directStoryId, `expected direct story id in output: ${directCreated}`);
    const directStory = store.readStory(directStoryId);
    assert.equal(directStory.phase, 'REVIEW');
    assertIsoReviewRound(directStory.currentReviewRound, directStory.createdAt, 'direct REVIEW story_create currentReviewRound');

    const directRun = await runLattice(root, 'review_run_start', {
      storyId: directStoryId,
      agent: 'lattice-review-quality',
      prompt: 'direct REVIEW creation smoke',
    });
    assert.match(directRun, /Review run .* started/);

    const directLoop = await runLattice(root, 'review_loop_start', {
      storyId: directStoryId,
      trigger: { findingIds: [`${directStoryId}:F-001`] },
      rollbackRef: reviewLoopRollbackRef(root),
    });
    assert.match(directLoop, /Review loop .* started/);

    const emptyTriggerLoop = await runLatticeRaw(root, 'review_loop_start', {
      storyId: directStoryId,
      trigger: { findingIds: [] },
      rollbackRef: reviewLoopRollbackRef(root),
    });
    assert.notEqual(emptyTriggerLoop.code, 0);
    assert.match(
      emptyTriggerLoop.stdout + emptyTriggerLoop.stderr,
      /trigger|findingId|bugId|validationFailureRef|scopeViolationRef/,
      'review_loop_start must reject empty trigger refs at parameter validation',
    );

    const placeholderLoop = await runLatticeRaw(root, 'review_loop_start', {
      storyId: directStoryId,
      trigger: { findingIds: [`${directStoryId}:F-002`] },
      rollbackRef: placeholderRollbackRef,
    });
    assert.notEqual(placeholderLoop.code, 0);
    assert.match(
      placeholderLoop.stdout + placeholderLoop.stderr,
      /rollbackRef|headHash|diffHash|materialHash|placeholder/,
      'review_loop_start must reject placeholder rollbackRef hashes',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertReviewRunStartCliSurface(): Promise<void> {
  const root = initRepo('lattice-field-review-run-');
  try {
    const storyId = 'B-runcli';
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const store = new StoryStore(root);
    writeReviewStory(store, storyId);

    const output = await runLattice(root, 'review_run_start', {
      storyId,
      agent: 'lattice-review-quality',
      prompt: 'Inspect current diff for REVIEW blockers.',
    });
    assert.match(output, /Review run B-runcli:RR-001 started for lattice-review-quality/);
    const runs = store.readReviewRuns(storyId).runs;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].lane, 'lattice-review-quality');
    assert.equal(runs[0].agent, 'lattice-review-quality');
    assert.equal(runs[0].storyId, storyId);
    assert.ok(runs[0].headHash);
    assert.ok(runs[0].materialHash);
    assert.ok(runs[0].storyFilesHash, 'review_run_start should persist top-level storyFilesHash');
    assert.equal(runs[0].storyFilesHash, currentStoryFilesHash(root));
    assert.equal(runs[0].workspaceBinding?.storyFilesHash, runs[0].storyFilesHash);
    assert.ok(runs[0].promptHash);

    write(root, 'packages/main/src/review-run-fresh.ts', 'export const reviewRunFresh = true;\n');
    commit(root, 'change after review run', 'lattice-implementer');
    const stalePass = await runLatticeRaw(root, 'review_pass_set', {
      storyId,
      agent: 'lattice-review-quality',
      reviewRunId: runs[0].reviewRunId,
      note: 'stale run should be rejected after material change.',
    });
    assert.notEqual(stalePass.code, 0);
    assert.match(stalePass.stderr, /already stale|stale/i);
    assert.match(stalePass.stderr, /DEV.*REVIEW|DEV → REVIEW/);
    assert.doesNotMatch(stalePass.stderr, /re-run lattice review_run_start/);

    const unsupported = await runLatticeRaw(root, 'review_run_start', {
      storyId,
      lane: 'lattice-review-delivery',
    });
    assert.notEqual(unsupported.code, 0);
    assert.match(unsupported.stderr, /Invalid enum value|Invalid option: expected one of|not in supported REVIEW reviewer lane/);

    const mainStoryId = 'B-main';
    writeLegacyReviewStoryWithoutRound(store, mainStoryId);
    git(root, ['checkout', '-b', `story/${mainStoryId}`]);
    const missingRound = await runLatticeRaw(root, 'review_run_start', {
      storyId: mainStoryId,
      agent: 'lattice-review-quality',
    });
    assert.equal(missingRound.code, 0);
    assert.match(missingRound.stdout + missingRound.stderr, /Review run B-main:RR-001 started/);
    const repairedStory = store.readStory(mainStoryId);
    assert.equal(repairedStory.currentReviewRound, now(), 'legacy REVIEW story missing currentReviewRound should be repaired to createdAt for compatibility');

    const repairedLoop = await runLatticeRaw(root, 'review_loop_start', {
      storyId: mainStoryId,
      trigger: { findingIds: [`${mainStoryId}:F-001`] },
      rollbackRef: reviewLoopRollbackRef(root),
    });
    assert.equal(repairedLoop.code, 0);
    assert.match(repairedLoop.stdout + repairedLoop.stderr, /Review loop .* started/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertReviewRunStoryFilesHashAcceptsUnrelatedMainDrift(): Promise<void> {
  const root = initRepo('lattice-field-review-run-storyhash-');
  try {
    const storyId = 'B-storyhash';
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const store = new StoryStore(root);
    writeReviewStory(store, storyId);
    write(root, 'packages/main/src/story-owned-review.ts', 'export const storyOwnedReview = true;\n');
    commit(root, 'story owned review change', 'lattice-implementer');

    const reviewRunId = await startReviewRun(root, storyId, 'lattice-review-quality');
    const runs = store.readReviewRuns(storyId).runs;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].reviewRunId, reviewRunId);
    assert.ok(runs[0].storyFilesHash, 'story branch review run must persist storyFilesHash');
    assert.equal(runs[0].storyFilesHash, runs[0].workspaceBinding?.storyFilesHash);
    const originalStoryFilesHash = runs[0].storyFilesHash;
    commit(root, 'record review run story hash', 'lattice-review-quality');

    git(root, ['checkout', 'main']);
    write(root, 'packages/main/src/unrelated-main-drift.ts', 'export const unrelatedMainDrift = true;\n');
    commit(root, 'main unrelated material drift', 'lattice-implementer');

    git(root, ['checkout', `story/${storyId}`]);
    git(root, ['merge', '--no-edit', 'main']);
    assert.equal(currentStoryFilesHash(root), originalStoryFilesHash);
    assert.notEqual(currentMaterialHash(root), runs[0].materialHash, 'main merge should still change whole-tree materialHash');

    const pass = await runLatticeRaw(root, 'review_pass_set', {
      storyId,
      agent: 'lattice-review-quality',
      reviewRunId,
      note: 'quality review pass remains valid after unrelated main drift because storyFilesHash matches.',
    });
    assert.equal(pass.code, 0, pass.stderr);
    assert.match(pass.stderr, /whole-tree materialHash drift|storyFilesHash matches|re-attestation/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertReviewRunStartWorkspaceDiagnostics(): Promise<void> {
  const nonGitRoot = initProjectWithoutGit('lattice-field-review-run-nongit-');
  try {
    const storyId = 'B-nongit';
    const store = new StoryStore(nonGitRoot);
    writeLegacyReviewStoryWithoutRound(store, storyId);
    const failed = await runLatticeRaw(nonGitRoot, 'review_run_start', {
      storyId,
      agent: 'lattice-review-quality',
    });
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /cannot resolve a git-backed signed workspace/);
    assert.match(failed.stderr, /signedWorkspaceRoot: unresolved/);
    assert.match(failed.stderr, /No reviewer run was created/);
    assert.equal(store.readStory(storyId).currentReviewRound, undefined, 'non-git failure must not repair legacy currentReviewRound');
    assert.equal(store.readReviewRuns(storyId).runs.length, 0, 'non-git failure must not write reviewer runs');
  } finally {
    rmSync(nonGitRoot, { recursive: true, force: true });
  }

  const unbornRoot = initRepoWithoutCommit('lattice-field-review-run-unborn-');
  try {
    const storyId = 'B-unborn';
    const store = new StoryStore(unbornRoot);
    writeLegacyReviewStoryWithoutRound(store, storyId);
    const failed = await runLatticeRaw(unbornRoot, 'review_run_start', {
      storyId,
      agent: 'lattice-review-quality',
    });
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /git working tree has uncommitted/);
    assert.match(failed.stderr, /material_source_changes/);
    assert.doesNotMatch(failed.stderr, /missing_head/, 'dirty preflight must run before snapshot missing_head diagnostics');
    assert.equal(store.readStory(storyId).currentReviewRound, undefined, 'unborn dirty preflight failure must not repair legacy currentReviewRound');
    assert.equal(store.readReviewRuns(storyId).runs.length, 0, 'unborn dirty preflight failure must not write reviewer runs');
  } finally {
    rmSync(unbornRoot, { recursive: true, force: true });
  }

  const missingMaterialRoot = initRepoWithMetadataOnlyHead('lattice-field-review-run-no-material-');
  try {
    const storyId = 'B-nomat';
    const store = new StoryStore(missingMaterialRoot);
    writeLegacyReviewStoryWithoutRound(store, storyId);
    const failed = await runLatticeRaw(missingMaterialRoot, 'review_run_start', {
      storyId,
      agent: 'lattice-review-quality',
    });
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /missing_material_hash/);
    assert.match(failed.stderr, /No reviewer run was created/);
    assert.equal(store.readStory(storyId).currentReviewRound, undefined, 'missing materialHash failure must not repair legacy currentReviewRound');
    assert.equal(store.readReviewRuns(storyId).runs.length, 0, 'missing materialHash failure must not write reviewer runs');
  } finally {
    rmSync(missingMaterialRoot, { recursive: true, force: true });
  }

  const worktreeRoot = initRepo('lattice-field-review-run-worktree-');
  try {
    const storyId = 'B-wt';
    const worktree = join(worktreeRoot, '.worktrees', storyId);
    git(worktreeRoot, ['worktree', 'add', '-b', `story/${storyId}`, worktree]);
    const store = new StoryStore(worktreeRoot);
    const timestamp = now();
    store.writeStory(storyId, {
      storyId,
      name: 'review-run-worktree-cli',
      title: 'review run worktree cli',
      description: 'Synthetic REVIEW story with linked worktree.',
      type: 'chore',
      phase: 'REVIEW',
      priority: 'medium',
      createdAt: timestamp,
      startedAt: timestamp,
      endedAt: null,
      worktree: {
        path: `.worktrees/${storyId}`,
        branch: `story/${storyId}`,
        createdAt: timestamp,
      },
      events: [{ phase: 'REVIEW', action: 'advance', timestamp }],
    });
    store.writeChecklist(storyId, { items: [] });

    const wrongCwd = await runLatticeRaw(worktreeRoot, 'review_run_start', {
      storyId,
      agent: 'lattice-review-quality',
    });
    assert.notEqual(wrongCwd.code, 0);
    assert.match(wrongCwd.stderr, /Expected cwd/);
    assert.match(wrongCwd.stderr, new RegExp(storyId));
    assert.equal(store.readReviewRuns(storyId).runs.length, 0, 'wrong cwd failure must not write reviewer runs');

    const branchTamperedStory = store.readStory(storyId);
    branchTamperedStory.worktree!.path = '.';
    store.writeStory(storyId, branchTamperedStory);
    const branchTamperedResolution = await runLatticeJson<{
      resolved: boolean;
      signedWorkspaceRoot: string | null;
      resolutionSource: string;
      unresolvedReason: string | null;
    }>(worktreeRoot, 'story_resolve', { storyId });
    assert.equal(branchTamperedResolution.resolved, true);
    assert.equal(branchTamperedResolution.signedWorkspaceRoot, canonicalPath(worktree));
    assert.equal(branchTamperedResolution.resolutionSource, 'linked-story-branch-worktree');
    assert.notEqual(branchTamperedResolution.signedWorkspaceRoot, canonicalPath(worktreeRoot), 'persisted story.worktree.path on main must not be used as signedWorkspaceRoot');
    const restoredStory = store.readStory(storyId);
    restoredStory.worktree!.path = `.worktrees/${storyId}`;
    store.writeStory(storyId, restoredStory);

    const splitRootRun = await runLatticeRaw(worktree, 'review_run_start', {
      storyId,
      agent: 'lattice-review-quality',
    }, { LATTICE_PROJECT_ROOT: worktreeRoot });
    assert.equal(splitRootRun.code, 0, splitRootRun.stderr);
    assert.match(splitRootRun.stdout + splitRootRun.stderr, /Review run B-wt:RR-001 started/);
    const run = store.readReviewRuns(storyId).runs[0];
    assert.equal(run.workspaceBinding?.metadataRoot, canonicalPath(worktreeRoot));
    assert.equal(run.workspaceBinding?.signedWorkspaceRoot, canonicalPath(worktree));
    assert.equal(run.workspaceBinding?.workspaceMode, 'story-worktree');
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
}

async function assertReviewRunStartSplitRootGitRootBinding(): Promise<void> {
  const unbound = initWrapperProjectWithNestedGitRepo('lattice-field-review-run-wrapper-unbound-');
  try {
    const storyId = 'B-wrapno';
    const store = new StoryStore(unbound.root);
    writeLegacyReviewStoryWithoutRound(store, storyId);
    const resolved = await runLatticeJson<{
      resolved: boolean;
      metadataRoot: string;
      signedWorkspaceRoot: string | null;
      authoritativeCwd: string | null;
      resolutionSource: string;
      unresolvedReason: string | null;
    }>(unbound.root, 'story_resolve', { storyId });
    assert.equal(resolved.resolved, false);
    assert.equal(resolved.metadataRoot, canonicalPath(unbound.root));
    assert.equal(resolved.signedWorkspaceRoot, null);
    assert.equal(resolved.authoritativeCwd, null);
    assert.equal(resolved.resolutionSource, 'unresolved');
    assert.match(resolved.unresolvedReason || '', /no_worktree_or_gitRoot|requires_git_signed_workspace/);

    const failed = await runLatticeRaw(unbound.root, 'review_run_start', {
      storyId,
      agent: 'lattice-review-quality',
    });
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /cannot resolve a git-backed signed workspace/);
    assert.match(failed.stderr, /signedWorkspaceRoot: unresolved/);
    assert.equal(store.readStory(storyId).currentReviewRound, undefined, 'unresolved wrapper root must not repair currentReviewRound');
    assert.equal(store.readReviewRuns(storyId).runs.length, 0, 'unresolved wrapper root must not create a review run');
  } finally {
    rmSync(unbound.root, { recursive: true, force: true });
  }

  const bound = initWrapperProjectWithNestedGitRepo('lattice-field-review-run-wrapper-bound-', 'clawcreek');
  try {
    const storyId = 'B-wrapok';
    const store = new StoryStore(bound.root);
    writeReviewStory(store, storyId);
    const resolved = await runLatticeJson<{
      resolved: boolean;
      metadataRoot: string;
      signedWorkspaceRoot: string | null;
      authoritativeCwd: string | null;
      resolutionSource: string;
    }>(bound.root, 'story_resolve', { storyId });
    assert.equal(resolved.resolved, true);
    assert.equal(resolved.metadataRoot, canonicalPath(bound.root));
    assert.equal(resolved.signedWorkspaceRoot, canonicalPath(bound.gitRoot));
    assert.equal(resolved.authoritativeCwd, canonicalPath(bound.gitRoot));
    assert.equal(resolved.resolutionSource, 'configured-git-root');

    const reviewRunId = await startReviewRun(bound.root, storyId, 'lattice-review-quality');
    const runs = store.readReviewRuns(storyId).runs;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].workspaceBinding?.metadataRoot, canonicalPath(bound.root));
    assert.equal(runs[0].workspaceBinding?.signedWorkspaceRoot, canonicalPath(bound.gitRoot));
    assert.equal(runs[0].workspaceBinding?.workspaceMode, 'configured-git-root');
    assert.equal(runs[0].workspaceBinding?.headHash, runs[0].headHash);
    assert.equal(runs[0].workspaceBinding?.materialHash, runs[0].materialHash);
    assert.ok(runs[0].workspaceBinding?.bindingHash);
    assert.equal(runs[0].headHash, git(bound.gitRoot, ['rev-parse', 'HEAD']));
    assert.equal(runs[0].materialHash, currentMaterialHash(bound.gitRoot));

    const pass = await runLatticeRaw(bound.root, 'review_pass_set', {
      storyId,
      agent: 'lattice-review-quality',
      reviewRunId,
      note: 'split-root review pass should validate against configured gitRoot.',
    });
    assert.equal(pass.code, 0, pass.stderr);

    const otherGitRoot = join(bound.root, 'othercreek');
    mkdirSync(otherGitRoot, { recursive: true });
    git(otherGitRoot, ['init']);
    git(otherGitRoot, ['checkout', '-B', 'main']);
    git(otherGitRoot, ['config', 'user.email', 'smoke@example.test']);
    git(otherGitRoot, ['config', 'user.name', 'Proofbound Smoke']);
    write(otherGitRoot, 'README.md', 'alternate git material root\n');
    write(otherGitRoot, 'packages/main/src/base.ts', 'export const alternate = true;\n');
    commit(otherGitRoot, 'alternate git material base');
    write(bound.root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      worktreeDir: '.worktrees',
      workflow: { profile: 'balanced' },
      gitRoot: 'othercreek',
    }, null, 2));
    const driftRejected = await runLatticeRaw(bound.root, 'review_pass_set', {
      storyId,
      agent: 'lattice-review-quality',
      reviewRunId,
      note: 'old split-root review pass must be rejected after gitRoot changes.',
    });
    assert.notEqual(driftRejected.code, 0);
    assert.match(driftRejected.stderr, /workspace binding|signed workspace resolution|stale/i);
    assert.match(driftRejected.stderr, /signedWorkspaceRoot|workspaceBinding/i);
    write(bound.root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      worktreeDir: '.worktrees',
      workflow: { profile: 'balanced' },
      gitRoot: 'clawcreek',
    }, null, 2));

    const tampered = store.readReviewRuns(storyId);
    tampered.runs[0].workspaceBinding!.signedWorkspaceRoot = bound.root;
    store.writeReviewRuns(storyId, tampered);
    const rejected = await runLatticeRaw(bound.root, 'review_pass_set', {
      storyId,
      agent: 'lattice-review-quality',
      reviewRunId,
      note: 'tampered workspace binding should be rejected before pass evidence.',
    });
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /workspace binding|workspaceBinding|invalid signature|tampered/i);
  } finally {
    rmSync(bound.root, { recursive: true, force: true });
  }
}

async function assertSessionBriefConfiguredGitRootWorkspaceStatus(): Promise<void> {
  const configured = initWrapperProjectWithNestedGitRepo('lattice-field-session-brief-wrapper-bound-', 'clawcreek');
  try {
    const configPath = join(configured.root, 'lattice.config.json');
    const beforeConfig = readFileSync(configPath, 'utf-8');
    const result = await runLatticeRaw(configured.root, 'session_brief');
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Signed workspace: OK/);
    assert.match(result.stdout, /configured gitRoot: clawcreek/);
    assert.match(result.stdout, /resolutionSource: configured-git-root/);
    assert.ok(
      result.stdout.includes(`signedWorkspaceRoot: ${canonicalPath(configured.gitRoot)}`),
      `configured wrapper root session_brief should show signed workspace path, got:\n${result.stdout}`,
    );
    assert.equal(readFileSync(configPath, 'utf-8'), beforeConfig, 'configured wrapper root session_brief must not mutate config');
  } finally {
    rmSync(configured.root, { recursive: true, force: true });
  }

  const unconfigured = initWrapperProjectWithNestedGitRepo('lattice-field-session-brief-wrapper-unbound-');
  try {
    const configPath = join(unconfigured.root, 'lattice.config.json');
    const beforeConfig = readFileSync(configPath, 'utf-8');
    const result = await runLatticeRaw(unconfigured.root, 'session_brief');
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Non-git project/);
    assert.doesNotMatch(result.stdout, /Signed workspace: OK/);
    assert.doesNotMatch(result.stdout, /resolutionSource: configured-git-root/);
    assert.equal(readFileSync(configPath, 'utf-8'), beforeConfig, 'unconfigured wrapper root session_brief must not mutate config');
    assert.equal(JSON.parse(readFileSync(configPath, 'utf-8')).gitRoot, undefined);
  } finally {
    rmSync(unconfigured.root, { recursive: true, force: true });
  }

  const missingGitRoot = initWrapperProjectWithNestedGitRepo(
    'lattice-field-session-brief-wrapper-missing-',
    'missing-creek',
  );
  try {
    const configPath = join(missingGitRoot.root, 'lattice.config.json');
    const beforeConfig = readFileSync(configPath, 'utf-8');
    const result = await runLatticeRaw(missingGitRoot.root, 'session_brief');
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Signed workspace: unresolved/);
    assert.match(result.stdout, /configured gitRoot: missing-creek/);
    assert.match(result.stdout, /configured_gitRoot_missing/);
    assert.doesNotMatch(result.stdout, /Signed workspace: OK/);
    assert.equal(readFileSync(configPath, 'utf-8'), beforeConfig, 'invalid configured gitRoot session_brief must not mutate config');
  } finally {
    rmSync(missingGitRoot.root, { recursive: true, force: true });
  }

  const gitBacked = initRepo('lattice-field-session-brief-git-backed-');
  try {
    const result = await runLatticeRaw(gitBacked, 'session_brief');
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /## Signed workspace/);
    assert.doesNotMatch(result.stdout, /configured gitRoot:/);
    assert.doesNotMatch(result.stdout, /resolutionSource: configured-git-root/);
  } finally {
    rmSync(gitBacked, { recursive: true, force: true });
  }
}

async function assertWrapperGitRootDoctorAndRepairCliSurface(): Promise<void> {
  type ConfigDoctor = {
    wrapperGitRoot: {
      metadataRootGitBacked: boolean;
      configuredGitRoot: string | null;
      status: string;
      candidates: string[];
      suggestedGitRoot: string | null;
      repairCommand: string | null;
      note: string;
    };
  };
  type ConfigRepair = {
    status: string;
    mutated: boolean;
    gitRoot: string;
    write: string;
    verification: string;
    gitRootVerified: boolean;
    confirmCommand?: string;
  };

  const noCandidatesRoot = initProjectWithoutGit('lattice-field-config-doctor-none-');
  try {
    const doctor = await runLatticeJson<ConfigDoctor>(noCandidatesRoot, 'lattice_config_doctor');
    assert.equal(doctor.wrapperGitRoot.metadataRootGitBacked, false);
    assert.equal(doctor.wrapperGitRoot.configuredGitRoot, null);
    assert.equal(doctor.wrapperGitRoot.status, 'none');
    assert.deepEqual(doctor.wrapperGitRoot.candidates, []);
    assert.equal(doctor.wrapperGitRoot.suggestedGitRoot, null);
    assert.equal(doctor.wrapperGitRoot.repairCommand, null);
  } finally {
    rmSync(noCandidatesRoot, { recursive: true, force: true });
  }

  const ambiguous = initWrapperProjectWithNestedGitRepo('lattice-field-config-doctor-ambiguous-');
  try {
    addImmediateChildGitRepo(ambiguous.root, 'othercreek');
    const doctor = await runLatticeJson<ConfigDoctor>(ambiguous.root, 'lattice_config_doctor');
    assert.equal(doctor.wrapperGitRoot.status, 'ambiguous');
    assert.deepEqual(doctor.wrapperGitRoot.candidates, ['clawcreek', 'othercreek']);
    assert.equal(doctor.wrapperGitRoot.suggestedGitRoot, null);
    assert.equal(doctor.wrapperGitRoot.repairCommand, null);
    assert.match(doctor.wrapperGitRoot.note, /ambiguous|no repair target is chosen/i);

    const storyId = 'B-wrapamb';
    const store = new StoryStore(ambiguous.root);
    writeLegacyReviewStoryWithoutRound(store, storyId);
    const resolved = await runLatticeJson<{
      resolved: boolean;
      resolutionSource: string;
      signedWorkspaceRoot: string | null;
      unresolvedReason: string | null;
    }>(ambiguous.root, 'story_resolve', { storyId });
    assert.equal(resolved.resolved, false);
    assert.equal(resolved.resolutionSource, 'unresolved');
    assert.equal(resolved.signedWorkspaceRoot, null);
    assert.match(resolved.unresolvedReason || '', /no_worktree_or_gitRoot|requires_git_signed_workspace/);
    const failed = await runLatticeRaw(ambiguous.root, 'review_run_start', {
      storyId,
      agent: 'lattice-review-quality',
    });
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /cannot resolve a git-backed signed workspace/);
    assert.equal(store.readReviewRuns(storyId).runs.length, 0, 'ambiguous wrapper root must not create a review run');
  } finally {
    rmSync(ambiguous.root, { recursive: true, force: true });
  }

  const repairable = initWrapperProjectWithNestedGitRepo(
    'lattice-field-config-repair-',
    undefined,
    'lattice.config.json',
  );
  try {
    const storyId = 'B-wrapfix';
    const store = new StoryStore(repairable.root);
    writeLegacyReviewStoryWithoutRound(store, storyId);

    const doctorAlias = await runLatticeArgsRaw(repairable.root, ['lattice', 'config', 'doctor', '--format=json']);
    assert.equal(doctorAlias.code, 0, doctorAlias.stderr);
    const doctor = JSON.parse(doctorAlias.stdout) as ConfigDoctor;
    assert.equal(doctor.wrapperGitRoot.status, 'single-candidate');
    assert.deepEqual(doctor.wrapperGitRoot.candidates, ['clawcreek']);
    assert.equal(doctor.wrapperGitRoot.suggestedGitRoot, 'clawcreek');
    assert.equal(
      doctor.wrapperGitRoot.repairCommand,
      'lattice config repair --set-git-root=clawcreek --confirm',
    );
    assert.match(doctor.wrapperGitRoot.note, /Operator suggestion only/i);

    const doctorText = await runLattice(repairable.root, 'lattice_config_doctor');
    assert.match(doctorText, /wrapperGitRoot:/);
    assert.match(doctorText, /status: single-candidate/);
    assert.match(doctorText, /suggestedGitRoot: clawcreek/);
    assert.match(doctorText, /repairCommand: lattice config repair --set-git-root=clawcreek --confirm/);

    const before = await runLatticeJson<{
      resolved: boolean;
      resolutionSource: string;
      signedWorkspaceRoot: string | null;
    }>(repairable.root, 'story_resolve', { storyId });
    assert.equal(before.resolved, false);
    assert.equal(before.resolutionSource, 'unresolved');
    assert.equal(before.signedWorkspaceRoot, null);
    const beforeRun = await runLatticeRaw(repairable.root, 'review_run_start', {
      storyId,
      agent: 'lattice-review-quality',
    });
    assert.notEqual(beforeRun.code, 0);
    assert.equal(store.readReviewRuns(storyId).runs.length, 0, 'unrepaired wrapper root must not create review runs');

    const preview = await runLatticeJson<ConfigRepair>(repairable.root, 'lattice_config_repair', {
      setGitRoot: 'clawcreek',
    });
    assert.equal(preview.status, 'preview');
    assert.equal(preview.mutated, false);
    assert.equal(preview.gitRoot, 'clawcreek');
    assert.equal(preview.write, 'preview-only');
    assert.equal(preview.verification, 'configured-git-root verified');
    assert.equal(preview.confirmCommand, 'lattice config repair --set-git-root=clawcreek --confirm');
    assert.equal(JSON.parse(readFileSync(join(repairable.root, 'lattice.config.json'), 'utf-8')).gitRoot, undefined);

    const unsafeOutside = await runLatticeRaw(repairable.root, 'lattice_config_repair', {
      setGitRoot: '../outside',
      confirm: true,
    });
    assert.notEqual(unsafeOutside.code, 0);
    assert.match(unsafeOutside.stderr, /must stay strictly under the metadata root|unsafe path/);
    assert.equal(JSON.parse(readFileSync(join(repairable.root, 'lattice.config.json'), 'utf-8')).gitRoot, undefined);

    const missingTarget = await runLatticeRaw(repairable.root, 'lattice_config_repair', {
      setGitRoot: 'missing-creek',
      confirm: true,
    });
    assert.notEqual(missingTarget.code, 0);
    assert.match(missingTarget.stderr, /target does not exist/);
    assert.equal(JSON.parse(readFileSync(join(repairable.root, 'lattice.config.json'), 'utf-8')).gitRoot, undefined);

    const nestedNonRoot = await runLatticeRaw(repairable.root, 'lattice_config_repair', {
      setGitRoot: 'clawcreek/packages',
      confirm: true,
    });
    assert.notEqual(nestedNonRoot.code, 0);
    assert.match(nestedNonRoot.stderr, /not a git repository root|git top-level/);
    assert.equal(JSON.parse(readFileSync(join(repairable.root, 'lattice.config.json'), 'utf-8')).gitRoot, undefined);

    const confirmedAlias = await runLatticeArgsRaw(repairable.root, [
      'lattice',
      'config',
      'repair',
      '--set-git-root=clawcreek',
      '--confirm',
      '--format=json',
    ]);
    assert.equal(confirmedAlias.code, 0, confirmedAlias.stderr);
    const confirmed = JSON.parse(confirmedAlias.stdout) as ConfigRepair;
    assert.equal(confirmed.status, 'repaired');
    assert.equal(confirmed.mutated, true);
    assert.equal(confirmed.gitRoot, 'clawcreek');
    assert.equal(confirmed.write, 'updated lattice.config.json');
    assert.equal(confirmed.verification, 'configured-git-root verified');
    assert.equal(confirmed.gitRootVerified, true);
    const repairedConfig = JSON.parse(readFileSync(join(repairable.root, 'lattice.config.json'), 'utf-8'));
    assert.equal(repairedConfig.gitRoot, 'clawcreek');
    assert.equal(repairedConfig.scanRoot, 'packages/main');
    assert.deepEqual(repairedConfig.workflow, { profile: 'balanced' });

    const after = await runLatticeJson<{
      resolved: boolean;
      metadataRoot: string;
      signedWorkspaceRoot: string | null;
      authoritativeCwd: string | null;
      resolutionSource: string;
    }>(repairable.root, 'story_resolve', { storyId });
    assert.equal(after.resolved, true);
    assert.equal(after.metadataRoot, canonicalPath(repairable.root));
    assert.equal(after.signedWorkspaceRoot, canonicalPath(repairable.gitRoot));
    assert.equal(after.authoritativeCwd, canonicalPath(repairable.gitRoot));
    assert.equal(after.resolutionSource, 'configured-git-root');

    const reviewRunId = await startReviewRun(repairable.root, storyId, 'lattice-review-quality');
    assert.match(reviewRunId, /^B-wrapfix:RR-001$/);
    const runs = store.readReviewRuns(storyId).runs;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].workspaceBinding?.metadataRoot, canonicalPath(repairable.root));
    assert.equal(runs[0].workspaceBinding?.signedWorkspaceRoot, canonicalPath(repairable.gitRoot));
    assert.equal(runs[0].workspaceBinding?.workspaceMode, 'configured-git-root');
    assert.equal(runs[0].headHash, git(repairable.gitRoot, ['rev-parse', 'HEAD']));
  } finally {
    rmSync(repairable.root, { recursive: true, force: true });
  }
}

async function assertReviewerListForceReviewerLaneContract(): Promise<void> {
  const root = initRepo('lattice-field-force-reviewer-');
  try {
    const storyId = 'B-force';
    const store = new StoryStore(root);
    writeReviewStory(store, storyId);

    const output = await runLattice(root, 'reviewer_list', {
      storyId,
      json: true,
      forceReviewer: 'lattice-review-docs, behavior, channel',
    });
    type ReviewerListEntry = { name: string; forced?: boolean };
    const parsed = JSON.parse(output) as { reviewers: ReviewerListEntry[] };
    const reviewers = new Map<string, ReviewerListEntry>(parsed.reviewers.map((entry) => [entry.name, entry]));
    assert.equal(reviewers.get('docs')?.forced, true, 'full built-in lane should normalize to a forced short reviewer name');
    assert.equal(reviewers.get('behavior')?.forced, true, 'built-in short reviewer name should remain supported');
    assert.equal(reviewers.get('channel')?.forced, true, 'retired compatibility lane should remain forceable while review_run_start supports it');
    assert.equal(reviewers.has('lattice-review-docs'), false, 'forced reviewer output should not mix full lane names into opt-in names');

    const invalid = await runLatticeRaw(root, 'reviewer_list', {
      storyId,
      json: true,
      forceReviewer: 'lattice-review-delivery',
    });
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.stderr, /not supported by review_run_start/);
    assert.match(invalid.stderr, /lattice-review-quality/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertReviewPassConcurrentCliSurface(): Promise<void> {
  const root = initRepo('lattice-field-review-pass-');
  try {
    const storyId = 'B-rpcli';
    const store = new StoryStore(root);
    writeReviewStory(store, storyId);
    const agents = ['concept', 'quality', 'test-coverage', 'docs', 'behavior']
      .map(name => `lattice-review-${name}`);
    const starts = new Map(await Promise.all(agents.map(async (agent) => [agent, await startReviewRunWithOutput(root, storyId, agent)] as const)));
    const outputs = await Promise.all(agents.map(agent => runLattice(root, 'review_pass_set', {
      storyId,
      agent,
      reviewRunId: starts.get(agent)?.reviewRunId,
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
    assertLocalReviewEvidenceDoesNotClaimAuthority(root, storyId, [
      ...Array.from(starts.values()).map(start => start.output),
      ...outputs,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertPassOnlyFindingConvertsToReviewPassCliSurface(): Promise<void> {
  const root = initRepo('lattice-field-pass-only-finding-');
  try {
    const storyId = 'B-passonly';
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const store = new StoryStore(root);
    writeReviewStory(store, storyId);
    const docsRunId = await startReviewRun(root, storyId, 'lattice-review-docs');
    const conceptRunId = await startReviewRun(root, storyId, 'lattice-review-concept');
    const channelRunId = await startReviewRun(root, storyId, 'lattice-review-channel');
    const qualityRunId = await startReviewRun(root, storyId, 'lattice-review-quality');
    const behaviorRunId = await startReviewRun(root, storyId, 'lattice-review-behavior');

    const passOutput = await runLattice(root, 'finding_add', {
      storyId,
      desc: 'Docs consistency check passed: Step 1 extracted 2 symbols, Step 2 compared 3 sections; consistency check PASSED.',
      severity: 'low',
      category: 'happy',
      agent: 'lattice-review-docs',
      reviewRunId: docsRunId,
    });
    assert.match(passOutput, /Review pass B-passonly:RP-001 recorded by lattice-review-docs/);
    assert.equal(store.readFindings(storyId).findings.length, 0, 'pass-only finding_add should not write findings.json');
    const passes = store.readReviewPasses(storyId).passes;
    assert.equal(passes.length, 1);
    assert.equal(passes[0].agent, 'lattice-review-docs');
    assert.match(passes[0].note, /Docs consistency check passed/);
    assertIsoReviewRound(passes[0].reviewRound, now(), 'pass-only converted review pass reviewRound');
    const emptyFindingList = await runLattice(root, 'finding_list', { storyId });
    assert.match(emptyFindingList, /"findings":\s*\[\]/, 'pass-only finding_add should not appear in finding_list');

    const noDriftOutput = await runLattice(root, 'finding_add', {
      storyId,
      desc: 'Docs consistency check passed: no inconsistencies found.',
      severity: 'low',
      category: 'happy',
      agent: 'lattice-review-docs',
      reviewRunId: docsRunId,
    });
    assert.match(noDriftOutput, /Review pass B-passonly:RP-002 recorded by lattice-review-docs/);
    assert.equal(store.readFindings(storyId).findings.length, 0, 'negated no-drift wording should remain a review pass');

    const conceptPassOutput = await runLattice(root, 'finding_add', {
      storyId,
      desc: 'No concept changes this round',
      severity: 'low',
      category: 'happy',
      agent: 'lattice-review-concept',
      reviewRunId: conceptRunId,
    });
    assert.match(conceptPassOutput, /Review pass B-passonly:RP-003 recorded by lattice-review-concept/);
    assert.equal(store.readFindings(storyId).findings.length, 0, 'concept pass-only finding_add should not write findings.json');

    const channelPassOutput = await runLattice(root, 'finding_add', {
      storyId,
      desc: 'Express channel (≤2 items, no riskSignals), main agent self-write compliant',
      severity: 'low',
      category: 'happy',
      agent: 'lattice-review-channel',
      reviewRunId: channelRunId,
    });
    assert.match(channelPassOutput, /Review pass B-passonly:RP-004 recorded by lattice-review-channel/);
    assert.equal(store.readFindings(storyId).findings.length, 0, 'channel pass-only finding_add should not write findings.json');

    const noFindingsOutput = await runLattice(root, 'finding_add', {
      storyId,
      desc: 'No findings after checking process facts.',
      severity: 'low',
      category: 'happy',
      agent: 'lattice-review-quality',
      reviewRunId: qualityRunId,
    });
    assert.match(noFindingsOutput, /Review pass B-passonly:RP-005 recorded by lattice-review-quality/);
    assert.equal(store.readFindings(storyId).findings.length, 0, 'no findings wording should convert to review pass');

    const genericPassOutput = await runLattice(root, 'finding_add', {
      storyId,
      desc: 'Check passed: all flow fact entry points have hardcoded fallback.',
      severity: 'low',
      category: 'happy',
      agent: 'lattice-review-behavior',
      reviewRunId: behaviorRunId,
    });
    assert.match(genericPassOutput, /Review pass B-passonly:RP-006 recorded by lattice-review-behavior/);
    assert.equal(store.readFindings(storyId).findings.length, 0, 'generic check-pass wording should convert to review pass');

    const explicitPassOutput = await runLattice(root, 'finding_add', {
      storyId,
      desc: 'PASS: schema and handler fallback are aligned.',
      severity: 'low',
      category: 'happy',
      agent: 'lattice-review-docs',
      reviewRunId: docsRunId,
    });
    assert.match(explicitPassOutput, /Review pass B-passonly:RP-007 recorded by lattice-review-docs/);
    assert.equal(store.readFindings(storyId).findings.length, 0, 'explicit PASS wording should convert to review pass');

    const localizedPassOutput = await runLattice(root, 'finding_add', {
      storyId,
      desc: '\u5ba1\u67e5\u901a\u8fc7\uff1a\u5df2\u68c0\u67e5\u8303\u56f4\uff0c\u65e0\u963b\u585e\u95ee\u9898\u3002',
      severity: 'low',
      category: 'happy',
      agent: 'lattice-review-docs',
      reviewRunId: docsRunId,
    });
    assert.match(localizedPassOutput, /Review pass B-passonly:RP-008 recorded by lattice-review-docs/);
    assert.equal(store.readFindings(storyId).findings.length, 0, 'localized pass-only finding_add should convert to review pass');

    const findingOutput = await runLattice(root, 'finding_add', {
      storyId,
      desc: 'Docs consistency check passed but README example command failed; docs need fixing.',
      severity: 'low',
      category: 'edge',
      agent: 'lattice-review-docs',
      reviewRunId: docsRunId,
    });
    assert.match(findingOutput, /Finding B-passonly:F-001 created by lattice-review-docs/);
    const findings = store.readFindings(storyId).findings;
    assert.equal(findings.length, 1);
    assert.equal(findings[0].status, 'open');

    const cleanupOutput = await runLattice(root, 'finding_add', {
      storyId,
      desc: 'concept-cleanup: concept X deletion incomplete, Y file still has 2 references.',
      severity: 'critical',
      category: 'cleanup',
      agent: 'lattice-review-concept',
      reviewRunId: conceptRunId,
    });
    assert.match(cleanupOutput, /Finding B-passonly:F-002 created by lattice-review-concept: \[critical\/missing\]/);
    const cleanupFindings = store.readFindings(storyId).findings;
    assert.equal(cleanupFindings.length, 2);
    assert.equal(cleanupFindings[1].category, 'missing');

    const docPromiseOutput = await runLattice(root, 'finding_add', {
      storyId,
      desc: 'doc-promise-undelivered: README promised lattice foo command but it does not exist in registry.',
      severity: 'critical',
      category: 'doc-promise-undelivered',
      agent: 'lattice-review-quality',
      reviewRunId: qualityRunId,
    });
    assert.match(docPromiseOutput, /Finding B-passonly:F-003 created by lattice-review-quality: \[critical\/missing\]/);
    const docPromiseFindings = store.readFindings(storyId).findings;
    assert.equal(docPromiseFindings.length, 3);
    assert.equal(docPromiseFindings[2].category, 'missing');

    const nonLowPassOutput = await runLattice(root, 'finding_add', {
      storyId,
      desc: 'PASS: docs consistency check PASSED with reviewer approval.',
      severity: 'medium',
      category: 'happy',
      agent: 'lattice-review-docs',
      reviewRunId: docsRunId,
    });
    assert.match(nonLowPassOutput, /Finding B-passonly:F-004 created by lattice-review-docs/);
    assert.equal(store.readFindings(storyId).findings.length, 4, 'non-low pass-like finding_add should remain a finding');

    const nonReviewerPassOutput = await runLattice(root, 'finding_add', {
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
        agent: 'lattice-review-quality',
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
        agent: 'lattice-review-quality',
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
  const root = initRepo('lattice-field-decision-localized-');
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

    const output = await runLattice(root, 'decision_set', {
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
  const root = initRepo('lattice-field-channel-');
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

    const output = await runLattice(root, 'validate', { story: storyId, channel: true, json: true });
    assert.match(output, /"status":\s*"pass"/);
    assert.match(output, /subagent_result/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertEvidenceFreshAfterMetadataOnlyCliSurface(): Promise<void> {
  const root = initRepo('lattice-field-evidence-', 'Docs/story/actives');
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

    const output = await runLattice(root, 'validate', { story: storyId, json: true });
    assert.match(output, /"allPass":\s*true/);
    assert.match(output, /"covered":\s*1/);
    assert.doesNotMatch(output, /"status":\s*"stale"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertVerificationEvidenceKindAliasesCliSurface(): Promise<void> {
  const root = initRepo('lattice-field-evidence-alias-');
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

    const cliOutput = await runLattice(root, 'verification_evidence_add', {
      storyId,
      itemId: 'CHK-001',
      intentRef: 'CHK-001:happy:0',
      kind: 'cli',
      result: 'pass',
      note: 'CLI alias should persist as manual transcript evidence',
    });
    assert.match(cliOutput, /manual_transcript, alias cli/);

    const batchOutput = await runLattice(root, 'verification_evidence_batch_add', {
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
  const root = initRepo('lattice-field-hotfix-priority-');
  try {
    const background = [
      '## Trigger Event',
      '2026-05-08 B-hotfix user reported hotfix fixes need to be recorded; even if the request is low priority, it should explicitly enter the high-risk review path to avoid emergency keywords being hidden by docs wording.',
      '',
      '## Key Insights',
      'What needs to be verified here is not the business function, but whether the CLI surface honestly explains that effective priority overrides the original priority, and lets the agent anticipate the preMortem gate.',
      '',
      '## Solution Tradeoffs',
      'Keep the hotfix auto-elevate behavior, since it protects production and emergency fix paths; this smoke only locks the output wording and persisted priority.',
      '',
      '## Conversational Texture',
      'The user previously observed that low priority hotfixes also require preMortem; this behavior is acceptable, but the documentation and command output must state it clearly.',
    ].join('\n');
    const result = await runLatticeRaw(root, 'story_create', {
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

    const localizedResult = await runLatticeRaw(root, 'story_create', {
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
    assert.equal(localizedResult.code, 1, localizedResult.stderr);
    assert.doesNotMatch(localizedResult.stdout, /Auto-elevated priority|Original priority=low/);
    assert.match(localizedResult.stderr, /english_artifact_cjk_authoring/);
    assert.match(localizedResult.stderr, /title:1: non-English \(CJK\) text/);
    assert.equal(new StoryStore(root).listStoryIds().length, 1, 'CJK authoring refusal must not persist a story');
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
      agent: 'lattice-review-quality',
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
    headHash: head,
    materialHash,
    reviewRound: timestamp,
    agentId: 'lattice-review-delivery',
    docsPromises,
    realMachineTests,
    closingSelfCheck,
    _hash: signDeliveryCheck(storyId, docsPromises, realMachineTests, closingSelfCheck, timestamp, materialHash),
  };
  store.writeDeliveryCheck(storyId, delivery);
}

async function assertDoneMergeCleansMainUntrackedReviewPasses(): Promise<void> {
  const root = initRepo('lattice-field-done-stray-');
  try {
    const storyId = 'B-done';
    git(root, ['branch', `story/${storyId}`]);
    const worktree = join(root, '.worktrees', storyId);
    git(root, ['worktree', 'add', worktree, `story/${storyId}`]);
    writeDoneReadyStory(worktree, storyId);
    commit(worktree, 'prepare done story', 'lattice-implementer');

    write(root, `.lattice/story/actives/${storyId}/review-passes.json`, '{"passes":[]}\n');
    const output = await runLattice(worktree, 'story_advance', { storyId, phase: 'DONE' });

    assert.match(output, /Cleaned untracked copy in main repo: .*review-passes\.json/);
    assert.match(output, /advanced to DONE/);
    assert.equal(git(root, ['status', '--porcelain', '--', `.lattice/story/actives/${storyId}/review-passes.json`]), '');
    assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '');
    assert.equal(existsSync(worktree), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertStaleWarningCooldownCliSurface(): Promise<void> {
  const root = initRepo('lattice-field-stale-warning-');
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

    const first = await runLatticeRaw(root, 'session_brief');
    assert.equal(first.code, 0);
    assert.match(first.stderr, /Proofbound stale state warnings/);
    const logPath = getRuntimeActivityLogPath(root);
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    assert.ok(Array.isArray(last.staleWarnings));
    last.staleWarnings = last.staleWarnings.map((warning: string) =>
      warning.replace(/\d+h(?: \d+ min)?|\d+ min/, '999h'),
    );
    lines[lines.length - 1] = JSON.stringify(last);
    writeFileSync(logPath, `${lines.join('\n')}\n`);
    const second = await runLatticeRaw(root, 'session_brief');
    assert.equal(second.code, 0);
    assert.doesNotMatch(second.stderr, /Proofbound stale state warnings/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await assertPlanRemoveIsHardBlocked();
await assertClusterAutoResolveCliSurface();
await assertDirectFindingAutoResolveCliSurface();
await assertDirectReviewStoryCreateInitializesReviewMetadata();
await assertReviewRunStartCliSurface();
await assertReviewRunStoryFilesHashAcceptsUnrelatedMainDrift();
await assertReviewRunStartWorkspaceDiagnostics();
await assertReviewRunStartSplitRootGitRootBinding();
await assertSessionBriefConfiguredGitRootWorkspaceStatus();
await assertWrapperGitRootDoctorAndRepairCliSurface();
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
