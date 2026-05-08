#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
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
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=koala-implementer', 'commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function initRoot(): { root: string; store: StoryStore; storyId: string } {
  const root = mkdtempSync(join(tmpdir(), 'koala-cluster-sync-'));
  write(root, 'koala.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
  }, null, 2));
  write(root, 'README.md', 'cluster sync smoke\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  commit(root, 'base');
  const storyId = 'B-cluster';
  git(root, ['checkout', '-b', `story/${storyId}`]);
  write(root, 'packages/main/src/feature.ts', 'export const feature = true;\n');
  commit(root, 'implement cluster fix\n\nResolves: CL-001');
  resetConfigCache();

  const store = new StoryStore(root);
  const now = '2026-05-08T10:00:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'cluster-sync-entrypoints',
    title: 'Cluster sync entrypoints',
    description: 'Synthetic story for cluster sync entrypoints.',
    type: 'chore',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: now }],
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic item',
      context: 'Synthetic context',
      status: 'done',
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
      agent: 'koala-review-quality',
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
  return { root, store, storyId };
}

async function assertFindingListSyncs(): Promise<void> {
  const { root, store, storyId } = initRoot();
  try {
    const handlers = createFindingHandlers({ store, root, scanRoot: join(root, 'packages/main') });
    handlers.finding_list({ storyId, cluster: true });
    const finding = store.readFindings(storyId).findings[0];
    assert.equal(finding.status, 'resolved');
    assert.match(finding.resolvedBy ?? '', /^CL-001@/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertValidateSyncsUnlessNoSync(): Promise<void> {
  const synced = initRoot();
  try {
    const handlers = createVerifierHandlers({
      store: synced.store,
      root: synced.root,
      scanRoot: join(synced.root, 'packages/main'),
    });
    await handlers.validate({ story: synced.storyId, json: true, noSync: true });
    assert.equal(synced.store.readFindings(synced.storyId).findings[0].status, 'open', 'noSync should skip commit auto-resolve');
    await handlers.validate({ story: synced.storyId, json: true });
    assert.equal(synced.store.readFindings(synced.storyId).findings[0].status, 'resolved', 'validate --story should sync cluster resolves');
  } finally {
    rmSync(synced.root, { recursive: true, force: true });
  }
}

await assertFindingListSyncs();
await assertValidateSyncsUnlessNoSync();

console.log('✓ cluster sync entrypoints smoke passed');
