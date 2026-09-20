#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { acquireOwnerLease } from '../core/story-owner-lease.js';
import type { ChecklistData, FindingData, StoryInfo } from '../core/types.js';
import { createFindingHandlers } from '../handlers/finding.js';
import { createVerifierHandlers } from '../handlers/verifier.js';

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

function commit(root: string, message: string): string {
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=proof-or-stop-implementer', 'commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function initRoot(): { root: string; store: StoryStore; storyId: string } {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-cluster-sync-'));
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    validate: { commands: [{
      label: 'cluster-sync-smoke',
      command: 'node',
      args: ['--version'],
      focus: ['cluster-sync-smoke'],
      timeoutMs: 15_000,
    }] },
  }, null, 2));
  write(root, 'README.md', 'cluster sync smoke\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  commit(root, 'base');
  const storyId = 'B-cluster';
  git(root, ['checkout', '-b', `story/${storyId}`]);
  write(root, 'packages/main/src/feature.ts', 'export const feature = true;\n');
  commit(root, `implement cluster fix\n\nResolves: CL-001 ${storyId}:F-002`);
  resetConfigCache();

  const store = new StoryStore(root);
  const now = '2026-05-08T10:00:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'cluster-sync-entrypoints',
    title: 'Cluster sync entrypoints',
    description: 'Synthetic story for cluster sync entrypoints.',
    type: 'chore',
    phase: 'DEV',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: now }],
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic item',
      context: 'Synthetic context',
      status: 'pending',
      startTime: now,
      endTime: now,
    }],
  };
  const findings: FindingData = {
    findings: [{
      id: `${storyId}:F-001`,
      desc: 'clustered finding',
      severity: 'high',
      category: 'happy',
      status: 'open',
      agent: 'proof-or-stop-review-quality',
      createdAt: now,
      reviewRound: now,
      _hash: 'smoke',
    }, {
      id: `${storyId}:F-002`,
      desc: 'direct finding',
      severity: 'medium',
      category: 'edge',
      status: 'open',
      agent: 'proof-or-stop-review-concept',
      createdAt: now,
      reviewRound: now,
      _hash: 'smoke',
    }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  store.writeFindings(storyId, findings);
  store.writeClusters(storyId, {
    clusters: [{
      clusterId: 'CL-001',
      rootCause: 'Synthetic cluster',
      severity: 'high',
      files: ['packages/main/src/feature.ts'],
      findingIds: [`${storyId}:F-001`],
      createdAt: now,
    }],
  });
  acquireOwnerLease(store.storyDirPath(storyId), { command: 'validate', cwd: root });
  return { root, store, storyId };
}

async function assertFindingListDoesNotSync(): Promise<void> {
  const { root, store, storyId } = initRoot();
  try {
    const handlers = createFindingHandlers({ store, root, scanRoot: join(root, 'packages/main') });
    handlers.finding_list({ storyId, cluster: true });
    const finding = store.readFindings(storyId).findings[0];
    assert.equal(finding.status, 'open', 'read-only finding_list must not consume a worker commit marker');
    assert.equal(finding.resolvedBy, undefined);
    const direct = store.readFindings(storyId).findings[1];
    assert.equal(direct.status, 'open', 'read-only finding_list must not consume a direct finding marker');
    assert.equal(direct.resolvedBy, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertOwnerValidateSyncsUnlessNoSync(): Promise<void> {
  const synced = initRoot();
  try {
    const handlers = createVerifierHandlers({
      store: synced.store,
      root: synced.root,
      scanRoot: join(synced.root, 'packages/main'),
    });
    assert.equal(synced.store.readFindings(synced.storyId).findings[0].status, 'open',
      'a repair-worker commit marker alone must leave cluster findings open');
    await handlers.validate({ story: synced.storyId, focus: 'cluster-sync-smoke', json: true, noSync: true });
    assert.equal(synced.store.readFindings(synced.storyId).findings[0].status, 'open', 'validate --noSync must not consume cluster markers');
    await handlers.validate({ story: synced.storyId, focus: 'cluster-sync-smoke', json: true });
    assert.equal(synced.store.readFindings(synced.storyId).findings[0].status, 'resolved', 'owner-gated validate --story should consume cluster markers');
    assert.equal(synced.store.readFindings(synced.storyId).findings[1].status, 'resolved', 'owner-gated validate --story should consume direct finding markers');
  } finally {
    rmSync(synced.root, { recursive: true, force: true });
  }
}

await assertFindingListDoesNotSync();
await assertOwnerValidateSyncsUnlessNoSync();

console.log('✓ cluster sync entrypoints smoke passed');
