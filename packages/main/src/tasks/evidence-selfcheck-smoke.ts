#!/usr/bin/env node
/**
 * B-3b88 CHK-001 RED/GREEN smoke: verification_evidence_add must refuse an
 * evidence row whose own `command` and `file` fields name contradictory targets
 * (F-049: command→gate-repeat-block-smoke.js, file→convergence-breaker-smoke.ts).
 *
 * RED (pre-fix): the contradictory add is accepted → assert.throws fails → non-zero exit.
 * GREEN (post-fix): the contradictory add throws; matching-stem and no-stem rows still accepted.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import { createMainRegistry } from '../registry.js';
import type { HandlerContext } from '../handlers/context.js';

const STORY_ID = 'B-selfcheck';
const NOW = '2026-07-25T00:00:00.000Z';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'evidence-selfcheck-smoke',
      GIT_AUTHOR_EMAIL: 'evidence-selfcheck-smoke@example.com',
      GIT_COMMITTER_NAME: 'evidence-selfcheck-smoke',
      GIT_COMMITTER_EMAIL: 'evidence-selfcheck-smoke@example.com',
    },
  }).trim();
}

function writeConfig(root: string): void {
  writeFileSync(
    join(root, 'lattice.config.json'),
    JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'balanced' },
    }, null, 2) + '\n',
    'utf8',
  );
  resetConfigCache();
}

function baseStory(): StoryInfo {
  return {
    storyId: STORY_ID,
    name: 'evidence-selfcheck-smoke',
    title: 'contradiction guard fixture',
    description: 'Fixture story for the verification_evidence_add contradiction guard.',
    type: 'bug',
    phase: 'DEV',
    priority: 'medium',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
  };
}

function seed(): ChecklistData {
  return {
    items: [
      {
        id: 'CHK-001',
        title: 'contradiction guard item',
        context: 'evidence rows must not self-contradict',
        status: 'done',
        startTime: null,
        endTime: null,
        verificationIntent: {
          happy: [{ desc: 'happy intent', type: 'logic', priority: 'must' }],
          edge: [{ desc: 'edge intent', type: 'logic', priority: 'must' }],
          adversarial: [],
        },
        verificationEvidence: [],
      },
    ],
  };
}

function createFixture(): { root: string; ctx: HandlerContext } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-evidence-selfcheck-'));
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeConfig(root);
  writeFileSync(join(root, 'README.md'), '# evidence selfcheck smoke\n', 'utf8');
  writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const value = 1;\n', 'utf8');
  git(root, ['init']);
  git(root, ['checkout', '-b', 'main']);
  git(root, ['add', 'README.md', 'lattice.config.json', 'packages/main/src/index.ts']);
  git(root, ['commit', '-m', 'base']);
  const store = new StoryStore(root);
  store.writeStory(STORY_ID, baseStory());
  store.writeChecklist(STORY_ID, seed());
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  return { root, ctx };
}

const { ctx } = createFixture();
const add = createMainRegistry(ctx).get('verification_evidence_add');
assert.ok(add, 'registry exposes verification_evidence_add');

// (1) Contradiction: command targets gate-repeat-block-smoke.js, file targets convergence-breaker-smoke.ts.
assert.throws(
  () => add!({
    storyId: STORY_ID,
    itemId: 'CHK-001',
    intentRef: 'CHK-001:happy:0',
    kind: 'logic_test',
    command: 'node packages/main/dist/tasks/gate-repeat-block-smoke.js',
    file: 'packages/main/src/tasks/convergence-breaker-smoke.ts',
    result: 'pass',
    note: 'contradictory command vs file target — must be refused',
  }),
  /contradict|mismatch|disagree/i,
  'verification_evidence_add must refuse a row whose command and file name different targets',
);

// (2) Matching stem across dist/src + .js/.ts must be accepted (no false positive).
add!({
  storyId: STORY_ID,
  itemId: 'CHK-001',
  intentRef: 'CHK-001:happy:0',
  kind: 'logic_test',
  command: 'node packages/main/dist/tasks/convergence-breaker-smoke.js',
  file: 'packages/main/src/tasks/convergence-breaker-smoke.ts',
  result: 'pass',
  note: 'command and file name the same target — allowed after normalization',
});

// (3) A command with no file-like argument cannot contradict — accepted.
add!({
  storyId: STORY_ID,
  itemId: 'CHK-001',
  intentRef: 'CHK-001:edge:0',
  kind: 'logic_test',
  command: 'npm test',
  file: 'packages/main/src/tasks/convergence-breaker-smoke.ts',
  result: 'pass',
  note: 'no file stem in command — no contradiction possible',
});

console.log('evidence-selfcheck-smoke: PASS');
