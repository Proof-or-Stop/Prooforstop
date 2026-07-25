#!/usr/bin/env node
/**
 * B-3b88 CHK-002 RED/GREEN smoke: verification_evidence_refresh_stale must NOT
 * silently re-certify a stale, command-backed result:pass row onto current
 * material (the laundering channel, checklist.ts ~1051-1077 today copies
 * command/result/note verbatim and only re-stamps the hashes). Command-less
 * attestation rows may still be refreshed.
 *
 * RED (pre-fix): the command-backed pass row is refreshed → its headHash becomes
 *   current → assert.equal(headHash, STALE_HEAD) fails → non-zero exit.
 * GREEN (post-fix): command-backed pass left stale; attestation row still refreshed.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import type { ChecklistData, StoryInfo, VerificationEvidence } from '../core/types.js';
import { createMainRegistry } from '../registry.js';
import type { HandlerContext } from '../handlers/context.js';

const STORY_ID = 'B-refresh-honesty';
const NOW = '2026-07-25T00:00:00.000Z';
const STALE_HEAD = '0000000000000000000000000000000000000000';
const STALE_MATERIAL = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'refresh-honesty-smoke',
      GIT_AUTHOR_EMAIL: 'refresh-honesty-smoke@example.com',
      GIT_COMMITTER_NAME: 'refresh-honesty-smoke',
      GIT_COMMITTER_EMAIL: 'refresh-honesty-smoke@example.com',
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
    name: 'refresh-honesty-smoke',
    title: 'refresh_stale honesty fixture',
    description: 'Fixture story for the refresh_stale command-backed-pass honesty guard.',
    type: 'bug',
    phase: 'DEV',
    priority: 'medium',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
  };
}

function seed(): ChecklistData {
  // Both rows are stale (STALE head + STALE material) → both are refresh candidates today.
  const commandBackedPass: VerificationEvidence = {
    intentRef: 'CHK-001:happy:0',
    kind: 'logic_test',
    command: 'node packages/main/dist/tasks/convergence-breaker-smoke.js',
    result: 'pass',
    note: 'command-backed pass — refresh must NOT re-certify without re-execution',
    headHash: STALE_HEAD,
    materialHash: STALE_MATERIAL,
  };
  const attestationRow: VerificationEvidence = {
    intentRef: 'CHK-001:edge:0',
    kind: 'manual_transcript',
    result: 'pass',
    note: 'command-less attestation — freshness may still be refreshed',
    headHash: STALE_HEAD,
    materialHash: STALE_MATERIAL,
  };
  return {
    items: [
      {
        id: 'CHK-001',
        title: 'refresh honesty item',
        context: 'command-backed pass must not be laundered',
        status: 'done',
        startTime: null,
        endTime: null,
        verificationIntent: {
          happy: [{ desc: 'command-backed intent', type: 'logic', priority: 'must' }],
          edge: [{ desc: 'attestation intent', type: 'manual', priority: 'must' }],
          adversarial: [],
        },
        verificationEvidence: [commandBackedPass, attestationRow],
      },
    ],
  };
}

function createFixture(): { store: StoryStore; ctx: HandlerContext } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-refresh-honesty-'));
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeConfig(root);
  writeFileSync(join(root, 'README.md'), '# refresh honesty smoke\n', 'utf8');
  writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const value = 1;\n', 'utf8');
  git(root, ['init']);
  git(root, ['checkout', '-b', 'main']);
  git(root, ['add', 'README.md', 'lattice.config.json', 'packages/main/src/index.ts']);
  git(root, ['commit', '-m', 'base']);
  const store = new StoryStore(root);
  store.writeStory(STORY_ID, baseStory());
  store.writeChecklist(STORY_ID, seed());
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  return { store, ctx };
}

const { store, ctx } = createFixture();
const refresh = createMainRegistry(ctx).get('verification_evidence_refresh_stale');
assert.ok(refresh, 'registry exposes verification_evidence_refresh_stale');

refresh!({ storyId: STORY_ID });

const cl = store.readChecklist(STORY_ID);
const item = cl.items.find((i) => i.id === 'CHK-001');
assert.ok(item, 'fixture item present');
const rows = item!.verificationEvidence || [];
const cmdRow = rows.find((e) => e.intentRef === 'CHK-001:happy:0');
const attRow = rows.find((e) => e.intentRef === 'CHK-001:edge:0');
assert.ok(cmdRow && attRow, 'both evidence rows present after refresh');

// GREEN target: command-backed pass is left stale (not silently re-certified).
assert.equal(
  cmdRow!.headHash,
  STALE_HEAD,
  'command-backed result:pass must NOT be refreshed without re-execution (laundering channel)',
);
// Command-less attestation freshness may still be refreshed.
assert.notEqual(
  attRow!.headHash,
  STALE_HEAD,
  'command-less attestation row is still refreshed to current head',
);

console.log('refresh-stale-honesty-smoke: PASS');
