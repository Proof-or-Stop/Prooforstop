#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resetConfigCache } from '../packages/main/dist/core/config.js';
import { StoryStore } from '../packages/main/dist/core/store.js';
import { buildNextSteps } from '../packages/main/dist/handlers/transition-effects.js';
import { checkCommitAuthor } from '../packages/main/dist/handlers/validate-channel.js';

const root = mkdtempSync(join(tmpdir(), 'implementation-worker-authority-'));
const write = (path, content) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

try {
  write('proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
  }));
  write('README.md', 'fixture\n');
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.');
  git('commit', '-qm', 'base');

  const storyId = 'B-worker';
  const store = new StoryStore(root);
  store.writeStory(storyId, {
    storyId,
    name: 'worker-authority',
    title: 'Worker authority',
    description: 'Exercise normal-channel implementation provenance.',
    type: 'chore',
    phase: 'DEV',
    priority: 'medium',
    createdAt: '2026-09-20T00:00:00.000Z',
    startedAt: '2026-09-20T00:00:00.000Z',
    endedAt: null,
    events: [],
  });
  store.writeChecklist(storyId, {
    items: ['001', '002', '003'].map(suffix => ({
      id: `CHK-${suffix}`,
      title: `Item ${suffix}`,
      context: 'Fixture item.',
      status: 'done',
      startTime: '2026-09-20T00:00:00.000Z',
      endTime: '2026-09-20T00:01:00.000Z',
    })),
  });
  store.writeDecision(storyId, {
    principles: ['one', 'two', 'three'],
    drivers: ['worker authority'],
    options: [
      { name: 'A', pros: ['tracked'], cons: ['setup'] },
      { name: 'B', pros: ['simple'], cons: ['untracked'] },
    ],
    chosen: 'A',
    rationale: 'Require tracked implementation dispatch.',
    timestamp: '2026-09-20T00:00:00.000Z',
  });
  git('add', '.');
  git('commit', '-qm', 'story metadata');
  git('switch', '-qc', `story/${storyId}`);
  write('packages/main/src/change.ts', 'export const changed = true;\n');
  git('add', 'packages/main/src/change.ts');
  git('-c', 'user.name=proof-or-stop-implementer', '-c', 'user.email=implementer@example.invalid', 'commit', '-qm', 'implement change');
  resetConfigCache();

  const result = checkCommitAuthor(storyId, { store, projectRoot: root });
  assert.equal(
    result.status,
    'fail',
    'IMPLEMENTATION_WORKER_AUTHORITY_RED: author text alone admitted an unregistered implementation worker',
  );
  assert.match(result.summary, /missing dispatch\/subagent_result evidence/);
  assert.match(result.details.join('\n'), /canonical proof-or-stop dispatch/);

  const devGuidance = buildNextSteps(store, root, storyId).DEV;
  assert.match(devGuidance, /First run proof-or-stop dispatch/);
  assert.match(devGuidance, /pass the exact returned prompt unchanged/);
  assert.match(devGuidance, /Do not invent a worker brief/);

  for (const suffix of ['001', '002', '003']) {
    store.appendProcessEvent(storyId, {
      type: 'subagent_result',
      checklistId: `CHK-${suffix}`,
      success: true,
    });
  }
  const registered = checkCommitAuthor(storyId, { store, projectRoot: root });
  assert.equal(registered.status, 'pass', JSON.stringify(registered));
  assert.equal(registered.evidenceSource, 'subagent_result');
  console.log('IMPLEMENTATION_WORKER_AUTHORITY_GREEN');
} finally {
  rmSync(root, { recursive: true, force: true });
}
