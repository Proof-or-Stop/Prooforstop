#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import type { StoryInfo, StoryPhase } from '../core/types.js';
import { checkConvergence } from './gap-analyze.js';

const tmp = mkdtempSync(join(tmpdir(), 'koala-convergence-discarded-'));

function story(storyId: string, phase: StoryPhase): StoryInfo {
  const now = new Date().toISOString();
  return {
    storyId,
    name: storyId.toLowerCase(),
    title: `${storyId} smoke`,
    description: 'Smoke story for convergence terminal phase filtering.',
    type: 'chore',
    phase,
    priority: 'low',
    createdAt: now,
    startedAt: phase === 'DONE' || phase === 'DISCARDED' ? now : null,
    endedAt: phase === 'DONE' || phase === 'DISCARDED' ? now : null,
    events: [{ phase, action: phase === 'DONE' || phase === 'DISCARDED' ? 'advance' : 'create', timestamp: now }],
  };
}

try {
  mkdirSync(join(tmp, 'packages/main/src'), { recursive: true });
  writeFileSync(join(tmp, 'packages/main/src/empty.ts'), 'export const noop = true;\n');
  writeFileSync(join(tmp, 'koala.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
  }));
  resetConfigCache();

  const store = new StoryStore(tmp);
  store.writeStory('B-done', story('B-done', 'DONE'));
  store.writeStory('B-discarded', story('B-discarded', 'DISCARDED'));

  const terminalOnly = checkConvergence(tmp, store);
  const terminalStoryCheck = terminalOnly.checks.find(check => check.name === '所有 Story 完成');
  assert.equal(terminalStoryCheck?.passed, true);
  assert.equal(terminalStoryCheck?.detail, '全部 DONE');

  store.writeStory('B-dev', story('B-dev', 'DEV'));

  const withDev = checkConvergence(tmp, store);
  const devStoryCheck = withDev.checks.find(check => check.name === '所有 Story 完成');
  assert.equal(devStoryCheck?.passed, false);
  assert.match(devStoryCheck?.detail ?? '', /B-dev/);
  assert.doesNotMatch(devStoryCheck?.detail ?? '', /B-discarded/);

  console.log('✓ convergence discarded smoke passed');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
