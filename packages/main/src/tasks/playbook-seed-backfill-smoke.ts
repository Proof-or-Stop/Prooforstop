#!/usr/bin/env node
/**
 * @task B-5f5b
 * @checklist CHK-001
 * @title historical playbook seed backfill smoke
 * @type feature
 * @priority high
 * @description
 *   Proves historical seed backfill processes all deduped seeds by default,
 *   requires a fresh observeDigest for apply, converts only inert candidates,
 *   clears staged seed proposals, and writes no outcome evidence.
 * @changes
 *   - [CHK-001] Cover historical playbook seed backfill invariants with a smoke test.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { resolveProjectMemoryPath, writeEntries, type DevMemoryEntry } from '../core/dev-memory.js';
import {
  buildPlaybookSeedBackfillReport,
  buildPlaybookSeedObservation,
  buildPlaybookSeedProposalBatch,
} from '../core/playbook-seed.js';
import {
  listProposals,
  readPlaybookOutcomeEvents,
  readPlaybooks,
} from '../core/learning-store.js';
import { StoryStore } from '../core/store.js';
import type { StoryInfo } from '../core/types.js';

const NOW = '2026-07-03T00:00:00.000Z';
const STORY_ID = 'B-backfill';
const SEED_COUNT = 130;

let total = 0;
let passed = 0;

function check(label: string, fn: () => void): void {
  total += 1;
  try {
    fn();
    passed += 1;
    console.log(`check: ${label} - PASS`);
  } catch (err) {
    console.error(`check: ${label} - FAIL`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  }
}

function write(root: string, rel: string, content: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

function mkProject(): { root: string; store: StoryStore } {
  const root = mkdtempSync(join(tmpdir(), 'b5f5b-seed-backfill-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
  }, null, 2));
  return { root, store: new StoryStore(root) };
}

function story(): StoryInfo {
  return {
    storyId: STORY_ID,
    name: STORY_ID,
    title: 'Backfill all historical seeds',
    description: 'Synthetic backfill smoke story.',
    type: 'feature',
    phase: 'DONE',
    priority: 'high',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: NOW,
    events: [{ phase: 'DONE', action: 'advance', timestamp: NOW }],
  };
}

function memoryEntry(index: number): DevMemoryEntry {
  const suffix = String(index).padStart(3, '0');
  return {
    id: `mem-backfill-${suffix}`,
    createdAt: NOW,
    sourceAgent: 'playbook-seed-backfill-smoke',
    category: 'workflow',
    scope: 'project',
    summary: `Historical seed ${suffix} has explicit lineage.`,
    trigger: 'B-5f5b historical backfill smoke',
    lesson: `Backfill lesson ${suffix} should become candidate material only.`,
    reusePrompt: 'Use playbook_seed_backfill to convert deduped history into inert candidates.',
    sourceStoryId: STORY_ID,
    evidenceRefs: [`${STORY_ID}:F-${suffix}`],
    tags: ['playbook-backfill'],
    gateEvidence: false,
    authority: 'non_authoritative',
  };
}

function seed(root: string, store: StoryStore): void {
  store.writeStory(STORY_ID, story());
  store.writeChecklist(STORY_ID, { items: [] });
  store.writeFindings(STORY_ID, { findings: [] });
  for (let i = 1; i <= SEED_COUNT; i += 1) {
    const suffix = String(i).padStart(3, '0');
    write(root, `packages/main/src/backfill-${suffix}.ts`, `export const backfill${suffix} = true;\n`);
  }
  writeEntries(resolveProjectMemoryPath(root), Array.from({ length: SEED_COUNT }, (_, index) => memoryEntry(index + 1)));
}

function appendExtraMemory(root: string): void {
  writeEntries(resolveProjectMemoryPath(root), [
    ...Array.from({ length: SEED_COUNT }, (_, index) => memoryEntry(index + 1)),
    {
      ...memoryEntry(SEED_COUNT + 1),
      id: 'mem-backfill-extra',
      summary: 'Extra historical seed makes the prior digest stale.',
    },
  ]);
}

function withIsolatedGlobalMemory<T>(root: string, fn: () => T): T {
  const prior = process.env.LATTICE_GLOBAL_MEMORY_DIR;
  process.env.LATTICE_GLOBAL_MEMORY_DIR = join(root, 'global-memory');
  mkdirSync(process.env.LATTICE_GLOBAL_MEMORY_DIR, { recursive: true });
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.LATTICE_GLOBAL_MEMORY_DIR;
    else process.env.LATTICE_GLOBAL_MEMORY_DIR = prior;
  }
}

const roots: string[] = [];

try {
  check('backfill all seeds, clean proposals/outcomes, and repeat idempotently', () => {
    const { root, store } = mkProject();
    roots.push(root);
    seed(root, store);

    withIsolatedGlobalMemory(root, () => {
    const staleObserve = buildPlaybookSeedObservation({ projectRoot: root, store, now: NOW });
    assert.equal(staleObserve.proposableSeeds.length, SEED_COUNT);
    appendExtraMemory(root);
    assert.throws(
      () => buildPlaybookSeedBackfillReport({
        projectRoot: root,
        store,
        apply: true,
        observeDigest: staleObserve.observeDigest,
        now: NOW,
      }),
      /observeDigest drift/,
    );

    const observeForProposal = buildPlaybookSeedObservation({ projectRoot: root, store, now: NOW });
    buildPlaybookSeedProposalBatch({
      projectRoot: root,
      store,
      apply: true,
      limit: 1,
      observeDigest: observeForProposal.observeDigest,
      now: NOW,
    });
    assert.equal(listProposals(root).length, 1, 'pre-staged proposal exists');

    const currentObserve = buildPlaybookSeedObservation({ projectRoot: root, store, now: NOW });
    const dryRun = buildPlaybookSeedBackfillReport({ projectRoot: root, store, now: NOW });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.plannedCount, SEED_COUNT + 1);
    assert.equal(dryRun.limit, null);
    assert.equal(readPlaybooks(root).length, 0, 'dry-run writes no candidates');

    const applied = buildPlaybookSeedBackfillReport({
      projectRoot: root,
      store,
      apply: true,
      observeDigest: currentObserve.observeDigest,
      now: NOW,
    });
    assert.equal(applied.applied, true);
    assert.equal(applied.createdCount, SEED_COUNT + 1);
    assert.equal(applied.deletedProposalCount, 1);
    assert.equal(applied.blockedCount, 0);
    assert.equal(listProposals(root).length, 0, 'staged proposal was deleted');
    const playbooks = readPlaybooks(root);
    assert.equal(playbooks.length, SEED_COUNT + 1);
    assert.equal(new Set(playbooks.map((playbook) => playbook.id)).size, SEED_COUNT + 1);
    assert.equal(playbooks.every((playbook) => playbook.status === 'candidate'), true);
    assert.equal(readPlaybookOutcomeEvents(root).length, 0, 'backfill writes no outcomes');

    const repeatObserve = buildPlaybookSeedObservation({ projectRoot: root, store, now: NOW });
    const repeat = buildPlaybookSeedBackfillReport({
      projectRoot: root,
      store,
      apply: true,
      observeDigest: repeatObserve.observeDigest,
      now: NOW,
    });
    assert.equal(repeat.createdCount, 0);
    assert.equal(repeat.alreadyRepresentedCount, SEED_COUNT + 1);
    assert.equal(readPlaybooks(root).length, SEED_COUNT + 1, 'repeat creates no duplicates');
    assert.equal(readPlaybookOutcomeEvents(root).length, 0, 'repeat writes no outcomes');
    });
  });
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

if (process.exitCode) {
  console.error(`playbook seed backfill smoke failed: ${passed}/${total} checks passed`);
  process.exit(process.exitCode);
}

console.log(`playbook seed backfill smoke passed: ${passed}/${total} checks`);
