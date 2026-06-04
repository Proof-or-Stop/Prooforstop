#!/usr/bin/env node
/**
 * @task B-381e
 * @checklist CHK-003
 * @title observability resolver/snapshot contract smoke
 * @type chore
 * @priority high
 * @description
 *   Contract smoke for the host-neutral observability M1 surfaces. It proves
 *   `story_authority_resolve` and `observability_snapshot` are registered as
 *   L0 read-only diagnostics, keep authority fields conservative, and do not
 *   depend on parsing status/session Markdown or touching the terminal
 *   dashboard UI.
 * @changes
 *   - [CHK-001] Use validator-accepted task type metadata for the observability contract smoke.
 *   - [CHK-002] Add validator-required changes metadata for convergence checking.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_POLICIES } from '../core/command-policy.js';
import { PROCESS_FACT_LEVELS } from '../core/process-fact-levels.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { StoryInfo } from '../core/types.js';
import { resolveStoryAuthority } from '../core/story-authority-resolver.js';
import { buildObservabilitySnapshot } from '../core/observability-snapshot.js';

const COMMANDS = ['story_authority_resolve', 'observability_snapshot'] as const;
const NOW = '2026-06-03T00:00:00.000Z';
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function assertPolicyContracts(): void {
  for (const command of COMMANDS) {
    const policy = COMMAND_POLICIES[command];
    assert.ok(policy, `${command} has command policy`);
    assert.equal(policy.status, 'supported', `${command} is supported`);
    assert.equal(policy.ownershipClass, 'readOnly', `${command} ownershipClass`);
    assert.equal(policy.allowedPhases, 'all', `${command} allowedPhases`);
    assert.equal(policy.destructiveRisk, 'none', `${command} destructiveRisk`);

    const fact = PROCESS_FACT_LEVELS.find((entry) => entry.name === command);
    assert.ok(fact, `${command} has process fact registration`);
    assert.equal(fact.level, 'L0', `${command} process fact level`);
    assert.match(fact.rationale, /without mutating|without parsing|without.*authority/i, `${command} rationale documents read-only boundary`);
  }
}

function writeConfig(root: string): void {
  writeFileSync(join(root, 'koala.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.koala/story/actives',
  }, null, 2) + '\n');
}

function seedStory(store: StoryStore): void {
  const story: StoryInfo = {
    storyId: 'B-contract',
    name: 'observability-contract',
    title: 'Observability contract story',
    description: 'Seed story for observability contract smoke.',
    type: 'feature',
    phase: 'DEV',
    priority: 'medium',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
  };
  store.writeStory(story.storyId, story);
  store.writeChecklist(story.storyId, {
    items: [{
      id: 'CHK-001',
      title: 'Seed item',
      context: 'Seed context',
      status: 'pending',
      startTime: null,
      endTime: null,
    }],
  });
}

function assertNoOverclaim(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-observability-contract-'));
  try {
    writeConfig(root);
    resetConfigCache();
    const store = new StoryStore(root);
    seedStory(store);

    const resolver = resolveStoryAuthority(store, root, { now: NOW });
    assert.equal(resolver.readOnly, true);
    assert.equal(resolver.productionDone, false);
    assert.equal(resolver.receiptVerified, false);
    assert.equal(resolver.authorityChanged, false);
    assert.equal(resolver.stories.length, 1);

    const snapshot = buildObservabilitySnapshot(store, root, {
      resolver,
      storeFactory: () => store,
      now: NOW,
    });
    assert.equal(snapshot.readOnly, true);
    assert.equal(snapshot.authority.productionDone, false);
    assert.equal(snapshot.authority.receiptVerified, false);
    assert.equal(snapshot.authority.authorityChanged, false);
    assert.equal(snapshot.sections.storyBoard[0]?.productionDone, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertSourceBoundaries(): void {
  const resolverSource = readFileSync(join(packageRoot, 'src/core/story-authority-resolver.ts'), 'utf8');
  const snapshotSource = readFileSync(join(packageRoot, 'src/core/observability-snapshot.ts'), 'utf8');
  const snapshotHandlerSource = readFileSync(join(packageRoot, 'src/handlers/observability-snapshot.ts'), 'utf8');
  const dashboardSource = readFileSync(join(packageRoot, 'src/dashboard.ts'), 'utf8');

  const combinedCore = `${resolverSource}\n${snapshotSource}`;
  assert.doesNotMatch(combinedCore, /\bsession_brief\s*\(/, 'resolver/snapshot core must not call session_brief');
  assert.doesNotMatch(combinedCore, /\bstatus\s*\(/, 'resolver/snapshot core must not call status');
  assert.doesNotMatch(snapshotSource, /readFileSync|\.koala\/story|docs\/story/, 'snapshot adapter must not directly read backing story JSON');
  assert.doesNotMatch(snapshotHandlerSource, /\.koala\/story|docs\/story/, 'snapshot handler must not directly read backing story JSON');
  assert.doesNotMatch(dashboardSource, /story_authority_resolve|observability_snapshot/, 'M1 must not wire the terminal dashboard UI');
}

assertPolicyContracts();
assertNoOverclaim();
assertSourceBoundaries();

console.log('✓ observability contract smoke passed');
