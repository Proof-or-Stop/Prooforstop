#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN_TOOLS } from '../cli-engine.js';
import { COMMAND_POLICIES } from '../core/command-policy.js';
import { resetConfigCache } from '../core/config.js';
import { PROCESS_FACT_LEVEL_BY_NAME } from '../core/process-fact-levels.js';
import { StoryStore } from '../core/store.js';
import type {
  ChecklistData,
  StoryInfo,
} from '../core/types.js';
import type {
  DispatchCollection,
  DispatchListResult,
  DispatchMergePlanResult,
  DispatchPlanResult,
  DispatchReceiptDraft,
  DispatchRecord,
  DispatchReviewResult,
  DispatchRunResult,
  DispatchStatusResult,
  HostRuntimeList,
  HostRuntimeProbe,
} from '../core/lattice-dispatch.js';
import type { HandlerContext } from '../handlers/context.js';
import { createMainRegistry } from '../registry.js';

const EXPECTED_COMMANDS = [
  'host_runtime_list',
  'host_runtime_probe',
  'dispatch_plan',
  'dispatch_prepare',
  'dispatch_run',
  'overflow_auto',
  'dispatch_collect',
  'dispatch_receipt_create',
  'dispatch_status',
  'dispatch_list',
  'dispatch_resume',
  'dispatch_cancel',
  'dispatch_review',
  'dispatch_merge_plan',
] as const;

const READ_ONLY_EXPECTED = new Set([
  'host_runtime_list',
  'host_runtime_probe',
  'dispatch_plan',
  'dispatch_status',
  'dispatch_list',
  'dispatch_review',
  'dispatch_merge_plan',
]);

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
  }, null, 2) + '\n');
}

function initRepo(root: string, externalDir: string): void {
  mkdirSync(join(root, 'packages/main/src/generated'), { recursive: true });
  mkdirSync(externalDir, { recursive: true });
  symlinkSync(externalDir, join(root, 'packages/main/src/generated/external-link'), 'dir');
  writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const smoke = true;\n');
  writeFileSync(join(root, 'README.md'), '# dispatch run smoke\n');
  writeConfig(root);
  git(root, ['init']);
  git(root, ['config', 'user.email', 'lattice@example.com']);
  git(root, ['config', 'user.name', 'Lattice Smoke']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);
}

function seedStory(store: StoryStore, storyId = 'B-dispatch'): void {
  const now = '2026-06-02T00:00:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'dispatch-run-smoke',
    title: 'Dispatch run smoke story',
    description: 'Smoke story for Lattice dispatch_run automatic overflow.',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: now, branch: `story/${storyId}` }],
  };
  const checklist: ChecklistData = {
    items: [
      {
        id: 'CHK-001',
        title: 'Dispatch run smoke',
        status: 'done',
        startTime: now,
        endTime: now,
      },
    ],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
}

function assertAuthorityFalse(value: unknown, label = 'result'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertAuthorityFalse(entry, `${label}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  for (const key of ['authorityChanged', 'receiptVerified', 'productionDone']) {
    if (key in record) assert.equal(record[key], false, `${label}.${key}`);
  }
  for (const [key, nested] of Object.entries(record)) {
    if (nested && typeof nested === 'object') assertAuthorityFalse(nested, `${label}.${key}`);
  }
}

function dispatchCount(root: string): number {
  const dir = join(root, '.koala/dispatches');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter(entry => existsSync(join(dir, entry, 'dispatch.json'))).length;
}

function readDispatch(root: string, dispatchId: string): DispatchRecord {
  return JSON.parse(readFileSync(join(root, '.koala/dispatches', dispatchId, 'dispatch.json'), 'utf8')) as DispatchRecord;
}

function writeDispatch(root: string, dispatchId: string, record: DispatchRecord): void {
  writeFileSync(join(root, '.koala/dispatches', dispatchId, 'dispatch.json'), JSON.stringify(record, null, 2) + '\n');
}

function readPack(root: string, dispatchId: string): { toHost: string; executionInstructions: string[] } {
  return JSON.parse(readFileSync(join(root, '.koala/dispatches', dispatchId, 'pack.json'), 'utf8')) as {
    toHost: string;
    executionInstructions: string[];
  };
}

function projectedDispatchWorktreePath(root: string, storyId: string, dispatchId: string): string {
  return join(root, '.worktrees', 'overflow', storyId, dispatchId);
}

function projectedDispatchWorktreeStoryRoot(root: string, storyId: string): string {
  return join(root, '.worktrees', 'overflow', storyId);
}

function seedProjectedDispatchWorktreeRootSymlink(root: string, storyId: string, dispatchId: string, externalTarget: string): string {
  const projectedRoot = projectedDispatchWorktreePath(root, storyId, dispatchId);
  mkdirSync(dirname(projectedRoot), { recursive: true });
  rmSync(projectedRoot, { recursive: true, force: true });
  symlinkSync(externalTarget, projectedRoot, 'dir');
  return projectedRoot;
}

function seedProjectedDispatchWorktreeAncestorSymlink(root: string, storyId: string, externalTarget: string): string {
  const projectedStoryRoot = projectedDispatchWorktreeStoryRoot(root, storyId);
  mkdirSync(dirname(projectedStoryRoot), { recursive: true });
  rmSync(projectedStoryRoot, { recursive: true, force: true });
  symlinkSync(externalTarget, projectedStoryRoot, 'dir');
  return projectedStoryRoot;
}

function isProjectedWorktreeContainmentFailure(detail: string): boolean {
  return /real git worktree root, not a symlink|resolves outside the isolated worktree via an existing symlinked path segment|traverses a symlinked ancestor|ancestor must be a directory|ancestor resolves outside the repository root/i.test(detail);
}

function assertFiveWayRegistration(command: string, registry: ReturnType<typeof createMainRegistry>): void {
  assert.ok(MAIN_TOOLS.some(tool => tool.name === command), `${command} missing MAIN_TOOLS entry`);
  assert.equal(registry.has(command), true, `${command} missing registry handler`);
  assert.ok(command in COMMAND_POLICIES, `${command} missing command policy`);
  assert.ok(PROCESS_FACT_LEVEL_BY_NAME[command], `${command} missing process fact level`);
  const ownership = COMMAND_POLICIES[command as keyof typeof COMMAND_POLICIES].ownershipClass;
  if (READ_ONLY_EXPECTED.has(command)) {
    assert.equal(ownership, 'readOnly', `${command} should stay read-only`);
  }
}

const sandboxRoot = mkdtempSync(join(tmpdir(), 'lattice-dispatch-run-suite-'));
const root = join(sandboxRoot, 'repo', 'root');
const externalDir = mkdtempSync(join(tmpdir(), 'lattice-dispatch-run-external-'));
const externalMarker = join(externalDir, 'blocked-by-symlink.txt');
const escapedHostRuntimeListOutput = resolve(root, '../escape.json');
const escapedDispatchPlanOutput = resolve(root, '../../escape.json');
const outputSymlinkEscapeMarker = join(externalDir, 'nested/output-symlink-escape.json');
const fakeProjectedRootExternalDir = mkdtempSync(join(tmpdir(), 'lattice-dispatch-run-fake-root-'));
const realProjectedRootExternalDir = mkdtempSync(join(tmpdir(), 'lattice-dispatch-run-real-root-'));
const fakeAncestorExternalDir = mkdtempSync(join(tmpdir(), 'lattice-dispatch-run-fake-ancestor-'));
const realAncestorExternalDir = mkdtempSync(join(tmpdir(), 'lattice-dispatch-run-real-ancestor-'));
try {
  initRepo(root, externalDir);
  resetConfigCache();
  const store = new StoryStore(root);
  seedStory(store);
  seedStory(store, 'B-ancestor-attack');
  const baseSha = git(root, ['rev-parse', 'HEAD']);
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  const registry = createMainRegistry(ctx);
  const run = <T>(name: string, args: Record<string, unknown> = {}): T => {
    const handler = registry.get(name);
    assert.ok(handler, `${name} handler must be registered`);
    return handler({ ...args, json: true }) as T;
  };
  const runText = (name: string, args: Record<string, unknown> = {}): string => {
    const handler = registry.get(name);
    assert.ok(handler, `${name} handler must be registered`);
    return handler(args) as string;
  };

  for (const command of EXPECTED_COMMANDS) assertFiveWayRegistration(command, registry);

  const runtimeList = run<HostRuntimeList>('host_runtime_list');
  assert.equal(runtimeList.schemaVersion, 'lattice.host_runtime_list.v1');
  assert.deepEqual(runtimeList.runtimes.map(runtime => runtime.host), ['fake', 'claude-code', 'gemini', 'codex']);
  assert.equal(runtimeList.runtimes.find(runtime => runtime.host === 'fake')?.status, 'ready');
  assertAuthorityFalse(runtimeList, 'runtimeList');

  const fakeProbe = run<HostRuntimeProbe>('host_runtime_probe', { host: 'fake' });
  assert.equal(fakeProbe.status, 'ready');
  assert.equal(fakeProbe.supportsParallel, true);
  assertAuthorityFalse(fakeProbe, 'fakeProbe');
  assert.throws(() => run<HostRuntimeProbe>('host_runtime_probe', { host: 'unknown-host' }), /requires host=fake\|claude-code\|gemini\|codex/);

  assert.throws(
    () => run<HostRuntimeList>('host_runtime_list', { output: '../escape.json' }),
    /--output escapes the repository root via path traversal/i,
    'host_runtime_list --output=../escape.json must be rejected before writing outside root',
  );
  assert.equal(existsSync(escapedHostRuntimeListOutput), false, 'host_runtime_list escaped output must never be created');
  assert.throws(
    () => runText('dispatch_plan', {
      storyId: 'B-dispatch',
      host: 'fake',
      objective: 'Escaped output must be rejected.',
      output: '../../escape.json',
    }),
    /--output escapes the repository root via path traversal/i,
    'dispatch_plan --output=../../escape.json must be rejected before writing outside root',
  );
  assert.equal(existsSync(escapedDispatchPlanOutput), false, 'dispatch_plan escaped output must never be created');

  const absoluteRuntimeOutput = join(root, 'reports/absolute-runtime-list.json');
  assert.throws(
    () => run<HostRuntimeProbe>('host_runtime_probe', { host: 'fake', output: absoluteRuntimeOutput }),
    /--output must be a relative path inside the repository root/i,
    'host_runtime_probe --output must reject absolute paths',
  );
  assert.equal(existsSync(absoluteRuntimeOutput), false, 'absolute --output rejection must not write inside root');
  assert.throws(
    () => run<HostRuntimeList>('host_runtime_list', { output: '.' }),
    /--output must resolve to a file inside the repository root, not the repository root itself/i,
    'host_runtime_list --output=. must reject the repo root as the output target',
  );

  const nonDirectoryOutputAncestor = join(root, 'reports-file-ancestor');
  writeFileSync(nonDirectoryOutputAncestor, 'not a directory\n');
  assert.throws(
    () => run<HostRuntimeList>('host_runtime_list', { output: 'reports-file-ancestor/runtime-list.json' }),
    /--output ancestor must be a directory/i,
    'host_runtime_list --output must reject existing non-directory ancestors',
  );

  assert.throws(
    () => run<HostRuntimeList>('host_runtime_list', {
      output: 'packages/main/src/generated/external-link/nested/output-symlink-escape.json',
    }),
    /--output traverses a symlinked ancestor/i,
    'host_runtime_list output must reject a pre-existing symlink ancestor that resolves outside root',
  );
  assert.equal(existsSync(outputSymlinkEscapeMarker), false, 'output symlink ancestor escape target must never be created');

  const legalRuntimeOutput = 'reports/runtime-list.json';
  const legalRuntimeOutputPath = join(root, legalRuntimeOutput);
  const legalRuntimeList = run<HostRuntimeList>('host_runtime_list', { output: legalRuntimeOutput });
  assert.equal(legalRuntimeList.schemaVersion, 'lattice.host_runtime_list.v1');
  assert.equal(existsSync(legalRuntimeOutputPath), true, 'repo-local output should be created');
  assert.equal(JSON.parse(readFileSync(legalRuntimeOutputPath, 'utf8')).schemaVersion, 'lattice.host_runtime_list.v1');
  assert.throws(
    () => run<HostRuntimeList>('host_runtime_list', { output: legalRuntimeOutput }),
    /refusing to overwrite existing file/,
    'repo-local output must keep no-overwrite behavior',
  );

  const legalPlanOutput = 'reports/nested/dispatch-plan.json';
  const legalPlanText = runText('dispatch_plan', {
    storyId: 'B-dispatch',
    host: 'fake',
    objective: 'Repo-local text output should be written.',
    output: legalPlanOutput,
  });
  assert.match(legalPlanText, /output: reports\/nested\/dispatch-plan\.json/);
  assert.equal(existsSync(join(root, legalPlanOutput)), true, 'repo-local text output should be created');

  const beforePlanCount = dispatchCount(root);
  const plan = run<DispatchPlanResult>('dispatch_plan', {
    storyId: 'B-dispatch',
    host: 'fake',
    objective: 'Verify dispatch planning without side effects.',
    allowedPaths: ['packages/main/src/generated/plan.txt'],
    deniedPaths: ['README.md'],
    successCriteria: ['Plan only'],
    parallel: 2,
  });
  assert.equal(plan.schemaVersion, 'lattice.dispatch_plan.v1');
  assert.equal(plan.status, 'planned');
  assert.equal(plan.selectedHost, 'fake');
  assert.equal(plan.parallel, 2);
  assert.equal(dispatchCount(root), beforePlanCount, 'dispatch_plan must not create dispatch records');
  assert.equal(existsSync(join(root, '.koala/dispatches')), false, 'dispatch_plan must not create .koala/dispatches');
  assertAuthorityFalse(plan, 'plan');

  const prepared = run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-prepare',
    host: 'fake',
    objective: 'Prepare only.',
    allowedPaths: ['packages/main/src/generated/prepare.txt'],
    deniedPaths: ['README.md'],
  });
  assert.equal(prepared.status, 'prepared');
  assert.equal(existsSync(join(root, prepared.packFile)), true);
  assert.equal(existsSync(join(root, prepared.promptFile)), true);
  assert.equal(existsSync(resolve(root, prepared.worktree.worktreePath)), false, 'dispatch_prepare must not create a worktree');
  assertAuthorityFalse(prepared, 'prepared');

  const unconstrainedPrepared = run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-prepare-unconstrained',
    host: 'fake',
    objective: 'Prepare with missing constraints should warn without starting a host.',
  });
  assert.equal(unconstrainedPrepared.status, 'prepared');
  assert.ok(unconstrainedPrepared.warnings.some(warning => /No allowedPaths declared/i.test(warning)));
  assert.ok(unconstrainedPrepared.warnings.some(warning => /No requiredCommands declared/i.test(warning)));
  assert.equal(existsSync(resolve(root, unconstrainedPrepared.worktree.worktreePath)), false, 'missing-constraints dispatch_prepare must not create a worktree');
  assert.equal(existsSync(join(root, unconstrainedPrepared.receiptFile)), false, 'missing-constraints dispatch_prepare must not create a receipt');
  assertAuthorityFalse(unconstrainedPrepared, 'unconstrainedPrepared');

  const geminiPrepared = run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-gemini-prepare',
    host: 'gemini',
    objective: 'Gemini dispatch should preserve host-neutral identity in pack and prompt artifacts.',
    allowedPaths: ['packages/main/src/generated/gemini-prepare.txt'],
    deniedPaths: ['README.md'],
  });
  const geminiPack = readPack(root, geminiPrepared.dispatchId);
  const geminiPrompt = readFileSync(join(root, geminiPrepared.promptFile), 'utf8');
  assert.equal(geminiPrepared.selectedHost, 'gemini');
  assert.equal(geminiPrepared.runtime.host, 'gemini');
  assert.equal(geminiPack.toHost, 'gemini');
  assert.ok(
    geminiPack.executionInstructions.some(instruction => /Use gemini only as a bounded overflow execution host/i.test(instruction)),
    'gemini dispatch pack should preserve Gemini host identity in execution instructions',
  );
  assert.ok(
    !geminiPack.executionInstructions.some(instruction => /Use codex only as a bounded overflow execution host/i.test(instruction)),
    'gemini dispatch pack should not silently fall back to Codex wording',
  );
  assert.match(geminiPrompt, /Host runtime: gemini/);
  assert.match(geminiPrompt, /Use gemini only as a bounded overflow execution host/i);
  assert.doesNotMatch(geminiPrompt, /Use codex only as a bounded overflow execution host/i);
  assertAuthorityFalse(geminiPrepared, 'geminiPrepared');

  const geminiDraftReceipt = run<DispatchReceiptDraft>('dispatch_receipt_create', { dispatchId: geminiPrepared.dispatchId });
  assert.equal(geminiDraftReceipt.receipt.host, 'gemini');
  assert.notEqual(geminiDraftReceipt.receipt.host, 'codex');
  assert.equal(geminiDraftReceipt.receipt.fromHost, 'codex');
  assert.equal(geminiDraftReceipt.receipt.toHost, 'gemini');
  assertAuthorityFalse(geminiDraftReceipt, 'geminiDraftReceipt');

  run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-parallel',
    host: 'fake',
    objective: 'Verify parallel fake workers.',
    allowedPaths: [
      'packages/main/src/generated/worker-1.txt',
      'packages/main/src/generated/worker-2.txt',
    ],
    deniedPaths: ['README.md'],
    successCriteria: ['Each worker returns local receipt only'],
    parallel: 2,
  });
  const parallelRun = run<DispatchRunResult>('dispatch_run', { dispatchId: 'D-parallel' });
  assert.equal(parallelRun.schemaVersion, 'lattice.dispatch_run.v1');
  assert.equal(parallelRun.status, 'accepted_local');
  assert.equal(parallelRun.parallel, 2);
  assert.equal(parallelRun.workers.length, 2);
  assert.equal('receipt' in parallelRun, false, 'parent parallel dispatch should not create a parent receipt');
  for (const worker of parallelRun.workers) {
    assert.equal(worker.status, 'accepted_local');
    assert.equal(worker.receipt?.status, 'accepted-local');
    assert.equal(worker.receipt?.host, 'fake');
    assert.notEqual(worker.receipt?.host, 'codex');
    assert.equal(worker.receipt?.verdict, 'pass');
    assert.equal(worker.receipt?.validations.verdict, 'pass');
  }
  const parentRecord = readDispatch(root, 'D-parallel');
  assert.deepEqual(parentRecord.workerIds, ['D-parallel-w1', 'D-parallel-w2']);
  assertAuthorityFalse(parallelRun, 'parallelRun');

  const parentStatus = run<DispatchStatusResult>('dispatch_status', { dispatchId: 'D-parallel' });
  assert.equal(parentStatus.dispatch.status, 'accepted_local');
  assert.equal(parentStatus.workers.length, 2);
  assert.equal(parentStatus.receipt, undefined);
  assertAuthorityFalse(parentStatus, 'parentStatus');

  const parentCollect = run<DispatchCollection>('dispatch_collect', { dispatchId: 'D-parallel' });
  assert.equal(parentCollect.status, 'accepted_local');
  assert.equal(parentCollect.workers.length, 2);
  assert.equal(parentCollect.changedFiles.length, 2);
  assert.equal(existsSync(join(root, '.koala/dispatches/D-parallel/collect.json')), true);
  assert.throws(() => run<DispatchReceiptDraft>('dispatch_receipt_create', { dispatchId: 'D-parallel' }), /only supports leaf dispatches/);

  const leafReceipt = run<DispatchReceiptDraft>('dispatch_receipt_create', { dispatchId: 'D-parallel-w1' });
  assert.equal(leafReceipt.status, 'created');
  assert.equal(leafReceipt.receipt.host, 'fake');
  assert.notEqual(leafReceipt.receipt.host, 'codex');
  assert.equal(leafReceipt.receipt.verdict, 'pass');
  assertAuthorityFalse(leafReceipt, 'leafReceipt');

  const review = run<DispatchReviewResult>('dispatch_review', { dispatchId: 'D-parallel' });
  assert.equal(review.status, 'accepted_local');
  assert.equal(review.changedFiles.length, 2);
  assert.equal(review.workers.length, 2);
  assertAuthorityFalse(review, 'review');

  const mergePlan = run<DispatchMergePlanResult>('dispatch_merge_plan', { dispatchId: 'D-parallel' });
  assert.equal(mergePlan.mergeable, true);
  assert.equal(mergePlan.manualOnly, true);
  assert.equal(mergePlan.commands.length, 4);
  assert.ok(mergePlan.commands.every(command => !/\bgit\s+(merge|cherry-pick)\b/.test(command)));
  assertAuthorityFalse(mergePlan, 'mergePlan');

  run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-parallel-mixed',
    host: 'fake',
    objective: 'Mixed fake worker outcomes should stay recoverable at the parent level.',
    allowedPaths: [
      'packages/main/src/generated/mixed-worker-1.txt',
      'packages/main/src/generated/mixed-worker-2.txt',
    ],
    requiredCommands: ['node -e "const fs = require(\'fs\'); process.exit(fs.existsSync(\'packages/main/src/generated/mixed-worker-2.txt\') ? 7 : 0)"'],
    successCriteria: ['One worker succeeds while another reports a local command failure'],
    parallel: 2,
  });
  const mixedRun = run<DispatchRunResult>('dispatch_run', { dispatchId: 'D-parallel-mixed' });
  assert.equal(mixedRun.status, 'diagnostic');
  assert.equal(mixedRun.parallel, 2);
  assert.equal(mixedRun.workers.length, 2);
  assert.equal(mixedRun.workers[0].status, 'accepted_local');
  assert.equal(mixedRun.workers[0].receipt?.status, 'accepted-local');
  assert.equal(mixedRun.workers[0].receipt?.validations.verdict, 'pass');
  assert.deepEqual(mixedRun.workers[0].receipt?.changedFiles, ['packages/main/src/generated/mixed-worker-1.txt']);
  assert.equal(mixedRun.workers[1].status, 'failed');
  assert.equal(mixedRun.workers[1].receipt?.status, 'diagnostic');
  assert.equal(mixedRun.workers[1].receipt?.verdict, 'fail');
  assert.equal(mixedRun.workers[1].receipt?.validations.verdict, 'fail');
  assert.ok(mixedRun.workers[1].warnings.some(warning => /command failed:/i.test(warning)));
  assert.ok(mixedRun.workers[1].receipt?.limitations.some(limitation => /command failed:/i.test(limitation)));
  const mixedParentRecord = readDispatch(root, 'D-parallel-mixed');
  assert.equal(mixedParentRecord.status, 'diagnostic');
  assert.deepEqual(mixedParentRecord.workerIds, ['D-parallel-mixed-w1', 'D-parallel-mixed-w2']);
  const mixedParentStatus = run<DispatchStatusResult>('dispatch_status', { dispatchId: 'D-parallel-mixed' });
  assert.equal(mixedParentStatus.dispatch.status, 'diagnostic');
  assert.equal(mixedParentStatus.workers[0].dispatch.status, 'accepted_local');
  assert.equal(mixedParentStatus.workers[1].dispatch.status, 'failed');
  assert.deepEqual(mixedParentStatus.workers[0].receipt?.changedFiles, ['packages/main/src/generated/mixed-worker-1.txt']);
  const mixedCollect = run<DispatchCollection>('dispatch_collect', { dispatchId: 'D-parallel-mixed' });
  assert.equal(mixedCollect.status, 'diagnostic');
  assert.equal(mixedCollect.changedFiles.length, 2);
  assert.deepEqual(mixedCollect.workers[0]?.changedFiles, ['packages/main/src/generated/mixed-worker-1.txt']);
  assert.deepEqual(mixedCollect.workers[1]?.changedFiles, ['packages/main/src/generated/mixed-worker-2.txt']);
  const mixedReview = run<DispatchReviewResult>('dispatch_review', { dispatchId: 'D-parallel-mixed' });
  assert.equal(mixedReview.status, 'diagnostic');
  assert.equal(mixedReview.changedFiles.length, 2);
  assert.equal(mixedReview.workers.length, 2);
  assert.ok(mixedReview.risks.some(risk => /dispatch status=failed/i.test(risk)));
  assert.ok(mixedReview.risks.some(risk => /receipt is diagnostic-only or missing/i.test(risk)));
  assert.match(mixedReview.nextAction, /non-accepted workers/i);
  const mixedMerge = run<DispatchMergePlanResult>('dispatch_merge_plan', { dispatchId: 'D-parallel-mixed' });
  assert.equal(mixedMerge.mergeable, false);
  assert.deepEqual(mixedMerge.commands, []);
  assert.ok(mixedMerge.workers.some(worker => worker.dispatchId === 'D-parallel-mixed-w1' && worker.status === 'accepted_local'));
  assert.ok(mixedMerge.workers.some(worker => worker.dispatchId === 'D-parallel-mixed-w2' && worker.status === 'failed'));
  assertAuthorityFalse(mixedRun, 'mixedRun');
  assertAuthorityFalse(mixedParentStatus, 'mixedParentStatus');
  assertAuthorityFalse(mixedCollect, 'mixedCollect');
  assertAuthorityFalse(mixedReview, 'mixedReview');
  assertAuthorityFalse(mixedMerge, 'mixedMerge');

  run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-failing-command',
    host: 'fake',
    objective: 'Required command failure must not be accepted local.',
    allowedPaths: ['packages/main/src/generated/failing.txt'],
    requiredCommands: ['node -e "process.exit(7)"'],
  });
  const failedRun = run<DispatchRunResult>('dispatch_run', { dispatchId: 'D-failing-command' });
  assert.equal(failedRun.status, 'failed');
  assert.equal(failedRun.receipt?.status, 'diagnostic');
  assert.equal(failedRun.receipt?.verdict, 'fail');
  assert.equal(failedRun.receipt?.validations.verdict, 'fail');
  const failedReview = run<DispatchReviewResult>('dispatch_review', { dispatchId: 'D-failing-command' });
  assert.equal(failedReview.status, 'failed');
  assert.ok(failedReview.risks.some(risk => /dispatch status=failed/i.test(risk)));
  assert.ok(failedReview.risks.some(risk => /receipt is diagnostic-only or missing/i.test(risk)));
  const failedMerge = run<DispatchMergePlanResult>('dispatch_merge_plan', { dispatchId: 'D-failing-command' });
  assert.equal(failedMerge.mergeable, false);
  assert.deepEqual(failedMerge.commands, []);
  assertAuthorityFalse(failedRun, 'failedRun');
  assertAuthorityFalse(failedReview, 'failedReview');

  run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-diagnostic-scope',
    host: 'fake',
    objective: 'Denied overlap should keep a passing fake worker diagnostic-only.',
    allowedPaths: ['packages/main/src/generated/diagnostic-scope.txt'],
    deniedPaths: ['packages/main/src/generated/diagnostic-scope.txt'],
  });
  const diagnosticRun = run<DispatchRunResult>('dispatch_run', { dispatchId: 'D-diagnostic-scope' });
  assert.equal(diagnosticRun.status, 'diagnostic');
  assert.equal(diagnosticRun.receipt?.status, 'diagnostic');
  assert.equal(diagnosticRun.receipt?.verdict, 'pass');
  assert.equal(diagnosticRun.receipt?.validations.changedFiles, 'fail');
  const diagnosticReview = run<DispatchReviewResult>('dispatch_review', { dispatchId: 'D-diagnostic-scope' });
  assert.equal(diagnosticReview.status, 'diagnostic');
  assert.ok(diagnosticReview.risks.some(risk => /dispatch status=diagnostic/i.test(risk)));
  assert.ok(diagnosticReview.risks.some(risk => /receipt is diagnostic-only or missing/i.test(risk)));
  const diagnosticMerge = run<DispatchMergePlanResult>('dispatch_merge_plan', { dispatchId: 'D-diagnostic-scope' });
  assert.equal(diagnosticMerge.mergeable, false);
  assert.deepEqual(diagnosticMerge.commands, []);
  assertAuthorityFalse(diagnosticRun, 'diagnosticRun');
  assertAuthorityFalse(diagnosticReview, 'diagnosticReview');

  const draftOnly = run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-draft-receipt-no-collect',
    host: 'fake',
    objective: 'Draft receipt should degrade when no worker collect data exists yet.',
    allowedPaths: ['packages/main/src/generated/draft-only.txt'],
  });
  const draftReceipt = run<DispatchReceiptDraft>('dispatch_receipt_create', { dispatchId: draftOnly.dispatchId });
  assert.equal(draftReceipt.status, 'diagnostic');
  assert.equal(draftReceipt.receipt.host, 'fake');
  assert.notEqual(draftReceipt.receipt.host, 'codex');
  assert.equal(draftReceipt.receipt.verdict, 'warn');
  assert.deepEqual(draftReceipt.receipt.changedFiles, []);
  assert.ok(draftReceipt.receipt.limitations.some(limitation => /No git-derived changedFiles detected/i.test(limitation)));
  assertAuthorityFalse(draftReceipt, 'draftReceipt');

  const cancelRecord = run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-cancel-resume',
    host: 'fake',
    allowedPaths: ['packages/main/src/generated/cancel-resume.txt'],
  });
  const cancelStatus = run<DispatchStatusResult>('dispatch_cancel', { dispatchId: cancelRecord.dispatchId });
  assert.equal(cancelStatus.dispatch.status, 'cancelled');
  assert.equal(existsSync(join(root, cancelStatus.dispatch.receiptFile)), false);
  const resumed = run<DispatchRunResult>('dispatch_resume', { dispatchId: cancelRecord.dispatchId });
  assert.equal(resumed.status, 'accepted_local');
  assert.equal(resumed.receipt?.status, 'accepted-local');

  const expiredRecord = run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-expired',
    host: 'fake',
    allowedPaths: ['packages/main/src/generated/expired.txt'],
  });
  writeDispatch(root, expiredRecord.dispatchId, {
    ...expiredRecord,
    expiresAt: '2026-06-01T00:00:00.000Z',
  });
  const expiredStatus = run<DispatchStatusResult>('dispatch_status', { dispatchId: expiredRecord.dispatchId });
  assert.equal(expiredStatus.dispatch.status, 'expired');
  const expiredRun = run<DispatchRunResult>('dispatch_run', { dispatchId: expiredRecord.dispatchId });
  assert.equal(expiredRun.status, 'expired');
  assert.equal(existsSync(resolve(root, expiredRecord.worktree.worktreePath)), false, 'expired dispatch_run must not create a worktree');
  assert.equal(readDispatch(root, expiredRecord.dispatchId).status, 'expired');

  const list = run<DispatchListResult>('dispatch_list', { storyId: 'B-dispatch' });
  assert.ok(list.dispatches.some(entry => entry.dispatchId === 'D-parallel'));
  assert.ok(list.dispatches.some(entry => entry.dispatchId === 'D-cancel-resume'));
  assertAuthorityFalse(list, 'list');

  const beforeOverflowSuggestCount = dispatchCount(root);
  const autoSuggested = run<DispatchPlanResult>('overflow_auto', {
    storyId: 'B-dispatch',
    objective: 'Default auto suggestion should not require an explicit fake host.',
  });
  assert.equal(autoSuggested.schemaVersion, 'lattice.dispatch_plan.v1');
  assert.equal(autoSuggested.requestedHost, 'auto');
  assert.ok(autoSuggested.warnings.some(warning => /suggest-only/i.test(warning)));
  assert.equal(dispatchCount(root), beforeOverflowSuggestCount, 'overflow_auto default host=auto must not materialize dispatch records');
  const suggested = run<DispatchPlanResult>('overflow_auto', {
    storyId: 'B-dispatch',
    host: 'fake',
    objective: 'Suggest only.',
  });
  assert.equal(suggested.schemaVersion, 'lattice.dispatch_plan.v1');
  assert.ok(suggested.warnings.some(warning => /suggest-only/i.test(warning)));
  assert.equal(dispatchCount(root), beforeOverflowSuggestCount, 'overflow_auto default must not materialize dispatch records');
  const startOnly = run<DispatchPlanResult>('overflow_auto', {
    storyId: 'B-dispatch',
    host: 'fake',
    objective: 'Start-only must stay suggest-only.',
    start: true,
  });
  assert.equal(startOnly.schemaVersion, 'lattice.dispatch_plan.v1');
  assert.ok(startOnly.warnings.some(warning => /start=true without approve=true/i.test(warning)));
  assert.match(startOnly.nextAction, /approve=true --start=true/);
  assert.equal(dispatchCount(root), beforeOverflowSuggestCount, 'overflow_auto start=true alone must stay suggest-only');
  const approveOnly = run<DispatchPlanResult>('overflow_auto', {
    storyId: 'B-dispatch',
    host: 'fake',
    objective: 'Approve-only must stay suggest-only.',
    approve: true,
  });
  assert.equal(approveOnly.schemaVersion, 'lattice.dispatch_plan.v1');
  assert.ok(approveOnly.warnings.some(warning => /approve=true without start=true/i.test(warning)));
  assert.match(approveOnly.nextAction, /approve=true --start=true/);
  assert.equal(dispatchCount(root), beforeOverflowSuggestCount, 'overflow_auto approve=true alone must stay suggest-only');
  const approved = run<DispatchRunResult>('overflow_auto', {
    storyId: 'B-dispatch',
    host: 'fake',
    objective: 'Approved fake overflow run.',
    allowedPaths: ['packages/main/src/generated/overflow-approved.txt'],
    approve: true,
    start: true,
  });
  assert.equal(approved.status, 'accepted_local');
  assertAuthorityFalse(approved, 'approvedOverflow');

  assert.throws(() => run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-path-traversal',
    host: 'fake',
    objective: 'Traversal must be rejected before any file write.',
    allowedPaths: ['../D-path-traversal-escaped.txt'],
    deniedPaths: ['README.md'],
  }), /allowedPaths\[0\].*escapes the isolated worktree/i);
  assert.equal(existsSync(resolve(root, '../D-path-traversal-escaped.txt')), false, 'escaped file must never be written');
  assert.equal(existsSync(join(root, '.koala/dispatches/D-path-traversal')), false, 'invalid traversal must not persist dispatch metadata');

  run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: 'D-symlink-escape',
    host: 'fake',
    objective: 'Symlink escape must be rejected before writing outside the worktree.',
    allowedPaths: ['packages/main/src/generated/external-link/blocked-by-symlink.txt'],
    deniedPaths: ['README.md'],
  });
  assert.throws(
    () => run<DispatchRunResult>('dispatch_run', { dispatchId: 'D-symlink-escape' }),
    /resolves outside the isolated worktree via an existing symlinked path segment/i,
  );
  assert.equal(existsSync(externalMarker), false, 'symlink escape target must never be written');

  const fakeProjectedRootDispatchId = 'D-preexisting-root-symlink-fake';
  const fakeProjectedRootExternalMarker = join(fakeProjectedRootExternalDir, 'packages/main/src/generated/preexisting-root-blocked.txt');
  seedProjectedDispatchWorktreeRootSymlink(root, 'B-dispatch', fakeProjectedRootDispatchId, fakeProjectedRootExternalDir);
  run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-dispatch',
    dispatchId: fakeProjectedRootDispatchId,
    host: 'fake',
    objective: 'Fake runtime must reject a projected worktree root symlink before writing external output.',
    allowedPaths: ['packages/main/src/generated/preexisting-root-blocked.txt'],
    deniedPaths: ['README.md'],
  });
  assert.throws(
    () => run<DispatchRunResult>('dispatch_run', { dispatchId: fakeProjectedRootDispatchId }),
    error => isProjectedWorktreeContainmentFailure(String(error)),
  );
  assert.equal(existsSync(fakeProjectedRootExternalMarker), false, 'fake projected-root symlink target must never receive allowed output');
  assert.deepEqual(readdirSync(fakeProjectedRootExternalDir), [], 'fake projected-root symlink target must remain unused');

  const fakeAncestorDispatchId = 'D-ancestor-symlink-fake';
  seedProjectedDispatchWorktreeAncestorSymlink(root, 'B-ancestor-attack', fakeAncestorExternalDir);
  run<DispatchRecord>('dispatch_prepare', {
    storyId: 'B-ancestor-attack',
    dispatchId: fakeAncestorDispatchId,
    host: 'fake',
    objective: 'Fake runtime must reject a symlinked projected worktree ancestor before git worktree add.',
    allowedPaths: ['packages/main/src/generated/ancestor-blocked.txt'],
    deniedPaths: ['README.md'],
  });
  assert.throws(
    () => run<DispatchRunResult>('dispatch_run', { dispatchId: fakeAncestorDispatchId }),
    error => isProjectedWorktreeContainmentFailure(String(error)),
  );
  assert.equal(existsSync(resolve(root, projectedDispatchWorktreePath(root, 'B-ancestor-attack', fakeAncestorDispatchId))), false, 'fake ancestor symlink attack must not materialize a worktree path');
  assert.deepEqual(readdirSync(fakeAncestorExternalDir), [], 'fake ancestor symlink target must remain unused');
  rmSync(projectedDispatchWorktreeStoryRoot(root, 'B-ancestor-attack'), { recursive: true, force: true });

  const maliciousDispatchId = '../../dispatch-id-escape';
  const escapedDispatchMetadataDir = resolve(root, 'dispatch-id-escape');
  const maliciousOverflowSuggest = run<DispatchPlanResult>('overflow_auto', {
    storyId: 'B-dispatch',
    dispatchId: maliciousDispatchId,
    host: 'fake',
    allowedPaths: ['packages/main/src/generated/malicious-overflow-suggest.txt'],
  });
  assert.equal(maliciousOverflowSuggest.schemaVersion, 'lattice.dispatch_plan.v1');
  assert.equal(existsSync(escapedDispatchMetadataDir), false, 'overflow_auto suggest-only malicious dispatchId must not write outside .koala/dispatches');
  for (const [command, args] of [
    ['dispatch_prepare', {
      storyId: 'B-dispatch',
      dispatchId: maliciousDispatchId,
      host: 'fake',
      allowedPaths: ['packages/main/src/generated/malicious.txt'],
    }],
    ['dispatch_run', {
      storyId: 'B-dispatch',
      dispatchId: maliciousDispatchId,
      host: 'fake',
      allowedPaths: ['packages/main/src/generated/malicious.txt'],
    }],
    ['dispatch_status', { dispatchId: maliciousDispatchId }],
    ['dispatch_collect', { dispatchId: maliciousDispatchId }],
    ['dispatch_receipt_create', { dispatchId: maliciousDispatchId }],
    ['dispatch_resume', { dispatchId: maliciousDispatchId }],
    ['dispatch_cancel', { dispatchId: maliciousDispatchId }],
    ['dispatch_review', { dispatchId: maliciousDispatchId }],
    ['dispatch_merge_plan', { dispatchId: maliciousDispatchId }],
    ['overflow_auto', {
      storyId: 'B-dispatch',
      dispatchId: maliciousDispatchId,
      host: 'fake',
      allowedPaths: ['packages/main/src/generated/malicious-overflow-start.txt'],
      approve: true,
      start: true,
    }],
  ] as const) {
    assert.throws(
      () => run(command, args),
      /dispatchId must not contain path separators or traversal segments/i,
      `${command} must reject malicious dispatchId`,
    );
  }
  assert.equal(existsSync(escapedDispatchMetadataDir), false, 'malicious dispatchId must not write metadata outside .koala/dispatches');

  const unknownValidDispatchId = 'D-valid-but-missing';
  for (const [command, args] of [
    ['dispatch_run', { dispatchId: unknownValidDispatchId }],
    ['dispatch_status', { dispatchId: unknownValidDispatchId }],
    ['dispatch_collect', { dispatchId: unknownValidDispatchId }],
    ['dispatch_receipt_create', { dispatchId: unknownValidDispatchId }],
    ['dispatch_resume', { dispatchId: unknownValidDispatchId }],
    ['dispatch_cancel', { dispatchId: unknownValidDispatchId }],
    ['dispatch_review', { dispatchId: unknownValidDispatchId }],
    ['dispatch_merge_plan', { dispatchId: unknownValidDispatchId }],
    ['overflow_auto', {
      storyId: 'B-dispatch',
      dispatchId: unknownValidDispatchId,
      approve: true,
      start: true,
    }],
  ] as const) {
    assert.throws(
      () => run(command, args),
      new RegExp(`Unknown dispatchId ${unknownValidDispatchId}`),
      `${command} must reject an unknown but syntactically valid dispatchId`,
    );
  }

  const originalCodexSessionId = process.env.CODEX_SESSION_ID;
  try {
    process.env.CODEX_SESSION_ID = 'dispatch-run-smoke';
    assert.throws(() => run<DispatchRecord>('dispatch_prepare', {
      storyId: 'B-dispatch',
      dispatchId: 'D-real-host-traversal',
      host: 'codex',
      objective: 'Real-host traversal must be rejected before prompt metadata persists.',
      allowedPaths: ['packages/main/src/generated/real-host-traversal.txt'],
      deniedPaths: ['../outside.txt'],
    }), /deniedPaths\[0\].*escapes the isolated worktree/i);
    assert.equal(existsSync(join(root, '.koala/dispatches/D-real-host-traversal')), false, 'invalid real-host traversal must not persist dispatch metadata');

    const realHostReady = run<DispatchRecord>('dispatch_prepare', {
      storyId: 'B-dispatch',
      dispatchId: 'D-real-host-ready',
      host: 'codex',
      objective: 'Available real host should create its isolated worktree.',
      allowedPaths: ['packages/main/src/generated/real-host-ready.txt'],
    });
    const realHostRun = run<DispatchRunResult>('dispatch_run', { dispatchId: realHostReady.dispatchId });
    assert.equal(realHostRun.status, 'needs_receipt');
    assert.equal(existsSync(resolve(root, realHostReady.worktree.worktreePath)), true, 'available real-host scaffold should create the isolated worktree');
    assert.match(realHostRun.nextAction, new RegExp(realHostReady.worktree.worktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const realHostSymlinkEscape = run<DispatchRecord>('dispatch_prepare', {
      storyId: 'B-dispatch',
      dispatchId: 'D-real-host-symlink-escape',
      host: 'codex',
      objective: 'Real-host scaffold must not return needs_receipt when allowedPaths resolve outside the worktree.',
      allowedPaths: ['packages/main/src/generated/external-link/blocked-by-symlink.txt'],
      deniedPaths: ['README.md'],
    });
    const failedRealHostSymlinkEscape = run<DispatchRunResult>('dispatch_run', { dispatchId: realHostSymlinkEscape.dispatchId });
    assert.equal(failedRealHostSymlinkEscape.status, 'failed');
    assert.ok(
      failedRealHostSymlinkEscape.warnings.some(warning =>
        /canonical pack-path validation failed: .*resolves outside the isolated worktree via an existing symlinked path segment/i.test(warning)),
      'real-host symlink escape should surface canonical validation failure in warnings',
    );
    assert.match(failedRealHostSymlinkEscape.nextAction, /rolled back after canonical pack-path validation failed/i);
    assert.equal(existsSync(resolve(root, realHostSymlinkEscape.worktree.worktreePath)), false, 'real-host symlink escape must clean up the created worktree');
    assert.equal(existsSync(externalMarker), false, 'real-host symlink escape target must never be written');
    assert.equal(readDispatch(root, realHostSymlinkEscape.dispatchId).status, 'failed', 'real-host symlink escape must persist failed dispatch status');

    const realProjectedRootDispatchId = 'D-preexisting-root-symlink-real';
    const realProjectedRootExternalMarker = join(realProjectedRootExternalDir, 'packages/main/src/generated/preexisting-root-blocked.txt');
    seedProjectedDispatchWorktreeRootSymlink(root, 'B-dispatch', realProjectedRootDispatchId, realProjectedRootExternalDir);
    const realProjectedRootSymlink = run<DispatchRecord>('dispatch_prepare', {
      storyId: 'B-dispatch',
      dispatchId: realProjectedRootDispatchId,
      host: 'codex',
      objective: 'Real runtime must fail instead of returning needs_receipt when the projected worktree root is a symlink.',
      allowedPaths: ['packages/main/src/generated/preexisting-root-blocked.txt'],
      deniedPaths: ['README.md'],
    });
    const realProjectedRootRun = run<DispatchRunResult>('dispatch_run', { dispatchId: realProjectedRootSymlink.dispatchId });
    assert.notEqual(realProjectedRootRun.status, 'needs_receipt');
    assert.equal(realProjectedRootRun.status, 'failed');
    assert.ok(
      realProjectedRootRun.warnings.some(warning => isProjectedWorktreeContainmentFailure(warning)),
      'real projected-root symlink should surface canonical validation failure in warnings',
    );
    assert.match(realProjectedRootRun.nextAction, /Resolve the git worktree error, then rerun dispatch_run/i);
    assert.equal(existsSync(realProjectedRootExternalMarker), false, 'real projected-root symlink target must never receive allowed output');
    assert.deepEqual(readdirSync(realProjectedRootExternalDir), [], 'real projected-root symlink target must remain unused');
    assert.equal(readDispatch(root, realProjectedRootSymlink.dispatchId).status, 'failed', 'real projected-root symlink must persist failed dispatch status');

    const realAncestorDispatchId = 'D-ancestor-symlink-real';
    seedProjectedDispatchWorktreeAncestorSymlink(root, 'B-ancestor-attack', realAncestorExternalDir);
    const realAncestorSymlink = run<DispatchRecord>('dispatch_prepare', {
      storyId: 'B-ancestor-attack',
      dispatchId: realAncestorDispatchId,
      host: 'codex',
      objective: 'Real runtime must reject a symlinked projected worktree ancestor before returning needs_receipt.',
      allowedPaths: ['packages/main/src/generated/ancestor-blocked.txt'],
      deniedPaths: ['README.md'],
    });
    const realAncestorRun = run<DispatchRunResult>('dispatch_run', { dispatchId: realAncestorSymlink.dispatchId });
    assert.notEqual(realAncestorRun.status, 'needs_receipt');
    assert.equal(realAncestorRun.status, 'failed');
    assert.ok(
      realAncestorRun.warnings.some(warning => isProjectedWorktreeContainmentFailure(warning)),
      'real ancestor symlink should surface ancestry containment failure in warnings',
    );
    assert.match(realAncestorRun.nextAction, /Resolve the git worktree error, then rerun dispatch_run/i);
    assert.equal(existsSync(resolve(root, projectedDispatchWorktreePath(root, 'B-ancestor-attack', realAncestorDispatchId))), false, 'real ancestor symlink attack must not materialize a worktree path');
    assert.deepEqual(readdirSync(realAncestorExternalDir), [], 'real ancestor symlink target must remain unused');
    assert.equal(readDispatch(root, realAncestorSymlink.dispatchId).status, 'failed', 'real ancestor symlink must persist failed dispatch status');
    rmSync(projectedDispatchWorktreeStoryRoot(root, 'B-ancestor-attack'), { recursive: true, force: true });

    const realHostFailure = run<DispatchRecord>('dispatch_prepare', {
      storyId: 'B-dispatch',
      dispatchId: 'D-real-host-failure',
      host: 'codex',
      objective: 'Available real host should report worktree creation failure truthfully.',
      allowedPaths: ['packages/main/src/generated/real-host-failure.txt'],
    });
    git(root, ['branch', realHostFailure.worktree.branch, baseSha]);
    const failedRealHost = run<DispatchRunResult>('dispatch_run', { dispatchId: realHostFailure.dispatchId });
    assert.equal(failedRealHost.status, 'failed');
    assert.equal(existsSync(resolve(root, realHostFailure.worktree.worktreePath)), false, 'failed scaffold must not claim a created worktree');
    assert.ok(failedRealHost.warnings.some(warning => /Worktree creation failed:/i.test(warning)));
    assert.match(failedRealHost.nextAction, /could not create .*Resolve the git worktree error, then rerun dispatch_run/i);
  } finally {
    if (originalCodexSessionId === undefined) {
      delete process.env.CODEX_SESSION_ID;
    } else {
      process.env.CODEX_SESSION_ID = originalCodexSessionId;
    }
  }

  const originalPath = process.env.PATH;
  try {
    process.env.PATH = '/usr/bin:/bin';
    const unavailableProbe = run<HostRuntimeProbe>('host_runtime_probe', { host: 'gemini' });
    assert.equal(unavailableProbe.status, 'unavailable');
    assert.equal(unavailableProbe.runtimeKind, 'missing-cli');
    const beforeUnavailablePlanCount = dispatchCount(root);
    const unavailablePlan = run<DispatchPlanResult>('dispatch_plan', {
      storyId: 'B-dispatch',
      host: 'gemini',
      objective: 'Explicit unavailable host should produce a degraded plan only.',
    });
    assert.equal(unavailablePlan.status, 'unavailable');
    assert.equal(unavailablePlan.selectedHost, 'gemini');
    assert.equal(unavailablePlan.runtime.status, 'unavailable');
    assert.ok(unavailablePlan.risks.some(risk => /gemini runtime is unavailable/i.test(risk)));
    assert.ok(unavailablePlan.warnings.some(warning => /gemini CLI is not available/i.test(warning)));
    assert.equal(dispatchCount(root), beforeUnavailablePlanCount, 'unavailable dispatch_plan must not create dispatch records');
    const unavailableRun = run<DispatchRunResult>('dispatch_run', {
      storyId: 'B-dispatch',
      host: 'gemini',
      objective: 'Missing real host should degrade without worktree execution.',
    });
    assert.equal(unavailableRun.status, 'unavailable');
    const missingRecord = readDispatch(root, unavailableRun.dispatchId);
    assert.equal(existsSync(resolve(root, missingRecord.worktree.worktreePath)), false);
    assert.equal(existsSync(join(root, missingRecord.receiptFile)), false);
    assertAuthorityFalse(unavailableRun, 'unavailableRun');
  } finally {
    process.env.PATH = originalPath;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const cliPath = join(here, '..', 'cli.js');
  const cliProbe = JSON.parse(execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'lattice',
    'host',
    'runtime',
    'probe',
    '--host=fake',
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })) as HostRuntimeProbe;
  assert.equal(cliProbe.host, 'fake');
  assert.equal(cliProbe.status, 'ready');
  assertAuthorityFalse(cliProbe, 'cliProbe');

  console.log('✓ dispatch-run smoke passed — runtime probes, overflow gating, fake path hardening, real-host scaffolds, receipts, degradation paths, manual merge guidance, and authority invariants verified');
} finally {
  resetConfigCache();
  rmSync(root, { recursive: true, force: true });
  rmSync(sandboxRoot, { recursive: true, force: true });
  rmSync(externalDir, { recursive: true, force: true });
  rmSync(fakeProjectedRootExternalDir, { recursive: true, force: true });
  rmSync(realProjectedRootExternalDir, { recursive: true, force: true });
  rmSync(fakeAncestorExternalDir, { recursive: true, force: true });
  rmSync(realAncestorExternalDir, { recursive: true, force: true });
}
