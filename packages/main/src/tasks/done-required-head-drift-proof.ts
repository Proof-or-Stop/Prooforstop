#!/usr/bin/env node

/**
 * @task B-cd3d
 * @checklist CHK-001
 * @title DONE-required head drift NOT blocking proof
 * @type chore
 * @priority high
 * @description
 * Repeatably proves the fixed DONE-required behavior: a metadata-only commit
 * changes HEAD (headHash drifts) but leaves materialHash/storyFilesHash
 * unchanged, and the freshly validated done-required evidence stays FRESH.
 * headHash drift no longer deadlocks DONE; materialHash + storyFilesHash are
 * the authoritative freshness gate. A complementary case proves a genuine
 * material change still re-stales evidence as stale-material.
 * @changes
 * - [CHK-001] Invert the three-round temporary-repo proof to assert head-drift
 *   is non-blocking, plus a material-drift case that must still block.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { resetConfigCache } from '../core/config.js';
import { evaluateDoneRequiredEvidence, runDoneRequiredValidation } from '../core/done-required-validation.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { StoryStore } from '../core/store.js';
import type { StoryInfo } from '../core/types.js';

const STORY_ID = 'B-head-drift-proof';
const ROUND_COUNT = 3;
const SLOW_COMMAND_MS = 800;

interface HashSnapshot {
  headHash?: string;
  materialHash?: string;
  storyFilesHash?: string;
}

interface RoundResult {
  round: number;
  firstRunMs: number;
  postMetadataEvalMs: number;
  metadataOnlyHeadChanged: boolean;
  materialSameAfterMetadataCommit: boolean;
  storyFilesSameAfterMetadataCommit: boolean;
  postMetadataOk: boolean;
  postMetadataBlocking: boolean;
  postMetadataReasons: string[];
  materialDriftBlocking: boolean;
  materialDriftReasons: string[];
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'done-required-head-drift-proof',
      GIT_AUTHOR_EMAIL: 'done-required-head-drift-proof@example.com',
      GIT_COMMITTER_NAME: 'done-required-head-drift-proof',
      GIT_COMMITTER_EMAIL: 'done-required-head-drift-proof@example.com',
    },
  }).trim();
}

function writeConfig(root: string): void {
  writeFileSync(
    join(root, 'proof-or-stop.config.json'),
    JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'light' },
      doneRequiredCommands: [
        {
          label: 'slow-required-proof',
          command: 'node',
          args: ['-e', `setTimeout(() => process.exit(0), ${SLOW_COMMAND_MS})`],
        },
      ],
    }, null, 2) + '\n',
    'utf8',
  );
  resetConfigCache();
}

function hashes(root: string): HashSnapshot {
  return {
    headHash: currentGitHead(root),
    materialHash: currentMaterialHash(root, 'HEAD', root),
    storyFilesHash: currentStoryFilesHash(root, 'HEAD', root),
  };
}

function createFixture(): { root: string; store: StoryStore } {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-head-drift-proof-'));
  writeConfig(root);
  writeFileSync(join(root, 'README.md'), '# DONE-required head drift proof\n', 'utf8');
  git(root, ['init']);
  git(root, ['checkout', '-b', 'main']);
  git(root, ['add', 'README.md', 'proof-or-stop.config.json']);
  git(root, ['commit', '-m', 'base']);

  const store = new StoryStore(root);
  const now = '2026-06-22T00:00:00.000Z';
  const story: StoryInfo = {
    storyId: STORY_ID,
    name: 'done-required-head-drift-proof',
    title: 'DONE-required head drift proof',
    description: 'Synthetic story proving metadata-only HEAD drift is non-blocking.',
    type: 'chore',
    phase: 'TEST',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
  };
  store.writeStory(STORY_ID, story);
  store.writeChecklist(STORY_ID, {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic item',
      context: 'Synthetic context',
      status: 'done',
      startTime: now,
      endTime: now,
    }],
  });
  return { root, store };
}

async function timed<T>(fn: () => T | Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - started) };
}

function assertHeadDriftNotBlocking(result: RoundResult): void {
  // Core inversion: after a metadata-only commit HEAD drifts, but the freshly
  // validated done-required evidence must remain FRESH (not blocked, no
  // stale-headHash / missing-headHash reasons).
  assert.equal(result.metadataOnlyHeadChanged, true, `round ${result.round}: metadata commit must change HEAD (headHash drift)`);
  assert.equal(result.materialSameAfterMetadataCommit, true, `round ${result.round}: materialHash must remain unchanged`);
  assert.equal(result.storyFilesSameAfterMetadataCommit, true, `round ${result.round}: storyFilesHash must remain unchanged`);
  assert.equal(result.postMetadataOk, true, `round ${result.round}: head drift must evaluate ok: ${result.postMetadataReasons.join(', ')}`);
  assert.equal(result.postMetadataBlocking, false, `round ${result.round}: head drift must NOT block: ${result.postMetadataReasons.join(', ')}`);
  assert.equal(result.postMetadataReasons.includes('stale-headHash'), false, `round ${result.round}: stale-headHash must no longer be reported`);
  assert.equal(result.postMetadataReasons.includes('missing-headHash'), false, `round ${result.round}: missing-headHash must no longer be reported`);
  assert.equal(result.postMetadataReasons.length, 0, `round ${result.round}: head drift must produce no reasons, got ${result.postMetadataReasons.join(', ')}`);
  // Complementary guard: a genuine material change must still re-stale.
  assert.equal(result.materialDriftBlocking, true, `round ${result.round}: genuine material drift must still block`);
  assert.ok(
    result.materialDriftReasons.includes('stale-material'),
    `round ${result.round}: material drift must report stale-material, got ${result.materialDriftReasons.join(', ')}`,
  );
  assert.equal(result.materialDriftReasons.includes('stale-headHash'), false, `round ${result.round}: material drift must not report stale-headHash`);
}

async function runRound(round: number): Promise<RoundResult> {
  const { root, store } = createFixture();
  try {
    const before = hashes(root);
    const first = await timed(() => runDoneRequiredValidation({ projectRoot: root, storyId: STORY_ID, store, gitCwd: root }));
    assert.equal(first.value.status, 'PASS', `round ${round}: first DONE-required run must pass`);

    const immediate = evaluateDoneRequiredEvidence({ projectRoot: root, storyId: STORY_ID, store, gitCwd: root });
    assert.equal(immediate.ok, true, `round ${round}: freshly written evidence must evaluate ok: ${immediate.reasons.join(', ')}`);
    assert.equal(immediate.blocking, false, `round ${round}: freshly written evidence must not block`);

    git(root, ['add', '.proof-or-stop/story/actives']);
    git(root, ['commit', '-m', 'metadata evidence commit']);
    const afterMetadataCommit = hashes(root);

    // Head drifted via metadata-only commit; evidence must stay fresh without rerun.
    const headDriftEval = await timed(() => evaluateDoneRequiredEvidence({ projectRoot: root, storyId: STORY_ID, store, gitCwd: root }));

    // Complementary case: now mutate real material and confirm it still re-stales.
    writeFileSync(join(root, 'README.md'), '# DONE-required head drift proof (changed)\n', 'utf8');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-m', 'material drift commit']);
    const materialDriftEval = evaluateDoneRequiredEvidence({ projectRoot: root, storyId: STORY_ID, store, gitCwd: root });
    assert.notEqual(
      currentMaterialHash(root, 'HEAD', root),
      first.value.materialHash,
      `round ${round}: material change must move materialHash`,
    );

    const result: RoundResult = {
      round,
      firstRunMs: first.ms,
      postMetadataEvalMs: headDriftEval.ms,
      metadataOnlyHeadChanged: before.headHash !== afterMetadataCommit.headHash,
      materialSameAfterMetadataCommit: first.value.materialHash === afterMetadataCommit.materialHash,
      storyFilesSameAfterMetadataCommit: first.value.storyFilesHash === afterMetadataCommit.storyFilesHash,
      postMetadataOk: headDriftEval.value.ok,
      postMetadataBlocking: headDriftEval.value.blocking,
      postMetadataReasons: headDriftEval.value.reasons,
      materialDriftBlocking: materialDriftEval.blocking,
      materialDriftReasons: materialDriftEval.reasons,
    };
    assertHeadDriftNotBlocking(result);
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function average(results: RoundResult[], key: keyof Pick<RoundResult, 'firstRunMs' | 'postMetadataEvalMs'>): number {
  return Math.round(results.reduce((sum, result) => sum + result[key], 0) / results.length);
}

const results: RoundResult[] = [];
for (let round = 1; round <= ROUND_COUNT; round += 1) {
  results.push(await runRound(round));
}

assert.equal(results.length, ROUND_COUNT, 'proof must run exactly three rounds');
assert.equal(results.every(result => result.postMetadataOk === true && result.postMetadataReasons.length === 0), true, 'every round must show head drift is non-blocking');
assert.equal(results.every(result => result.materialDriftBlocking === true && result.materialDriftReasons.includes('stale-material')), true, 'every round must show material drift still blocks');

const summary = {
  status: 'PASS',
  proof: 'DONE-required metadata-only HEAD drift is non-blocking (deadlock fixed)',
  rounds: results.length,
  headDriftFreshRounds: results.filter(result => result.postMetadataOk && result.postMetadataReasons.length === 0).length,
  materialDriftBlockedRounds: results.filter(result => result.materialDriftReasons.includes('stale-material')).length,
  slowCommandMs: SLOW_COMMAND_MS,
  averages: {
    firstRunMs: average(results, 'firstRunMs'),
    postMetadataEvalMs: average(results, 'postMetadataEvalMs'),
  },
  results,
};

console.log('done-required-head-drift-proof passed');
console.log(JSON.stringify(summary, null, 2));
