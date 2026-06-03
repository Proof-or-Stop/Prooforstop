#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { MAIN_TOOLS } from '../cli-engine.js';
import { resetConfigCache } from '../core/config.js';
import { getCommandLifecyclePolicy } from '../core/command-policy.js';
import type {
  DispatchCollection,
  DispatchListResult,
  DispatchMergePlanResult,
  DispatchPlanResult,
  DispatchReceiptDraft,
  DispatchReviewResult,
  DispatchRunResult,
  DispatchStatusResult,
  HostRuntimeList,
  HostRuntimeProbe,
} from '../core/lattice-dispatch.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { createMainRegistry } from '../registry.js';

const EXPECTED_COMMANDS = [
  'host_runtime_list',
  'host_runtime_probe',
  'dispatch_plan',
  'dispatch_prepare',
  'dispatch_run',
  'dispatch_collect',
  'dispatch_receipt_create',
  'dispatch_status',
  'dispatch_list',
  'dispatch_resume',
  'dispatch_cancel',
  'dispatch_review',
  'dispatch_merge_plan',
] as const;

function assertNoAuthorityOverclaim(value: unknown, label: string): void {
  const bad: string[] = [];
  const visit = (node: unknown, path: string): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (
        (key === 'authorityChanged' || key === 'receiptVerified' || key === 'productionDone')
        && child === true
      ) {
        bad.push(childPath);
      }
      visit(child, childPath);
    }
  };
  visit(value, '');
  assert.deepEqual(bad, [], `${label} must not overclaim authority/receipt/production state`);
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function writeConfig(root: string): void {
  writeFileSync(join(root, 'koala.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.koala/story/actives',
  }, null, 2));
}

function initRepo(root: string): void {
  mkdirSync(join(root, 'packages/main/src/core'), { recursive: true });
  writeFileSync(join(root, 'packages/main/src/core/base.ts'), 'export const base = "dispatch-smoke";\n');
  writeFileSync(join(root, 'README.md'), '# dispatch runtime smoke fixture\n');
  writeConfig(root);
  git(root, ['init']);
  git(root, ['config', 'user.email', 'koala@example.com']);
  git(root, ['config', 'user.name', 'Koala Smoke']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);
}

function seedStory(store: StoryStore, root: string): void {
  const now = '2026-06-03T00:00:00.000Z';
  const story: StoryInfo = {
    storyId: 'B-dispatch',
    name: 'dispatch-runtime-smoke',
    title: 'Dispatch runtime smoke story',
    description: 'Exercise deterministic dispatch runtime surfaces.',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: now, branch: 'story/B-dispatch' }],
    worktree: {
      path: join(root, '.worktrees', 'B-dispatch-owner'),
      branch: 'story/B-dispatch',
      createdAt: now,
    },
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Dispatch runtime bounded overflow',
      status: 'done',
      startTime: now,
      endTime: now,
    }],
  };
  store.writeStory('B-dispatch', story);
  store.writeChecklist('B-dispatch', checklist);
}

function createRegistry(root: string) {
  resetConfigCache();
  const store = new StoryStore(root);
  seedStory(store, root);
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages', 'main') };
  return createMainRegistry(ctx);
}

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(patch)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function findUnavailableRealHost(registry: ReturnType<typeof createMainRegistry>): HostRuntimeProbe {
  const tryProbe = (host: 'claude-code' | 'gemini' | 'codex') =>
    registry.get('host_runtime_probe')!({ host, json: true }) as HostRuntimeProbe;

  for (const host of ['claude-code', 'gemini', 'codex'] as const) {
    const probe = tryProbe(host);
    if (probe.status === 'unavailable') return probe;
  }

  return withEnv({
    PATH: '/usr/bin:/bin',
    KOALA_ACTIVITY_SOURCE: undefined,
    CODEX_SESSION_ID: undefined,
    CODEX_HOME: undefined,
  }, () => {
    for (const host of ['claude-code', 'gemini'] as const) {
      const probe = tryProbe(host);
      if (probe.status === 'unavailable') return probe;
    }
    throw new Error('Expected at least one real host runtime to degrade to unavailable under a narrowed PATH');
  });
}

function assertRegistered(registry: ReturnType<typeof createMainRegistry>): void {
  for (const command of EXPECTED_COMMANDS) {
    assert.ok(MAIN_TOOLS.some(tool => tool.name === command), `MAIN_TOOLS exposes ${command}`);
    assert.equal(registry.has(command), true, `registry exposes ${command}`);
  }
  assert.equal(getCommandLifecyclePolicy('dispatch_plan')?.ownershipClass, 'readOnly');
  assert.equal(getCommandLifecyclePolicy('dispatch_prepare')?.ownershipClass, 'storyScopedMutating');
  assert.equal(getCommandLifecyclePolicy('dispatch_run')?.ownershipClass, 'storyScopedMutating');
  assert.equal(getCommandLifecyclePolicy('dispatch_receipt_create')?.ownershipClass, 'storyScopedMutating');
  assert.equal(getCommandLifecyclePolicy('dispatch_merge_plan')?.ownershipClass, 'readOnly');
}

function assertRuntimeListAndProbe(registry: ReturnType<typeof createMainRegistry>): HostRuntimeProbe {
  const list = registry.get('host_runtime_list')!({ json: true }) as HostRuntimeList;
  assert.equal(list.schemaVersion, 'lattice.host_runtime_list.v1');
  assert.deepEqual(list.runtimes.map(runtime => runtime.host), ['fake', 'claude-code', 'gemini', 'codex']);
  assertNoAuthorityOverclaim(list, 'host_runtime_list');

  const fakeProbe = registry.get('host_runtime_probe')!({ host: 'fake', json: true }) as HostRuntimeProbe;
  assert.equal(fakeProbe.schemaVersion, 'lattice.host_runtime_probe.v1');
  assert.equal(fakeProbe.status, 'ready');
  assert.equal(fakeProbe.available, true);
  assert.equal(fakeProbe.supportsParallel, true);
  assert.equal(fakeProbe.runtimeKind, 'fake');
  assert.match(fakeProbe.nextAction, /dispatch_prepare\/dispatch_run/i);
  assertNoAuthorityOverclaim(fakeProbe, 'fake host_runtime_probe');

  const unavailableProbe = findUnavailableRealHost(registry);
  assert.equal(unavailableProbe.status, 'unavailable');
  assert.equal(unavailableProbe.available, false);
  assert.equal(unavailableProbe.runtimeKind, 'missing-cli');
  assert.match(unavailableProbe.nextAction, /Install|use host=fake/i);
  assertNoAuthorityOverclaim(unavailableProbe, 'unavailable host_runtime_probe');
  return unavailableProbe;
}

function assertPlanAndPrepare(
  registry: ReturnType<typeof createMainRegistry>,
): { plan: DispatchPlanResult; preparedId: string } {
  const plan = registry.get('dispatch_plan')!({
    storyId: 'B-dispatch',
    host: 'fake',
    parallel: 2,
    allowedPaths: [
      'packages/main/src/core/fake-worker-1.txt',
      'packages/main/src/core/fake-worker-2.txt',
    ],
    requiredCommands: ['git status --short'],
    successCriteria: ['Return local accepted receipts for both workers'],
    json: true,
  }) as DispatchPlanResult;
  assert.equal(plan.schemaVersion, 'lattice.dispatch_plan.v1');
  assert.equal(plan.status, 'planned');
  assert.equal(plan.selectedHost, 'fake');
  assert.equal(plan.parallel, 2);
  assert.equal(plan.pack.allowedPaths.length, 2);
  assert.match(plan.nextAction, /dispatch_prepare|dispatch_run/i);
  assertNoAuthorityOverclaim(plan, 'dispatch_plan fake');

  const prepared = registry.get('dispatch_prepare')!({
    storyId: 'B-dispatch',
    host: 'fake',
    parallel: 2,
    allowedPaths: [
      'packages/main/src/core/fake-worker-1.txt',
      'packages/main/src/core/fake-worker-2.txt',
    ],
    requiredCommands: ['git status --short'],
    successCriteria: ['Return local accepted receipts for both workers'],
    json: true,
  }) as { dispatchId: string; status: string; packFile: string; promptFile: string; workerIds: string[] };
  assert.equal(prepared.status, 'prepared');
  assert.ok(prepared.dispatchId.startsWith('D-B-dispatch-fake-'));
  assert.equal(prepared.workerIds.length, 0);
  assert.equal(existsSync(resolve(process.cwd(), prepared.packFile)), true, 'dispatch_prepare persisted the pack file');
  assert.equal(existsSync(resolve(process.cwd(), prepared.promptFile)), true, 'dispatch_prepare persisted the prompt file');
  return { plan, preparedId: prepared.dispatchId };
}

function assertFakeParallelRun(
  root: string,
  registry: ReturnType<typeof createMainRegistry>,
  dispatchId: string,
): { run: DispatchRunResult; leafDispatchId: string } {
  const run = registry.get('dispatch_run')!({ dispatchId, json: true }) as DispatchRunResult;
  assert.equal(run.schemaVersion, 'lattice.dispatch_run.v1');
  assert.equal(run.host, 'fake');
  assert.equal(run.parallel, 2);
  assert.equal(run.status, 'accepted_local');
  assert.equal(run.workers.length, 2);
  assertNoAuthorityOverclaim(run, 'dispatch_run fake parallel');
  for (const worker of run.workers) {
    assert.equal(worker.status, 'accepted_local');
    assert.equal(worker.parallel, 1);
    assert.equal(worker.receipt?.status, 'accepted-local');
    assert.equal(worker.receipt?.receiptVerified, false);
    assert.equal(worker.receipt?.productionDone, false);
    assert.match(worker.nextAction, /Review the isolated overflow diff/i);
    assertNoAuthorityOverclaim(worker, `dispatch_run worker ${worker.dispatchId}`);
  }

  const parentStatus = registry.get('dispatch_status')!({ dispatchId, json: true }) as DispatchStatusResult;
  assert.equal(parentStatus.schemaVersion, 'lattice.dispatch_status.v1');
  assert.equal(parentStatus.dispatch.status, 'accepted_local');
  assert.equal(parentStatus.workers.length, 2);
  assert.equal(parentStatus.receipt, undefined);
  assertNoAuthorityOverclaim(parentStatus, 'dispatch_status parent');

  const list = registry.get('dispatch_list')!({ storyId: 'B-dispatch', json: true }) as DispatchListResult;
  assert.equal(list.schemaVersion, 'lattice.dispatch_list.v1');
  assert.ok(list.dispatches.some(entry => entry.dispatchId === dispatchId && entry.status === 'accepted_local'));
  assert.equal(list.dispatches.filter(entry => entry.storyId === 'B-dispatch').length >= 3, true);
  assertNoAuthorityOverclaim(list, 'dispatch_list');

  const collect = registry.get('dispatch_collect')!({ dispatchId, json: true }) as DispatchCollection;
  assert.equal(collect.schemaVersion, 'lattice.dispatch_collect.v1');
  assert.equal(collect.status, 'accepted_local');
  assert.equal(collect.workers.length, 2);
  assert.equal(collect.changedFiles.length >= 2, true);
  assert.equal(collect.transcriptExists, true);
  assertNoAuthorityOverclaim(collect, 'dispatch_collect parent');
  for (const worker of collect.workers) {
    assert.equal(worker.changedFiles.length > 0, true, `worker ${worker.dispatchId} collected git-derived changedFiles`);
    assert.equal(worker.transcriptExists, true);
  }

  const leafDispatchId = run.workers[0]!.dispatchId;
  const draft = registry.get('dispatch_receipt_create')!({ dispatchId: leafDispatchId, json: true }) as DispatchReceiptDraft;
  assert.equal(draft.schemaVersion, 'lattice.dispatch_receipt_create.v1');
  assert.equal(draft.status, 'created');
  assert.equal(draft.receipt.changedFiles.length > 0, true);
  assert.equal(draft.receipt.limitations.some(line => /Draft receipt only/i.test(line)), true);
  assertNoAuthorityOverclaim(draft, 'dispatch_receipt_create leaf');

  const review = registry.get('dispatch_review')!({ dispatchId, json: true }) as DispatchReviewResult;
  assert.equal(review.schemaVersion, 'lattice.dispatch_review.v1');
  assert.equal(review.status, 'accepted_local');
  assert.equal(review.workers.length, 2);
  assert.equal(review.changedFiles.length >= 2, true);
  assert.match(review.nextAction, /Inspect each worker receipt and diff manually|merge planning/i);
  assertNoAuthorityOverclaim(review, 'dispatch_review parent');

  const mergePlan = registry.get('dispatch_merge_plan')!({ dispatchId, json: true }) as DispatchMergePlanResult;
  assert.equal(mergePlan.schemaVersion, 'lattice.dispatch_merge_plan.v1');
  assert.equal(mergePlan.status, 'accepted_local');
  assert.equal(mergePlan.mergeable, true);
  assert.equal(mergePlan.manualOnly, true);
  assert.equal(mergePlan.workers.length, 2);
  assert.equal(mergePlan.commands.length, 4);
  assert.match(mergePlan.nextAction, /Manual merge only/i);
  assertNoAuthorityOverclaim(mergePlan, 'dispatch_merge_plan accepted_local');

  for (const worker of run.workers) {
    const workerDir = join(root, '.koala', 'dispatches', worker.dispatchId);
    assert.equal(existsSync(join(workerDir, 'pack.json')), true, `worker ${worker.dispatchId} pack persisted`);
    assert.equal(existsSync(join(workerDir, 'receipt-submit.json')), true, `worker ${worker.dispatchId} receipt submission persisted`);
    const submission = JSON.parse(readFileSync(join(workerDir, 'receipt-submit.json'), 'utf8')) as { status: string };
    assert.equal(submission.status, 'accepted-local');
  }

  return { run, leafDispatchId };
}

function assertCancelAndResume(registry: ReturnType<typeof createMainRegistry>): void {
  const prepared = registry.get('dispatch_prepare')!({
    storyId: 'B-dispatch',
    host: 'fake',
    allowedPaths: ['packages/main/src/core/fake-resume.txt'],
    requiredCommands: ['git status --short'],
    json: true,
  }) as { dispatchId: string };

  const cancelled = registry.get('dispatch_cancel')!({ dispatchId: prepared.dispatchId, json: true }) as DispatchStatusResult;
  assert.equal(cancelled.dispatch.status, 'cancelled');
  assert.match(cancelled.dispatch.nextAction, /Dispatch cancelled/i);
  assertNoAuthorityOverclaim(cancelled, 'dispatch_cancel');

  const resumed = registry.get('dispatch_resume')!({ dispatchId: prepared.dispatchId, json: true }) as DispatchRunResult;
  assert.equal(resumed.status, 'accepted_local');
  assert.equal(resumed.parallel, 1);
  assert.equal(resumed.receipt?.status, 'accepted-local');
  assertNoAuthorityOverclaim(resumed, 'dispatch_resume');
}

function assertUnavailableRealHostPath(
  registry: ReturnType<typeof createMainRegistry>,
  unavailableProbe: HostRuntimeProbe,
): void {
  const host = unavailableProbe.host;
  const runUnderNarrowPath = <T>(fn: () => T): T => withEnv({
    PATH: '/usr/bin:/bin',
    KOALA_ACTIVITY_SOURCE: undefined,
    CODEX_SESSION_ID: undefined,
    CODEX_HOME: undefined,
  }, fn);

  const plan = runUnderNarrowPath(() => registry.get('dispatch_plan')!({
    storyId: 'B-dispatch',
    host,
    parallel: 1,
    json: true,
  }) as DispatchPlanResult);
  assert.equal(plan.status, 'unavailable');
  assert.equal(plan.selectedHost, host);
  assert.match(plan.nextAction, /Install|use host=fake/i);
  assertNoAuthorityOverclaim(plan, 'dispatch_plan unavailable real host');

  const prepared = runUnderNarrowPath(() => registry.get('dispatch_prepare')!({
    storyId: 'B-dispatch',
    host,
    parallel: 1,
    json: true,
  }) as DispatchStatusResult['dispatch']);
  assert.equal(prepared.status, 'unavailable');

  const run = runUnderNarrowPath(() => registry.get('dispatch_run')!({
    dispatchId: prepared.dispatchId,
    json: true,
  }) as DispatchRunResult);
  assert.equal(run.status, 'unavailable');
  assert.equal(run.host, host);
  assert.match(run.nextAction, /Install|use host=fake/i);
  assertNoAuthorityOverclaim(run, 'dispatch_run unavailable real host');
}

const root = mkdtempSync(join(tmpdir(), 'koala-dispatch-run-'));
try {
  initRepo(root);
  const previousCwd = process.cwd();
  process.chdir(root);
  try {
    const registry = createRegistry(root);
    assertRegistered(registry);
    const unavailableProbe = assertRuntimeListAndProbe(registry);
    const { preparedId } = assertPlanAndPrepare(registry);
    assertFakeParallelRun(root, registry, preparedId);
    assertCancelAndResume(registry);
    assertUnavailableRealHostPath(registry, unavailableProbe);
  } finally {
    process.chdir(previousCwd);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
