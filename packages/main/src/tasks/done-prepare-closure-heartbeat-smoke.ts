#!/usr/bin/env node

/**
 * Smoke: done_prepare closeout progress is visible, JSON-safe, and fail-closed.
 *
 * Run:
 *   node packages/main/dist/tasks/done-prepare-closure-heartbeat-smoke.js
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resetConfigCache } from '../core/config.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash, EMPTY_STORY_FILES_HASH } from '../core/evidence-freshness.js';
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
import { StoryStore } from '../core/store.js';
import type {
  ChecklistData,
  ClosingSelfCheck,
  DeliveryCheckData,
  DocsPromise,
  RealMachineTest,
  StoryInfo,
  TestEvidenceData,
} from '../core/types.js';
import { createDonePrepareHandlers } from '../handlers/done-prepare.js';
import type { HandlerContext } from '../handlers/context.js';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'cli.js');
const NOW = '2026-07-09T00:00:00.000Z';
const STORY_ID = 'B-done-prepare-heartbeat';

const REQUIRED_PROGRESS_LABELS = [
  'done_prepare progress: evaluating DONE closure',
  'done_prepare progress: checking review assurance',
  'done_prepare progress: computing runtime-change status',
  'done_prepare progress: checking clean tree',
  'done_prepare progress: producing DONE command',
] as const;

type Fixture = {
  root: string;
  storyId: string;
};

type CliResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

function write(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'done-prepare-closure-heartbeat-smoke',
      GIT_AUTHOR_EMAIL: 'done-prepare-closure-heartbeat-smoke@example.test',
      GIT_COMMITTER_NAME: 'done-prepare-closure-heartbeat-smoke',
      GIT_COMMITTER_EMAIL: 'done-prepare-closure-heartbeat-smoke@example.test',
    },
  }).trim();
}

function commitAll(root: string, message: string): void {
  git(root, ['add', '.']);
  git(root, ['commit', '-m', message]);
}

function mkCtx(root: string, log?: (msg: string) => void): HandlerContext {
  resetConfigCache();
  return {
    store: new StoryStore(root),
    root,
    scanRoot: root,
    ...(log ? { log } : {}),
  };
}

function seedDoneGateEvidence(root: string, storyId: string): void {
  const store = new StoryStore(root);
  const headHash = currentGitHead(root);
  const materialHash = currentMaterialHash(root, 'HEAD', root);
  const rawStoryFilesHash = currentStoryFilesHash(root, 'HEAD', root);
  const storyFilesHash = rawStoryFilesHash && rawStoryFilesHash !== EMPTY_STORY_FILES_HASH
    ? rawStoryFilesHash
    : undefined;
  assert.ok(headHash, 'fixture must have a git HEAD');
  assert.ok(materialHash, 'fixture must have a material hash');

  const testEvidence: TestEvidenceData = {
    command: 'done_prepare closure heartbeat smoke',
    output: JSON.stringify({ allPass: true, summary: 'synthetic validation passed' }),
    result: 'PASS',
    timestamp: NOW,
    headHash,
    materialHash,
    ...(rawStoryFilesHash ? { storyFilesHash: rawStoryFilesHash } : {}),
  };
  store.writeTestEvidence(storyId, testEvidence);

  const docsPromises: DocsPromise[] = [];
  const realMachineTests: RealMachineTest[] = [{
    featureId: 'done-prepare-closeout-progress',
    transcript: 'Synthetic fixture proves done_prepare closeout progress labels and deadlines.',
  }];
  const closingSelfCheck: ClosingSelfCheck = {
    hasRealMachineTest: true,
    hasEdgeCaseCoverage: true,
    hasUnresolvedTodos: false,
    summary: 'Synthetic delivery check covers closeout progress behavior.',
  };
  const deliveryCheck: DeliveryCheckData = {
    storyId,
    checkedAt: NOW,
    headHash,
    materialHash,
    ...(storyFilesHash ? { storyFilesHash } : {}),
    reviewRound: NOW,
    agentId: 'lattice-review-delivery',
    docsPromises,
    realMachineTests,
    closingSelfCheck,
    _hash: signDeliveryCheck(storyId, docsPromises, realMachineTests, closingSelfCheck, NOW, materialHash, storyFilesHash),
  };
  store.writeDeliveryCheck(storyId, deliveryCheck);
}

function setupFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-prepare-heartbeat-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: '.',
    rootDir: '.',
    testsDir: 'tests',
    fixturesDir: 'tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'light' },
    staleThresholds: {
      phaseStale: 10_000_000,
      itemStale: 10_000_000,
      idleLattice: 10_000_000,
      bugStale: 10_000_000,
    },
  }, null, 2) + '\n');
  write(root, '.gitignore', [
    '.lattice/activity.jsonl',
    '.lattice/learning/runtime-memory-pack-cache/',
    '.lattice/locks/',
    '',
  ].join('\n'));
  write(root, 'README.md', '# done_prepare closeout heartbeat fixture\n');

  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  commitAll(root, 'seed done_prepare heartbeat fixture');
  git(root, ['checkout', '-B', `story/${STORY_ID}`]);

  resetConfigCache();
  const store = new StoryStore(root);
  store.writeStory(STORY_ID, {
    storyId: STORY_ID,
    name: 'done-prepare-closure-heartbeat',
    title: 'done_prepare closure heartbeat smoke',
    description: 'Synthetic TEST story for done_prepare closeout progress.',
    type: 'chore',
    phase: 'TEST',
    priority: 'medium',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    currentReviewRound: NOW,
    riskSignals: [],
    worktree: {
      path: root,
      branch: `story/${STORY_ID}`,
      createdAt: NOW,
    },
    events: [{ phase: 'TEST', action: 'advance', timestamp: NOW }],
  } as StoryInfo);
  store.writeChecklist(STORY_ID, {
    items: [{
      id: 'CHK-001',
      title: 'Closeout heartbeat smoke fixture',
      context: 'Synthetic done item for done_prepare closeout heartbeat coverage.',
      status: 'done',
      startTime: NOW,
      endTime: NOW,
    }],
  } as ChecklistData);
  seedDoneGateEvidence(root, STORY_ID);
  commitAll(root, 'seed done_prepare heartbeat story metadata');
  assert.equal(git(root, ['status', '--porcelain']), '', 'fixture must start clean');
  return { root, storyId: STORY_ID };
}

function runCli(root: string, args: string[], env: Record<string, string> = {}): CliResult {
  const result = spawnSync(process.execPath, [cliPath, '--root', root, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error } : {}),
  };
}

function donePrepareFlagArgs(storyId: string, json = false): string[] {
  return [
    'done_prepare',
    '--storyId', storyId,
    '--mergeMain=false',
    '--refreshStale=false',
    '--validate=false',
    '--dryRun=true',
    ...(json ? ['--json'] : []),
  ];
}

function assertProgressLabels(text: string): void {
  for (const label of REQUIRED_PROGRESS_LABELS) {
    assert.ok(text.includes(label), `missing progress label ${JSON.stringify(label)} in:\n${text}`);
  }
}

function readTreeSnapshot(root: string, relDir: string): Record<string, string> {
  const base = join(root, relDir);
  const snapshot: Record<string, string> = {};
  if (!existsSync(base)) return snapshot;
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile()) {
        snapshot[relative(base, path).replace(/\\/g, '/')] = readFileSync(path, 'utf8');
      }
    }
  };
  visit(base);
  return snapshot;
}

function withEnv<T>(patch: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(patch)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function assertHumanCliProgress(root: string, storyId: string): void {
  const result = runCli(root, donePrepareFlagArgs(storyId));
  assert.equal(result.status, 0, `human done_prepare should exit 0:\n${result.stderr}\n${result.stdout}`);
  assert.ok(result.stdout.startsWith('DONE prepare: PASS'), `human stdout should keep final transcript:\n${result.stdout}`);
  assertProgressLabels(result.stderr);
  assert.ok(!result.stdout.includes('done_prepare progress:'), 'human final transcript should not duplicate side-channel progress');
  assert.ok(!existsSync(join(root, '.lattice', 'activity.jsonl')), 'dry-run progress must not depend on activity-root logging');
}

function assertJsonStdoutParseable(root: string, storyId: string): void {
  const result = runCli(root, donePrepareFlagArgs(storyId, true));
  assert.equal(result.status, 0, `json done_prepare should exit 0:\n${result.stderr}\n${result.stdout}`);
  assertProgressLabels(result.stderr);
  assert.ok(!result.stdout.includes('done_prepare progress:'), `JSON stdout must not contain progress text:\n${result.stdout}`);
  const parsed = JSON.parse(result.stdout) as {
    schemaVersion?: string;
    storyId?: string;
    status?: string;
    transcript?: string;
  };
  assert.equal(parsed.schemaVersion, 'lattice.done_prepare.v1');
  assert.equal(parsed.storyId, storyId);
  assert.equal(parsed.status, 'pass');
  assert.ok(parsed.transcript?.startsWith('DONE prepare: PASS'), 'JSON payload carries the final transcript');
}

async function assertHungPhaseFailsClosed(): Promise<void> {
  const { root, storyId } = setupFixture();
  const oldCwd = process.cwd();
  try {
    process.chdir(root);
    const storySnapshotBefore = readTreeSnapshot(root, `.lattice/story/actives/${storyId}`);
    const logs: string[] = [];
    const prepare = createDonePrepareHandlers(mkCtx(root, (msg) => logs.push(msg)));
    const transcript = await withEnv({
      LATTICE_DONE_PREPARE_HEARTBEAT_MS: '20',
      LATTICE_DONE_PREPARE_PHASE_TIMEOUT_MS: '5000',
      LATTICE_DONE_PREPARE_RUNTIME_CHANGE_TIMEOUT_MS: '120',
      LATTICE_DONE_PREPARE_SMOKE_HANG_PHASE: 'runtimeChange',
    }, async () => String(await prepare.done_prepare({
      storyId,
      mergeMain: false,
      refreshStale: false,
      validate: false,
      dryRun: true,
    })));

    assert.ok(logs.includes('done_prepare progress: computing runtime-change status'), 'hung phase emits the exact progress label');
    assert.ok(
      logs.some((line) => line.startsWith('done_prepare heartbeat: computing runtime-change status elapsedMs=')),
      `hung phase must heartbeat before its deadline:\n${logs.join('\n')}`,
    );
    assert.ok(transcript.startsWith('DONE prepare: BLOCKED'), `hung phase must return a BLOCKED transcript:\n${transcript}`);
    assert.match(transcript, /^blockedAt: runtimeChange$/m);
    assert.match(transcript, /reason: done_prepare phase "computing runtime-change status" exceeded 120ms timeout/);
    assert.match(transcript, /heartbeat output is diagnostic only and does not extend the phase deadline/);
    assert.ok(!transcript.includes('DonePreparePhaseTimeoutError'), 'timeout should not leak an opaque stack/class name');
    assert.deepEqual(
      readTreeSnapshot(root, `.lattice/story/actives/${storyId}`),
      storySnapshotBefore,
      'progress and timeout diagnostics must not write gate evidence or story metadata',
    );
    assert.ok(!existsSync(join(root, '.lattice', 'activity.jsonl')), 'direct handler progress does not depend on activity-root logging');
  } finally {
    process.chdir(oldCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertSynchronousGitTimeoutFailsClosed(): Promise<void> {
  const { root, storyId } = setupFixture();
  const oldCwd = process.cwd();
  try {
    process.chdir(root);
    const storySnapshotBefore = readTreeSnapshot(root, `.lattice/story/actives/${storyId}`);
    const logs: string[] = [];
    const prepare = createDonePrepareHandlers(mkCtx(root, (msg) => logs.push(msg)));
    const started = Date.now();
    const transcript = await withEnv({
      LATTICE_DONE_PREPARE_HEARTBEAT_MS: '20',
      LATTICE_DONE_PREPARE_PHASE_TIMEOUT_MS: '5000',
      LATTICE_DONE_PREPARE_RUNTIME_CHANGE_TIMEOUT_MS: '120',
      LATTICE_DONE_PREPARE_SMOKE_SYNC_GIT_HANG_PHASE: 'runtimeChange',
      LATTICE_DONE_PREPARE_SMOKE_SYNC_GIT_HANG_KIND: 'execFileSync',
      LATTICE_DONE_PREPARE_SMOKE_SYNC_GIT_HANG_MS: '5000',
    }, async () => String(await prepare.done_prepare({
      storyId,
      mergeMain: false,
      refreshStale: false,
      validate: false,
      dryRun: true,
    })));
    const elapsedMs = Date.now() - started;

    assert.ok(logs.includes('done_prepare progress: computing runtime-change status'), 'sync git timeout emits the exact progress label');
    assert.ok(
      elapsedMs < 2_000,
      `sync git timeout should be bounded by the phase deadline, not the sleeping child duration; elapsedMs=${elapsedMs}`,
    );
    assert.ok(transcript.startsWith('DONE prepare: BLOCKED'), `sync git timeout must return a BLOCKED transcript:\n${transcript}`);
    assert.match(transcript, /^blockedAt: runtimeChange$/m);
    assert.match(transcript, /reason: done_prepare phase "computing runtime-change status" exceeded 120ms timeout/);
    assert.match(transcript, /heartbeat output is diagnostic only and does not extend the phase deadline/);
    assert.ok(!transcript.includes('ETIMEDOUT'), 'sync child timeout should be attributed to the done_prepare phase');
    assert.deepEqual(
      readTreeSnapshot(root, `.lattice/story/actives/${storyId}`),
      storySnapshotBefore,
      'sync child timeout diagnostics must not write gate evidence or story metadata',
    );
    assert.ok(!existsSync(join(root, '.lattice', 'activity.jsonl')), 'sync timeout progress does not depend on activity-root logging');
  } finally {
    process.chdir(oldCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertSynchronousDoneClosureGitTimeoutFailsClosed(): Promise<void> {
  const { root, storyId } = setupFixture();
  const oldCwd = process.cwd();
  try {
    process.chdir(root);
    const storySnapshotBefore = readTreeSnapshot(root, `.lattice/story/actives/${storyId}`);
    const logs: string[] = [];
    const prepare = createDonePrepareHandlers(mkCtx(root, (msg) => logs.push(msg)));
    const started = Date.now();
    const transcript = await withEnv({
      LATTICE_DONE_PREPARE_HEARTBEAT_MS: '20',
      LATTICE_DONE_PREPARE_PHASE_TIMEOUT_MS: '5000',
      LATTICE_DONE_PREPARE_DONE_CLOSURE_TIMEOUT_MS: '120',
      LATTICE_DONE_PREPARE_SMOKE_SYNC_GIT_HANG_PHASE: 'doneClosure',
      LATTICE_DONE_PREPARE_SMOKE_SYNC_GIT_HANG_KIND: 'execSync',
      LATTICE_DONE_PREPARE_SMOKE_SYNC_GIT_HANG_MS: '5000',
    }, async () => String(await prepare.done_prepare({
      storyId,
      mergeMain: false,
      refreshStale: false,
      validate: false,
      dryRun: true,
    })));
    const elapsedMs = Date.now() - started;

    assert.ok(logs.includes('done_prepare progress: evaluating DONE closure'), 'execSync git timeout emits the exact done-closure progress label');
    assert.ok(
      elapsedMs < 2_000,
      `done-closure execSync timeout should be bounded by the phase deadline, not the sleeping child duration; elapsedMs=${elapsedMs}`,
    );
    assert.ok(transcript.startsWith('DONE prepare: BLOCKED'), `execSync git timeout must return a BLOCKED transcript:\n${transcript}`);
    assert.match(transcript, /^blockedAt: doneClosure$/m);
    assert.match(transcript, /reason: done_prepare phase "evaluating DONE closure" exceeded 120ms timeout/);
    assert.match(transcript, /heartbeat output is diagnostic only and does not extend the phase deadline/);
    assert.ok(!transcript.includes('ETIMEDOUT'), 'execSync child timeout should be attributed to the done_prepare phase');
    assert.deepEqual(
      readTreeSnapshot(root, `.lattice/story/actives/${storyId}`),
      storySnapshotBefore,
      'execSync timeout diagnostics must not write gate evidence or story metadata',
    );
    assert.ok(!existsSync(join(root, '.lattice', 'activity.jsonl')), 'execSync timeout progress does not depend on activity-root logging');
  } finally {
    process.chdir(oldCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

void (async () => {
  const fixture = setupFixture();
  try {
    assertHumanCliProgress(fixture.root, fixture.storyId);
    assertJsonStdoutParseable(fixture.root, fixture.storyId);
    await assertHungPhaseFailsClosed();
    await assertSynchronousGitTimeoutFailsClosed();
    await assertSynchronousDoneClosureGitTimeoutFailsClosed();
    console.log('done-prepare-closure-heartbeat smoke passed');
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
})();
