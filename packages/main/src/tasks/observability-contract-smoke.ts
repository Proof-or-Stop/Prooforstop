#!/usr/bin/env node
/**
 * @task B-381e
 * @checklist CHK-003
 * @title observability projection/snapshot contract smoke
 * @type chore
 * @priority high
 * @description
 *   Contract smoke for the host-neutral observability surface. It proves
 *   `observability_snapshot` is registered as an L0 read-only diagnostic, keeps
 *   local assurance claims read-only, and does not depend on
 *   parsing status/session Markdown or touching the terminal dashboard UI.
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
import { resolveLocalAssuranceStories } from '../core/local-assurance-story-projection.js';
import { buildObservabilitySnapshot } from '../core/observability-snapshot.js';

const COMMANDS = ['observability_snapshot'] as const;
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
    assert.match(fact.rationale, /without mutating|without parsing|local assurance|read-only/i, `${command} rationale documents read-only boundary`);
  }
}

function writeConfig(root: string): void {
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
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
  const root = mkdtempSync(join(tmpdir(), 'lattice-observability-contract-'));
  try {
    writeConfig(root);
    resetConfigCache();
    const store = new StoryStore(root);
    seedStory(store);

    const projection = resolveLocalAssuranceStories(store, root, { now: NOW });
    assert.equal(projection.readOnly, true);
    assert.equal(projection.stories.length, 1);

    const snapshot = buildObservabilitySnapshot(store, root, {
      projection,
      storeFactory: () => store,
      now: NOW,
    });
    assert.equal(snapshot.readOnly, true);
    assert.equal(snapshot.localAssurance.admissibilityStatus, 'local-only');
    assert.equal(snapshot.localAssurance.assuranceLevel, 'local-observation');
    assert.equal(snapshot.localAssurance.evidenceScope, 'read-only-observability');
    assert.equal(snapshot.sections.storyBoard[0]?.releaseReady, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertSourceBoundaries(): void {
  const projectionSource = readFileSync(join(packageRoot, 'src/core/local-assurance-story-projection.ts'), 'utf8');
  const snapshotSource = readFileSync(join(packageRoot, 'src/core/observability-snapshot.ts'), 'utf8');
  const snapshotHandlerSource = readFileSync(join(packageRoot, 'src/handlers/observability-snapshot.ts'), 'utf8');
  const dashboardSource = readFileSync(join(packageRoot, 'src/dashboard.ts'), 'utf8');

  const combinedCore = `${projectionSource}\n${snapshotSource}`;
  assert.doesNotMatch(combinedCore, /\bsession_brief\s*\(/, 'projection/snapshot core must not call session_brief');
  assert.doesNotMatch(combinedCore, /\bstatus\s*\(/, 'projection/snapshot core must not call status');
  assert.doesNotMatch(snapshotSource, /readFileSync|\.lattice\/story|docs\/story/, 'snapshot adapter must not directly read backing story JSON');
  assert.doesNotMatch(snapshotHandlerSource, /\.lattice\/story|docs\/story/, 'snapshot handler must not directly read backing story JSON');
  const retiredStoryProjectionCommand = ['story', 'authority', 'resolve'].join('_');
  assert.doesNotMatch(dashboardSource, new RegExp(`${retiredStoryProjectionCommand}|observability_snapshot`), 'M1 must not wire the terminal dashboard UI');
}

assertPolicyContracts();
assertNoOverclaim();
assertSourceBoundaries();

console.log('✓ observability contract smoke passed');
