#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAIN_TOOLS } from '../cli-engine.js';
import { isCommandAllowed, resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { createMainRegistry } from '../registry.js';

const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-testintent-handoff-'));

try {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
  }));
  resetConfigCache();

  const store = new StoryStore(root);
  const now = new Date().toISOString();
  const story: StoryInfo = {
    storyId: 'B-smoke',
    name: 'smoke',
    title: 'Smoke testintent handoff',
    description: 'Verify testintent_handoff wiring and handler behavior.',
    type: 'chore',
    phase: 'PLAN',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'PLAN', action: 'advance', timestamp: now }],
    worktree: { path: root, branch: 'story/B-smoke', createdAt: now },
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Write verification intent',
      context: 'Smoke checklist item without existing intent.',
      status: 'pending',
      startTime: null,
      endTime: null,
    }],
  };
  store.writeStory(story.storyId, story);
  store.writeChecklist(story.storyId, checklist);

  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  const registry = createMainRegistry(ctx);
  const handler = registry.get('testintent_handoff');

  assert.equal(registry.has('testintent_handoff'), true);
  assert.ok(handler, 'registry should expose testintent_handoff handler');
  assert.ok(MAIN_TOOLS.some((tool) => tool.name === 'testintent_handoff'), 'MAIN_TOOLS should expose help schema');
  assert.equal(isCommandAllowed('testintent_handoff', 'PLAN'), true);

  const result = handler!({ storyId: story.storyId, itemIds: ['CHK-001'] }) as {
    prompt: string;
    summary: { missingIntentItems: string[] };
    commandExamples: string[];
  };
  assert.match(result.prompt, /You are the proof-or-stop-verification-intent agent/);
  assert.match(result.prompt, /write verificationIntent/);
  assert.match(result.prompt, /run or inspect the repository-wide baseline before freezing/i);
  assert.match(result.prompt, /no_new_regressions/);
  assert.match(result.prompt, /external_verifier/);
  assert.match(result.prompt, /priority follows the behavior and risk/i);
  assert.doesNotMatch(result.prompt, /"scope":"repository"/);
  assert.doesNotMatch(result.prompt, /write testIntent/);
  assert.equal(result.commandExamples.length, 1);
  assert.match(result.commandExamples[0], /"verificationIntent"/);
  assert.match(result.commandExamples[0], /"scope":"focused"/);
  assert.match(result.commandExamples[0], /"expectation":"absolute_pass"/);
  assert.doesNotMatch(result.commandExamples[0], /testIntent/);
  assert.deepEqual(result.summary.missingIntentItems, ['CHK-001']);

  assert.throws(
    () => handler!({ storyId: story.storyId, itemIds: ['CHK-404'] }),
    /Unknown checklist item\(s\): CHK-404/,
  );

  console.log('✓ testintent handoff smoke passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
