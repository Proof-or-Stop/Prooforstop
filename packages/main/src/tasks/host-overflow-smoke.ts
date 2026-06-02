#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import {
  createHandoffPack,
  type HandoffPack,
  type HandoffReceipt,
  type HandoffReceiptSubmission,
  type HandoffWorktreeProjection,
  type HostDispatchProjection,
} from '../core/lattice-handoff.js';
import { buildLatticeHostStatus, type LatticeHostStatus } from '../core/lattice-hosts.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { MAIN_TOOLS } from '../cli-engine.js';
import { createMainRegistry } from '../registry.js';

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
    storyDir: 'Docs/story/actives',
  }, null, 2));
}

function initRepo(root: string): void {
  mkdirSync(join(root, 'packages/main/src/core'), { recursive: true });
  writeFileSync(join(root, 'packages/main/src/core/worker.ts'), 'export const worker = "host-overflow";\n');
  writeFileSync(join(root, 'README.md'), '# host overflow fixture\n');
  writeConfig(root);
  git(root, ['init']);
  git(root, ['config', 'user.email', 'koala@example.com']);
  git(root, ['config', 'user.name', 'Koala Smoke']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);
}

function seedStory(store: StoryStore): void {
  const now = '2026-06-02T00:00:00.000Z';
  const story: StoryInfo = {
    storyId: 'B-overflow',
    name: 'host-overflow-smoke',
    title: 'Host overflow smoke story',
    description: 'Smoke story for Lattice Host Overflow.',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: now, branch: 'story/B-overflow' }],
  };
  const checklist: ChecklistData = {
    items: [
      {
        id: 'CHK-001',
        title: 'Manual-first overflow',
        status: 'done',
        startTime: now,
        endTime: now,
      },
    ],
  };
  store.writeStory('B-overflow', story);
  store.writeChecklist('B-overflow', checklist);
}

function assertClaudeCodeStatus(result: LatticeHostStatus): void {
  assert.equal(result.schemaVersion, 'lattice.host_status.v1');
  assert.equal(result.host, 'claude-code');
  assert.equal(result.overflowReady, true);
  assert.ok(result.status === 'ready' || result.status === 'degraded');
  assert.equal(result.productionDone, false);
  assert.equal(result.receiptVerified, false);
  assert.equal(result.readiness.edit, 'available');
  assert.equal(result.readiness.shell, 'available');
  assert.equal(result.readiness.test, 'available');
  assert.equal(result.readiness.receipt, 'local-only');
  assert.ok(result.nextAction.length > 0);
}

function assertPack(pack: HandoffPack, head: string): void {
  assert.equal(pack.storyId, 'B-overflow');
  assert.equal(pack.fromHost, 'codex');
  assert.equal(pack.toHost, 'claude-code');
  assert.equal(pack.baseSha, head);
  assert.match(pack.packId, /^HP-[a-f0-9]{12}$/);
  assert.match(pack.packHash, /^sha256:/);
  assert.equal(pack.role, 'overflow-worker');
  assert.equal(pack.objective, 'Implement bounded host overflow changes only.');
  assert.deepEqual(pack.allowedPaths, ['packages/main/src/core/worker.ts']);
  assert.deepEqual(pack.deniedPaths, ['README.md']);
  assert.deepEqual(pack.requiredCommands, ['npm --prefix packages/main run build']);
  assert.deepEqual(pack.successCriteria, ['Do not claim production authority']);
  assert.equal(pack.authorityBoundary.noAutoTrust, true);
  assert.equal(pack.authorityBoundary.noAutoMerge, true);
  assert.ok(pack.executionInstructions.some(step => /Do not auto-merge/i.test(step)));
}

const root = mkdtempSync(join(tmpdir(), 'koala-host-overflow-'));
try {
  initRepo(root);
  resetConfigCache();
  const store = new StoryStore(root);
  seedStory(store);
  const head = git(root, ['rev-parse', 'HEAD']);

  const claudeStatus = buildLatticeHostStatus('claude-code');
  assertClaudeCodeStatus(claudeStatus);
  const runnerStatus = buildLatticeHostStatus('local-runner');
  assert.equal(runnerStatus.status, 'unavailable');
  assert.equal(runnerStatus.overflowReady, false);
  assert.match(runnerStatus.nextAction, /choose claude-code or codex/i);

  const pack = createHandoffPack(store, root, {
    storyId: 'B-overflow',
    fromHost: 'codex',
    toHost: 'claude-code',
    role: 'overflow-worker',
    objective: 'Implement bounded host overflow changes only.',
    allowedPaths: ['packages/main/src/core/worker.ts'],
    deniedPaths: ['README.md'],
    requiredCommands: ['npm --prefix packages/main run build'],
    successCriteria: ['Do not claim production authority'],
  });
  assertPack(pack, head);

  assert.ok(MAIN_TOOLS.some(tool => tool.name === 'host_status'));
  assert.ok(MAIN_TOOLS.some(tool => tool.name === 'handoff_receipt_submit'));
  assert.ok(MAIN_TOOLS.some(tool => tool.name === 'handoff_worktree_create'));
  assert.ok(MAIN_TOOLS.some(tool => tool.name === 'host_dispatch'));
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  const registry = createMainRegistry(ctx);
  assert.equal(registry.has('host_status'), true);
  assert.equal(registry.has('handoff_receipt_submit'), true);
  assert.equal(registry.has('handoff_worktree_create'), true);
  assert.equal(registry.has('host_dispatch'), true);
  assertClaudeCodeStatus(registry.get('host_status')!({ host: 'claude-code', format: 'json' }) as LatticeHostStatus);

  const here = dirname(fileURLToPath(import.meta.url));
  const cliPath = join(here, '..', 'cli.js');
  const packPath = join(root, 'handoff-pack.json');
  writeFileSync(packPath, JSON.stringify(pack, null, 2) + '\n', 'utf8');

  const worktree = JSON.parse(execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'handoff_worktree_create',
    `--file=${packPath}`,
    '--format=json',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })) as HandoffWorktreeProjection;
  assert.equal(worktree.schemaVersion, 'lattice.handoff_worktree_create.v1');
  assert.equal(worktree.status, 'projected');
  assert.equal(worktree.created, false);
  assert.equal(worktree.authorityChanged, false);
  assert.equal(worktree.productionDone, false);
  assert.equal(worktree.constraintStatus, 'pass');
  assert.match(worktree.branch, /^overflow\/B-overflow\/HP-/);
  assert.match(worktree.worktreePath, /^\.worktrees\/overflow\/B-overflow\/HP-/);
  assert.match(worktree.cleanupCommand, /git worktree remove/);

  const plannedDispatch = JSON.parse(execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'host_dispatch',
    '--host=claude-code',
    `--file=${packPath}`,
    '--mode=supervised',
    '--format=json',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })) as HostDispatchProjection;
  assert.equal(plannedDispatch.schemaVersion, 'lattice.host_dispatch.v1');
  assert.equal(plannedDispatch.status, 'planned');
  assert.equal(plannedDispatch.overflowReady, true);
  assert.equal(plannedDispatch.authorityChanged, false);
  assert.equal(plannedDispatch.productionDone, false);
  assert.match(plannedDispatch.nextAction, /planned only/i);

  const unavailableDispatch = registry.get('host_dispatch')!({
    host: 'local-runner',
    file: packPath,
    mode: 'supervised',
    format: 'json',
  }) as HostDispatchProjection;
  assert.equal(unavailableDispatch.status, 'unavailable');
  assert.equal(unavailableDispatch.overflowReady, false);

  const goodReceipt: HandoffReceipt = {
    schemaVersion: 'lattice.handoff_receipt.v1',
    storyId: pack.storyId,
    host: 'claude-code',
    packId: pack.packId,
    packHash: pack.packHash,
    fromHost: pack.fromHost,
    toHost: pack.toHost,
    baseSha: pack.baseSha,
    role: pack.role,
    objective: pack.objective,
    allowedPaths: pack.allowedPaths,
    deniedPaths: pack.deniedPaths,
    requiredCommands: pack.requiredCommands,
    successCriteria: pack.successCriteria,
    authorityBoundary: pack.authorityBoundary,
    executionInstructions: pack.executionInstructions,
    headSha: head,
    changedFiles: ['packages/main/src/core/worker.ts'],
    commands: ['npm --prefix packages/main run build'],
    verdict: 'pass',
    summary: 'Overflow worker completed a bounded code change.',
    limitations: [],
  };
  const goodReceiptPath = join(root, 'receipt-good.json');
  writeFileSync(goodReceiptPath, JSON.stringify(goodReceipt, null, 2) + '\n', 'utf8');
  const accepted = JSON.parse(execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'handoff_receipt_submit',
    `--file=${goodReceiptPath}`,
    '--format=json',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })) as HandoffReceiptSubmission;
  assert.equal(accepted.status, 'accepted-local');
  assert.equal(accepted.scopeStatus, 'pass');
  assert.equal(accepted.freshness, 'fresh');
  assert.equal(accepted.receiptVerified, false);
  assert.equal(accepted.productionDone, false);

  const badReceiptPath = join(root, 'receipt-bad.json');
  writeFileSync(badReceiptPath, JSON.stringify({
    ...goodReceipt,
    packHash: 'sha256:tampered',
    changedFiles: ['README.md'],
    limitations: ['tampered for smoke'],
  }, null, 2) + '\n', 'utf8');
  const rejected = registry.get('handoff_receipt_submit')!({
    file: badReceiptPath,
    format: 'json',
  }) as HandoffReceiptSubmission;
  assert.equal(rejected.status, 'diagnostic');
  assert.equal(rejected.validations.packHash, 'fail');
  assert.equal(rejected.scopeStatus, 'fail');

  writeFileSync(join(root, 'packages/main/src/core/worker.ts'), 'export const worker = "host-overflow-stale";\n');
  git(root, ['add', 'packages/main/src/core/worker.ts']);
  git(root, ['commit', '-m', 'stale']);
  const staleReceiptPath = join(root, 'receipt-stale.json');
  writeFileSync(staleReceiptPath, JSON.stringify(goodReceipt, null, 2) + '\n', 'utf8');
  const stale = JSON.parse(execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'handoff_receipt_submit',
    `--file=${staleReceiptPath}`,
    '--format=json',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })) as HandoffReceiptSubmission;
  assert.equal(stale.status, 'diagnostic');
  assert.equal(stale.freshness, 'stale');
  assert.ok(stale.warnings.some(warning => /materialhash|HEAD/i.test(warning)));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('✓ host overflow smoke passed');
