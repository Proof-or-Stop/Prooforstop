#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import {
  createHandoffPack,
  inspectHandoffPack,
  type HandoffInspection,
  type HandoffPack,
} from '../core/lattice-handoff.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { MAIN_TOOLS } from '../cli-engine.js';
import { createMainRegistry } from '../registry.js';

function writeConfig(root: string): void {
  writeFileSync(join(root, 'koala.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: 'Docs/story/actives',
  }, null, 2));
}

function seedStory(store: StoryStore): void {
  const now = '2026-06-02T00:00:00.000Z';
  const story: StoryInfo = {
    storyId: 'B-handoff',
    name: 'handoff-smoke',
    title: 'Handoff smoke story',
    description: 'Smoke story for Lattice handoff packs.',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: now, branch: 'story/B-handoff' }],
  };
  const checklist: ChecklistData = {
    items: [
      {
        id: 'CHK-001',
        title: 'Produce local evidence',
        status: 'done',
        startTime: now,
        endTime: now,
        verificationEvidence: [{
          intentRef: 'CHK-001:happy:0',
          kind: 'integration_test',
          command: 'npm run test:lattice-handoff-smoke',
          result: 'pass',
          note: 'Handoff smoke evidence.',
          timestamp: now,
        }],
      },
    ],
  };
  store.writeStory('B-handoff', story);
  store.writeChecklist('B-handoff', checklist);
}

function assertHandoffPack(pack: HandoffPack): void {
  assert.equal(pack.schemaVersion, 'handoff-pack-v0');
  assert.equal(pack.storyId, 'B-handoff');
  assert.equal(pack.fromHost, 'codex');
  assert.equal(pack.toHost, 'claude-code');
  assert.equal(pack.productionDone, false, 'handoff top-level cannot claim productionDone');
  assert.deepEqual(pack.receiptRefs, [], 'handoff top-level cannot carry receipt refs as authority');
  assert.equal(pack.canonicalStory.lifecycle.productionDone, false, 'embedded canonical story has no productionDone without receipt refs');
  assert.ok(pack.evidenceRefs.includes('CHK-001:happy:0'), 'evidence refs are preserved');
  assert.ok(pack.capabilityDeltas.some(delta => delta.capability === 'patch-apply' && delta.changed), 'capability deltas capture source/target differences');
  assert.ok(pack.degradations.some(d => d.host === 'claude-code' && d.capability === 'receipt-verify' && d.authorityImpact === 'blocks-production-done'), 'target receipt verification degradation is visible');
  assert.equal(pack.recoveryPoint.kind, 'handoff-pack');
  assert.equal(pack.recoveryPoint.storyId, 'B-handoff');
  assert.equal((pack as unknown as Record<string, unknown>).authorityDone, undefined);
}

function assertInspection(inspection: HandoffInspection): void {
  assert.equal(inspection.schemaVersion, 'koala.handoff_inspect.v1');
  assert.equal(inspection.storyId, 'B-handoff');
  assert.equal(inspection.fromHost, 'codex');
  assert.equal(inspection.toHost, 'claude-code');
  assert.equal(inspection.productionDone, false);
  assert.deepEqual(inspection.receiptRefs, []);
  assert.equal(inspection.authority.handoffCanManufactureProductionDone, false);
  assert.ok(inspection.capabilityDeltaCount > 0);
  assert.ok(inspection.blockingDegradationCount > 0);
}

const root = mkdtempSync(join(tmpdir(), 'koala-lattice-handoff-'));
try {
  writeConfig(root);
  resetConfigCache();
  const store = new StoryStore(root);
  seedStory(store);

  const pack = createHandoffPack(store, root, { storyId: 'B-handoff', fromHost: 'codex', toHost: 'claude-code' });
  assertHandoffPack(pack);
  assertInspection(inspectHandoffPack(pack));

  assert.ok(MAIN_TOOLS.some(tool => tool.name === 'handoff_create'), 'MAIN_TOOLS exposes handoff_create');
  assert.ok(MAIN_TOOLS.some(tool => tool.name === 'handoff_inspect'), 'MAIN_TOOLS exposes handoff_inspect');
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  const registry = createMainRegistry(ctx);
  assert.equal(registry.has('handoff_create'), true, 'registry exposes handoff_create handler');
  assert.equal(registry.has('handoff_inspect'), true, 'registry exposes handoff_inspect handler');
  assertHandoffPack(registry.get('handoff_create')!({
    storyId: 'B-handoff',
    fromHost: 'codex',
    toHost: 'claude-code',
    format: 'json',
  }) as HandoffPack);

  const here = dirname(fileURLToPath(import.meta.url));
  const cliPath = join(here, '..', 'cli.js');
  const stdout = execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'handoff_create',
    '--storyId=B-handoff',
    '--fromHost=codex',
    '--toHost=claude-code',
    '--format=json',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assertHandoffPack(JSON.parse(stdout) as HandoffPack);

  const outputPath = join(root, 'handoff.json');
  execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'handoff_create',
    '--storyId=B-handoff',
    '--fromHost=codex',
    '--toHost=claude-code',
    `--output=${outputPath}`,
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assertHandoffPack(JSON.parse(readFileSync(outputPath, 'utf8')) as HandoffPack);

  const inspectStdout = execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'handoff_inspect',
    `--file=${outputPath}`,
    '--format=json',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assertInspection(JSON.parse(inspectStdout) as HandoffInspection);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('✓ lattice handoff smoke passed');
