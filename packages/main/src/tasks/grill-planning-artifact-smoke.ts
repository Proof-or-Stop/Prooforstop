#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resetConfigCache, getAllowedPatterns, isCommandAllowed } from '../core/config.js';
import { COMMAND_POLICIES } from '../core/command-policy.js';
import { PROCESS_FACT_LEVELS } from '../core/process-fact-levels.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import { MAIN_TOOLS } from '../cli-engine.js';
import { createGrillHandlers } from '../handlers/grill.js';
import { createStoryReviewHandlers } from '../handlers/story-review.js';
import { createMainRegistry } from '../registry.js';

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function initStore(phase: StoryInfo['phase'] = 'PLAN'): { root: string; store: StoryStore; storyId: string } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-grill-smoke-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'light' },
  }, null, 2));
  resetConfigCache();

  const store = new StoryStore(root);
  const storyId = 'B-grill';
  const now = '2026-05-15T10:00:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'grill-smoke',
    title: 'Grill planning artifact smoke',
    description: 'Synthetic story for grill planning artifact smoke coverage.',
    type: 'chore',
    phase,
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase, action: 'advance', timestamp: now }],
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Exercise grill planning context',
      context: 'Synthetic item with concrete output.',
      userSees: '`grill_get` returns planning context.',
      status: 'pending',
      startTime: null,
      endTime: null,
    }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  return { root, store, storyId };
}

function hasOwnKey(value: unknown, key: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  if (Array.isArray(value)) return value.some(entry => hasOwnKey(entry, key));
  return Object.values(value as Record<string, unknown>).some(entry => hasOwnKey(entry, key));
}

function assertCommandInventory(): void {
  const toolNames = new Set(MAIN_TOOLS.map(tool => tool.name));
  const levelByName = new Map(PROCESS_FACT_LEVELS.map(entry => [entry.name, entry]));
  for (const command of ['grill_start', 'grill_record', 'grill_close', 'grill_get'] as const) {
    const policy = COMMAND_POLICIES[command] as { status: string; gateEvidence?: boolean };
    assert.equal(toolNames.has(command), true, `${command} must be registered in MAIN_TOOLS`);
    assert.equal(policy.status, 'supported');
    assert.equal(policy.gateEvidence, undefined, `${command} must not be gateEvidence`);
    assert.ok(levelByName.has(command), `${command} must be inventoried below gate semantics`);
  }
  assert.equal(levelByName.get('grill_start')?.level, 'L1');
  assert.equal(levelByName.get('grill_record')?.level, 'L1');
  assert.equal(levelByName.get('grill_close')?.level, 'L1');
  assert.equal(levelByName.get('grill_get')?.level, 'L0');

  assert.equal(isCommandAllowed('grill_start', 'PLAN'), true);
  assert.equal(isCommandAllowed('grill_record', 'PLAN'), true);
  assert.equal(isCommandAllowed('grill_close', 'PLAN'), true);
  assert.equal(isCommandAllowed('grill_record', 'DEV'), false);
  assert.equal(isCommandAllowed('grill_get', 'DEV'), true);
  assert.ok(getAllowedPatterns('PLAN').includes('grill_start'));
  assert.ok(getAllowedPatterns('DEV').includes('grill_get'));
}

function assertRegistryAndPersistence(): void {
  const { root, store, storyId } = initStore();
  try {
    const ctx = { store, root, scanRoot: join(root, 'packages/main') };
    const registry = createMainRegistry(ctx);
    for (const command of ['grill_start', 'grill_record', 'grill_close', 'grill_get']) {
      assert.equal(registry.has(command), true, `${command} must be registered`);
    }

    const grill = createGrillHandlers(ctx);
    const start = grill.grill_start({ storyId, topic: 'Clarify evidence boundary' }) as any;
    assert.match(start.message, /Grill session started/);
    assert.equal(start.sessionId, 'GRILL-001');

    const answered = grill.grill_record({
      storyId,
      question: 'Can grill transcript satisfy verificationEvidence?',
      answer: 'No. Grill clarifies intent; evidence proves behavior.',
    }) as any;
    assert.match(answered.message, /Recorded grill question/);
    assert.equal(answered.status, 'answered');

    const unresolved = grill.grill_record({
      storyId,
      question: 'Which exact command will prove the behavior?',
      status: 'unresolved',
    }) as any;
    assert.equal(unresolved.status, 'unresolved');

    const closed = grill.grill_close({ storyId, note: 'Close with one remaining unknown' }) as any;
    assert.match(closed.message, /Grill session closed/);
    assert.deepEqual(closed.remainingUnknowns, ['Which exact command will prove the behavior?']);

    const data = store.readGrill(storyId);
    assert.equal(data?.sessions[0]?.status, 'closed');
    assert.equal(data?.sessions[0]?.questions.length, 2);
    assert.equal(hasOwnKey(data, 'verificationEvidence'), false);
    assert.equal(store.readChecklist(storyId).items[0]?.verificationEvidence, undefined);
    assert.equal(store.readTestEvidence(storyId), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertRecordNeedsSession(): void {
  const { root, store, storyId } = initStore();
  try {
    const grill = createGrillHandlers({ store, root, scanRoot: join(root, 'packages/main') });
    assert.throws(
      () => grill.grill_record({ storyId, question: 'Can this create evidence without a session?' }),
      /No active grill session/,
    );
    assert.equal(store.readGrill(storyId), null);
    assert.equal(store.readChecklist(storyId).items[0]?.verificationEvidence, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertTestPhaseRejectsMutators(): void {
  const empty = initStore('TEST');
  try {
    const grill = createGrillHandlers({ store: empty.store, root: empty.root, scanRoot: join(empty.root, 'packages/main') });
    assert.throws(
      () => grill.grill_start({ storyId: empty.storyId, topic: 'Late planning context must be blocked' }),
      /grill_start can only mutate grill\.json in PLAN; current phase is TEST, expected PLAN/,
    );
    assert.equal(empty.store.readGrill(empty.storyId), null);
    assert.deepEqual(grill.grill_get({ storyId: empty.storyId }), { _empty: true });
  } finally {
    rmSync(empty.root, { recursive: true, force: true });
  }

  const existing = initStore('TEST');
  try {
    const artifactPath = join(existing.root, '.lattice/story/actives/B-grill/grill.json');
    const original = {
      storyId: existing.storyId,
      updatedAt: '2026-05-15T10:01:00.000Z',
      sessions: [{
        sessionId: 'GRILL-001',
        topic: 'Existing planning context',
        status: 'open' as const,
        startedAt: '2026-05-15T10:01:00.000Z',
        questions: [],
      }],
    };
    existing.store.writeGrill(existing.storyId, original);
    const before = readFileSync(artifactPath, 'utf-8');
    const grill = createGrillHandlers({ store: existing.store, root: existing.root, scanRoot: join(existing.root, 'packages/main') });

    assert.throws(
      () => grill.grill_record({ storyId: existing.storyId, question: 'Can TEST mutate existing grill context?' }),
      /grill_record can only mutate grill\.json in PLAN; current phase is TEST, expected PLAN/,
    );
    assert.equal(readFileSync(artifactPath, 'utf-8'), before);
    assert.deepEqual(grill.grill_get({ storyId: existing.storyId }), original);
  } finally {
    rmSync(existing.root, { recursive: true, force: true });
  }
}

function assertMalformedArtifactFailsClosed(): void {
  const { root, store, storyId } = initStore();
  try {
    const malformed = '{ "storyId": "B-grill", "sessions": [';
    write(root, '.lattice/story/actives/B-grill/grill.json', malformed);
    assert.throws(
      () => store.readGrill(storyId),
      SyntaxError,
      'malformed grill.json must not be treated as an absent artifact',
    );

    const grill = createGrillHandlers({ store, root, scanRoot: join(root, 'packages/main') });
    assert.throws(
      () => grill.grill_start({ storyId, topic: 'This must not overwrite malformed state' }),
      SyntaxError,
      'PLAN mutations must surface malformed existing grill.json before writing',
    );
    assert.equal(
      readFileSync(join(root, '.lattice/story/actives/B-grill/grill.json'), 'utf-8'),
      malformed,
      'malformed grill.json should remain untouched after a failed mutation',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertStoryReviewAdvisoryOnly(): void {
  const missing = initStore();
  try {
    const result = createStoryReviewHandlers({
      store: missing.store,
      root: missing.root,
      scanRoot: join(missing.root, 'packages/main'),
    }).story_review({ storyId: missing.storyId }) as any;
    assert.equal(result.summary.blockerCount, 0);
    assert.equal(result.issues.some((issue: any) => String(issue.type).startsWith('grill_')), false);
  } finally {
    rmSync(missing.root, { recursive: true, force: true });
  }

  const active = initStore();
  try {
    const ctx = { store: active.store, root: active.root, scanRoot: join(active.root, 'packages/main') };
    const grill = createGrillHandlers(ctx);
    grill.grill_start({ storyId: active.storyId, topic: 'Open context' });
    grill.grill_record({
      storyId: active.storyId,
      question: 'What is still unknown?',
      status: 'unresolved',
    });
    const result = createStoryReviewHandlers(ctx).story_review({ storyId: active.storyId }) as any;
    assert.equal(result.summary.blockerCount, 0);
    assert.equal(result.issues.some((issue: any) => issue.type === 'grill_session_open' && issue.severity === 'advisory'), true);
    assert.equal(result.issues.some((issue: any) => issue.type === 'grill_question_unresolved' && issue.severity === 'advisory'), true);
    assert.match(result._reviewPrompt, /Grill clarifies intent; evidence proves behavior/);
  } finally {
    rmSync(active.root, { recursive: true, force: true });
  }
}

assertCommandInventory();
assertRegistryAndPersistence();
assertRecordNeedsSession();
assertTestPhaseRejectsMutators();
assertMalformedArtifactFailsClosed();
assertStoryReviewAdvisoryOnly();

console.log('✓ grill planning artifact smoke passed');
