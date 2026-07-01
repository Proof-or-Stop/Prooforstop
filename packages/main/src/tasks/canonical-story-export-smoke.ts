#!/usr/bin/env node

/**
 * @task B-3b99
 * @checklist CHK-002
 * @title Smoke canonical story local assurance export
 * @type chore
 * @priority high
 * @description
 *   Smoke-backed evidence that canonical story export keeps local DONE separate
 *   from productionDone and surfaces local assurance gaps as visible
 *   degradations. This maps localOnly / requiresAuthorityReceipt intent to
 *   local-assurance-incomplete with authorityImpact blocks-production-done,
 *   without reintroducing Authority Server receipt behavior.
 * @changes
 *   - [CHK-002] Assert lifecycle.productionDone stays false for local DONE.
 *   - [CHK-002] Assert local-assurance-incomplete is exported with authorityImpact blocks-production-done.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCanonicalStory, type CanonicalStory } from '../core/canonical-story.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo, VerificationEvidence } from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { MAIN_TOOLS } from '../cli-engine.js';
import { createMainRegistry } from '../registry.js';

const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'storyId',
  'title',
  'lifecycle',
  'checklist',
  'evidence',
  'reviews',
  'authority',
  'degradations',
  'lineage',
] as const;

function writeConfig(root: string): void {
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: 'Docs/story/actives',
  }, null, 2));
}

function seedStory(store: StoryStore): void {
  const now = '2026-06-02T00:00:00.000Z';
  const localReceiptEvidence: VerificationEvidence & { receiptRef: string; receiptRefs: string[] } = {
    intentRef: 'CHK-001:happy:0',
    kind: 'integration_test',
    command: 'npm run test:canonical-story-export-smoke',
    result: 'pass',
    note: 'Smoke command passed.',
    headHash: 'abc123',
    materialHash: 'mat123',
    timestamp: now,
    receiptRef: 'local-receipt-ref',
    receiptRefs: ['diagnostic-receipt-ref'],
  };
  const story: StoryInfo = {
    storyId: 'B-test',
    name: 'canonical-export-smoke',
    title: 'Canonical export smoke story',
    description: 'Smoke story for Canonical Story v0 export.',
    type: 'feature',
    phase: 'DONE',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: now,
    events: [{ phase: 'DONE', action: 'advance', timestamp: now, branch: 'story/B-test' }],
  };
  const checklist: ChecklistData = {
    items: [
      {
        id: 'CHK-001',
        title: 'Run smoke command',
        status: 'done',
        startTime: now,
        endTime: now,
        verificationIntent: {
          happy: [{ desc: 'CLI command passes', type: 'cli' }],
          edge: [],
          adversarial: [],
        },
        verificationEvidence: [localReceiptEvidence],
      },
    ],
  };
  store.writeStory('B-test', story);
  store.writeChecklist('B-test', checklist);
  store.writeReview('B-test', { reviews: [] });
}

function assertCanonicalShape(story: CanonicalStory): void {
  assert.deepEqual(Object.keys(story).sort(), [...TOP_LEVEL_KEYS].sort(), 'canonical story top-level keys match schema contract');
  assert.equal(story.schemaVersion, 'canonical-story-v0');
  assert.equal(story.storyId, 'B-test');
  assert.equal(story.lifecycle.localDone, true);
  assert.equal(story.lifecycle.productionDone, false, 'local DONE does not establish release readiness without verified receipt artifacts');
  assert.equal(story.authority.tier, 'local-evidence');
  assert.deepEqual(story.authority.receiptRefs, ['diagnostic-receipt-ref', 'local-receipt-ref']);
  assert.match(story.authority.canonicalStoryDigest ?? '', /^sha256:/);
  assert.match(story.authority.gateInputDigest ?? '', /^sha256:/);
  assert.ok(story.evidence.some(e => e.id === 'CHK-001:happy:0'), 'verification evidence is exported');
  assert.ok(story.degradations.some(d => d.id === 'local-assurance-incomplete' && d.authorityImpact === 'blocks-production-done'), 'local assurance gap is visible degradation');
  assert.equal((story as unknown as Record<string, unknown>).hostProfile, undefined, 'canonical story does not leak host-private profile fields');
}

const root = mkdtempSync(join(tmpdir(), 'lattice-canonical-story-export-'));
try {
  writeConfig(root);
  resetConfigCache();
  const store = new StoryStore(root);
  seedStory(store);

  const built = buildCanonicalStory(store, root, 'B-test').story;
  assertCanonicalShape(built);

  assert.ok(MAIN_TOOLS.some(tool => tool.name === 'story_export'), 'MAIN_TOOLS exposes story_export');
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  const registry = createMainRegistry(ctx);
  assert.equal(registry.has('story_export'), true, 'registry exposes story_export handler');
  assertCanonicalShape(registry.get('story_export')!({ storyId: 'B-test', format: 'json' }) as CanonicalStory);

  const here = dirname(fileURLToPath(import.meta.url));
  const cliPath = join(here, '..', 'cli.js');
  const stdout = execFileSync(process.execPath, [cliPath, '--root', root, 'story_export', '--storyId=B-test', '--format=json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assertCanonicalShape(JSON.parse(stdout) as CanonicalStory);

  const outputPath = join(root, 'canonical-story.json');
  execFileSync(process.execPath, [cliPath, '--root', root, 'story_export', '--storyId=B-test', `--output=${outputPath}`], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assertCanonicalShape(JSON.parse(readFileSync(outputPath, 'utf8')) as CanonicalStory);
  assert.throws(
    () => registry.get('story_export')!({ storyId: 'B-test', output: outputPath }),
    /refusing to overwrite existing file/,
    'story_export output must be no-overwrite',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('✓ canonical story export smoke passed');
