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
import { commandCliMaxBudget, donePreparePhaseBudget, doneRequiredDerivedBudget } from '../core/done-required-timeout-budget.js';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'cli.js');
const NOW = '2026-07-09T00:00:00.000Z';
const STORY_ID = 'B-done-prepare-heartbeat';
const DONE_REQUIRED_PROGRESS_LABEL = 'done_prepare progress: running DONE-required validation';

const REQUIRED_PROGRESS_LABELS = [
  'done_prepare progress: evaluating DONE closure',
  'done_prepare progress: checking review assurance',
  'done_prepare progress: computing runtime-change status',
  'done_prepare progress: checking clean tree',
  'done_prepare progress: producing DONE command',
] as const;

const REQUIRED_REAL_VALIDATE_PROGRESS_LABELS = [
  DONE_REQUIRED_PROGRESS_LABEL,
] as const;

type Fixture = {
  root: string;
  storyId: string;
};

type FixtureOptions = {
  realValidate?: boolean;
  doneRequiredDelayMs?: number;
};

type CliResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

// Phase-specific override wins global, which wins the command-derived legal budget.
{
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-prepare-budget-'));
  try {
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: '.', rootDir: '.', storyDir: '.lattice/story/actives', requirementsDir: 'docs/requirements',
      validate: { commands: [{ command: 'node', timeoutMs: 300_000 }] },
      doneRequiredCommands: [{ command: 'node', timeoutMs: 1_200_000 }],
    }));
    resetConfigCache();
    const derived = doneRequiredDerivedBudget(root);
    assert.equal(derived.timeoutMs, 1_230_000);
    const previousGlobal = process.env.LATTICE_DONE_PREPARE_PHASE_TIMEOUT_MS;
    const previousPhase = process.env.LATTICE_DONE_PREPARE_DONE_REQUIRED_VALIDATION_TIMEOUT_MS;
    delete process.env.LATTICE_DONE_PREPARE_PHASE_TIMEOUT_MS;
    delete process.env.LATTICE_DONE_PREPARE_DONE_REQUIRED_VALIDATION_TIMEOUT_MS;
    assert.equal(donePreparePhaseBudget(root, 'LATTICE_DONE_PREPARE_DONE_REQUIRED_VALIDATION_TIMEOUT_MS', derived).source, 'derived-command-budget');
    process.env.LATTICE_DONE_PREPARE_PHASE_TIMEOUT_MS = '1400000';
    assert.equal(donePreparePhaseBudget(root, 'LATTICE_DONE_PREPARE_DONE_REQUIRED_VALIDATION_TIMEOUT_MS', derived).timeoutMs, 1_400_000);
    process.env.LATTICE_DONE_PREPARE_DONE_REQUIRED_VALIDATION_TIMEOUT_MS = '1500000';
    assert.equal(donePreparePhaseBudget(root, 'LATTICE_DONE_PREPARE_DONE_REQUIRED_VALIDATION_TIMEOUT_MS', derived).timeoutMs, 1_500_000);
    const total = commandCliMaxBudget(root, 'done_prepare', { validate: true });
    assert.ok(total.timeoutMs >= 1_500_000 + 330_000, 'done_prepare max covers routine plus closeout budgets');
    if (previousGlobal === undefined) delete process.env.LATTICE_DONE_PREPARE_PHASE_TIMEOUT_MS;
    else process.env.LATTICE_DONE_PREPARE_PHASE_TIMEOUT_MS = previousGlobal;
    if (previousPhase === undefined) delete process.env.LATTICE_DONE_PREPARE_DONE_REQUIRED_VALIDATION_TIMEOUT_MS;
    else process.env.LATTICE_DONE_PREPARE_DONE_REQUIRED_VALIDATION_TIMEOUT_MS = previousPhase;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

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

function setupFixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-prepare-heartbeat-'));
  const config: Record<string, unknown> = {
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
  };
  if (options.realValidate) {
    const doneRequiredDelayMs = options.doneRequiredDelayMs ?? 160;
    config.validate = {
      commands: [{
        label: 'smoke validate',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 2000,
      }],
    };
    config.doneRequiredCommands = [{
      label: 'smoke DONE-required validation',
      command: process.execPath,
      args: ['-e', `setTimeout(() => process.exit(0), ${doneRequiredDelayMs})`],
      timeoutMs: 2000,
    }];
  }
  write(root, 'lattice.config.json', JSON.stringify(config, null, 2) + '\n');
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

function donePrepareRealValidateArgs(storyId: string, json = false): string[] {
  return [
    'done_prepare',
    '--storyId', storyId,
    '--mergeMain=false',
    '--refreshStale=false',
    '--validate=true',
    ...(json ? ['--json'] : []),
  ];
}

function seedDoneRequiredViaCli(root: string, storyId: string): void {
  const result = runCli(root, ['done_required_validate', '--storyId', storyId, '--json']);
  assert.equal(result.status, 0, `seed DONE-required evidence failed:\n${result.stderr}\n${result.stdout}`);
  assert.equal(JSON.parse(result.stdout).result, 'pass');
}

function assertActualReuseSwitchAndValidateFalseBasis(): void {
  const reusableFixture = setupFixture({ realValidate: true });
  try {
    seedDoneRequiredViaCli(reusableFixture.root, reusableFixture.storyId);
    const reused = runCli(reusableFixture.root, [
      ...donePrepareRealValidateArgs(reusableFixture.storyId, true),
    ]);
    const reusedJson = JSON.parse(reused.stdout);
    assert.equal(reusedJson.disposition, 'reused', `default/explicit reuse must be observable:\n${reused.stdout}`);
    assert.equal(reusedJson.result, 'pass');
    assert.equal(reusedJson.timeoutLayer, null);
    assert.ok(!reused.stderr.includes(DONE_REQUIRED_PROGRESS_LABEL), 'reused receipt must skip DONE-required command execution');

    const evidencePath = join(reusableFixture.root, `.lattice/story/actives/${reusableFixture.storyId}/done-required-evidence.json`);
    const beforeDisabled = JSON.parse(readFileSync(evidencePath, 'utf8')) as { endedAt?: string };
    const disabled = runCli(reusableFixture.root, [
      ...donePrepareRealValidateArgs(reusableFixture.storyId, true),
      '--reuseFreshDoneRequired=false',
    ]);
    const disabledJson = JSON.parse(disabled.stdout);
    assert.equal(disabledJson.disposition, 'executed');
    assert.equal(disabledJson.result, 'pass');
    assert.equal(disabledJson.timeoutLayer, null);
    assert.match(disabled.stderr, /done_prepare progress: running DONE-required validation/, 'disabled reuse must execute DONE-required commands');
    const afterDisabled = JSON.parse(readFileSync(evidencePath, 'utf8')) as { endedAt?: string };
    assert.notEqual(afterDisabled.endedAt, beforeDisabled.endedAt, 'disabled reuse must refresh the DONE-required receipt');
  } finally {
    rmSync(reusableFixture.root, { recursive: true, force: true });
  }

  const descendantFixture = setupFixture({ realValidate: true });
  try {
    seedDoneRequiredViaCli(descendantFixture.root, descendantFixture.storyId);
    write(
      descendantFixture.root,
      `.lattice/story/actives/${descendantFixture.storyId}/background.md`,
      '# trusted metadata-only descendant\n',
    );
    commitAll(descendantFixture.root, 'add trusted story metadata descendant');
    const descendant = runCli(
      descendantFixture.root,
      donePrepareRealValidateArgs(descendantFixture.storyId, true),
    );
    const parsed = JSON.parse(descendant.stdout);
    assert.equal(parsed.disposition, 'reused', 'trusted metadata-only descendant must reuse actual done_prepare evidence');
    assert.equal(parsed.result, 'pass');
    assert.match(parsed.transcript, /lineage=trusted-story-metadata-descendant/);
    assert.ok(!descendant.stderr.includes(DONE_REQUIRED_PROGRESS_LABEL));
  } finally {
    rmSync(descendantFixture.root, { recursive: true, force: true });
  }

  for (const basis of ['missing', 'fresh', 'stale'] as const) {
    const fixture = setupFixture({ realValidate: true });
    try {
      const evidencePath = join(fixture.root, `.lattice/story/actives/${fixture.storyId}/done-required-evidence.json`);
      if (basis !== 'missing') seedDoneRequiredViaCli(fixture.root, fixture.storyId);
      if (basis === 'stale') {
        write(fixture.root, 'README.md', '# stale material\n');
        commitAll(fixture.root, 'make prior evidence stale');
      }
      const before = existsSync(evidencePath) ? readFileSync(evidencePath, 'utf8') : null;
      const observed = runCli(fixture.root, donePrepareFlagArgs(fixture.storyId, true));
      const parsed = JSON.parse(observed.stdout);
      assert.equal(parsed.disposition, 'skipped_explicitly');
      assert.equal(parsed.result, 'not_run');
      assert.equal(parsed.existingEvidenceBasis, basis);
      assert.equal(parsed.timeoutLayer, null);
      assert.equal(existsSync(evidencePath) ? readFileSync(evidencePath, 'utf8') : null, before, `validate=false must not mutate ${basis} evidence`);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }

  const malformed = setupFixture({ realValidate: true });
  try {
    const evidencePath = join(malformed.root, `.lattice/story/actives/${malformed.storyId}/done-required-evidence.json`);
    writeFileSync(evidencePath, '{"truncated":', 'utf8');
    const before = readFileSync(evidencePath, 'utf8');
    const observed = runCli(malformed.root, donePrepareFlagArgs(malformed.storyId, true));
    const parsed = JSON.parse(observed.stdout);
    assert.equal(parsed.disposition, 'skipped_explicitly');
    assert.equal(parsed.result, 'not_run');
    assert.equal(parsed.existingEvidenceBasis, 'stale');
    assert.match(parsed.refusalReasons.join('\n'), /evidence-malformed-or-unreadable/);
    assert.equal(readFileSync(evidencePath, 'utf8'), before);
  } finally {
    rmSync(malformed.root, { recursive: true, force: true });
  }
}

function assertPreflightBlockOmitsUnobservedValidationFields(): void {
  const fixture = setupFixture();
  try {
    const result = runCli(fixture.root, [
      'done_prepare', '--storyId', 'B-does-not-exist', '--json',
    ]);
    assert.equal(result.status, 1, 'preflight blocker must exit nonzero while preserving JSON');
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, 'blocked');
    assert.equal(parsed.blockedAt, 'preflight');
    for (const field of ['disposition', 'result', 'existingEvidenceBasis', 'timeoutLayer', 'refusalReasons']) {
      assert.equal(Object.hasOwn(parsed, field), false, `preflight must not invent unobserved validation field ${field}`);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function assertPostValidationCloseoutCliTimeouts(): void {
  const cases = [
    { layer: 'idle', idleMs: '120', maxMs: '5000', heartbeatMs: '2000' },
    { layer: 'max', idleMs: '1000', maxMs: '180', heartbeatMs: '50' },
  ] as const;
  for (const testCase of cases) {
    const fixture = setupFixture();
    try {
      const storyDir = `.lattice/story/actives/${fixture.storyId}`;
      const before = readTreeSnapshot(fixture.root, storyDir);
      const result = runCli(fixture.root, donePrepareFlagArgs(fixture.storyId, true), {
        LATTICE_IDLE_TIMEOUT_MS: testCase.idleMs,
        LATTICE_MAX_TIMEOUT_MS: testCase.maxMs,
        LATTICE_DONE_PREPARE_HEARTBEAT_MS: testCase.heartbeatMs,
        LATTICE_DONE_PREPARE_PHASE_TIMEOUT_MS: '5000',
        LATTICE_DONE_PREPARE_SMOKE_HANG_PHASE: 'doneClosure',
      });
      assert.equal(result.status, 1, `post-validation ${testCase.layer} timeout must exit nonzero`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.status, 'blocked');
      assert.equal(parsed.blockedAt, 'doneClosure');
      assert.equal(parsed.disposition, 'executed');
      assert.equal(parsed.result, 'timed_out');
      assert.equal(parsed.timeoutLayer, testCase.layer);
      assert.deepEqual(readTreeSnapshot(fixture.root, storyDir), before, 'watchdog timeout must not duplicate or mutate story evidence');
      assert.equal((result.stdout.match(/"schemaVersion"/g) ?? []).length, 1, 'watchdog timeout emits one terminal JSON object');

      const retry = runCli(fixture.root, donePrepareFlagArgs(fixture.storyId, true), {
        LATTICE_IDLE_TIMEOUT_MS: '1000',
        LATTICE_MAX_TIMEOUT_MS: '5000',
        LATTICE_DONE_PREPARE_HEARTBEAT_MS: '50',
      });
      assert.equal(retry.status, 0, `${testCase.layer} timeout must leave no child/lock/timer that blocks immediate rerun`);
      assert.equal(JSON.parse(retry.stdout).status, 'pass');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
}

function assertProgressLabels(text: string, labels: readonly string[] = REQUIRED_PROGRESS_LABELS): void {
  for (const label of labels) {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
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
    disposition?: string;
    result?: string;
    existingEvidenceBasis?: string;
    refusalReasons?: string[];
  };
  assert.equal(parsed.schemaVersion, 'lattice.done_prepare.v1');
  assert.equal(parsed.storyId, storyId);
  assert.equal(parsed.status, 'pass');
  assert.equal(parsed.disposition, 'skipped_explicitly');
  assert.equal(parsed.result, 'not_run');
  assert.match(parsed.existingEvidenceBasis ?? '', /^(fresh|stale|missing)$/);
  assert.ok(Array.isArray(parsed.refusalReasons));
  assert.ok(parsed.transcript?.startsWith('DONE prepare: PASS'), 'JSON payload carries the final transcript');
}

function assertRealValidateDoneRequiredProgressJsonSafe(): void {
  const { root, storyId } = setupFixture({ realValidate: true, doneRequiredDelayMs: 160 });
  try {
    const result = runCli(root, donePrepareRealValidateArgs(storyId, true), {
      LATTICE_DONE_PREPARE_HEARTBEAT_MS: '20',
      LATTICE_DONE_PREPARE_PHASE_TIMEOUT_MS: '5000',
      LATTICE_DONE_PREPARE_DONE_REQUIRED_VALIDATION_TIMEOUT_MS: '3000',
      LATTICE_VALIDATE_HEARTBEAT_MS: '20',
    });
    assert.equal(result.status, 1, `blocked real-validate done_prepare should return JSON and exit nonzero:\n${result.stderr}\n${result.stdout}`);
    assertProgressLabels(result.stderr, REQUIRED_REAL_VALIDATE_PROGRESS_LABELS);
    assert.ok(
      result.stderr.includes('done_prepare heartbeat: running DONE-required validation elapsedMs='),
      `DONE-required validation must heartbeat while its command is still running:\n${result.stderr}`,
    );
    const validateEndedIndex = result.stderr.indexOf('validate progress: command 1/1 ended smoke validate: code=0');
    const doneRequiredIndex = result.stderr.indexOf(DONE_REQUIRED_PROGRESS_LABEL);
    assert.ok(validateEndedIndex >= 0, `fixture validate command must complete before the DONE-required subphase:\n${result.stderr}`);
    assert.ok(
      doneRequiredIndex > validateEndedIndex,
      `DONE-required progress must be emitted after configured validate.commands complete:\n${result.stderr}`,
    );
    assert.ok(!result.stdout.includes('done_prepare progress:'), `JSON stdout must not contain done_prepare progress text:\n${result.stdout}`);
    assert.ok(!result.stdout.includes('done_prepare heartbeat:'), `JSON stdout must not contain done_prepare heartbeat text:\n${result.stdout}`);
    assert.ok(!result.stdout.includes('validate progress:'), `JSON stdout must not contain validate progress text:\n${result.stdout}`);
    const parsed = JSON.parse(result.stdout) as {
      schemaVersion?: string;
      storyId?: string;
      status?: string;
      transcript?: string;
    };
    assert.equal(parsed.schemaVersion, 'lattice.done_prepare.v1');
    assert.equal(parsed.storyId, storyId);
    assert.equal(parsed.status, 'blocked');
    assert.match(parsed.transcript ?? '', /^blockedAt: cleanTree$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDoneRequiredPhaseTimeoutFailsClosed(): Promise<void> {
  const childDurationMs = 1_500;
  const { root, storyId } = setupFixture({ realValidate: true, doneRequiredDelayMs: childDurationMs });
  try {
    const descendantPidFile = join(root, 'phase-descendant.pid');
    const configPath = join(root, 'lattice.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { doneRequiredCommands: Array<{ args: string[] }> };
    config.doneRequiredCommands[0].args = ['-e', `const {spawn}=require('child_process');const fs=require('fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(descendantPidFile)},String(c.pid));setTimeout(()=>process.exit(0),${childDurationMs})`];
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    writeFileSync(join(root, '.gitignore'), `${readFileSync(join(root, '.gitignore'), 'utf8')}phase-descendant.pid\n`, 'utf8');
    commitAll(root, 'configure phase-timeout descendant fixture');
    const result = runCli(root, donePrepareRealValidateArgs(storyId, true), {
      LATTICE_DONE_PREPARE_HEARTBEAT_MS: '20',
      LATTICE_DONE_PREPARE_PHASE_TIMEOUT_MS: '5000',
      LATTICE_DONE_PREPARE_DONE_REQUIRED_VALIDATION_TIMEOUT_MS: '500',
      LATTICE_VALIDATE_HEARTBEAT_MS: '20',
    });
    assert.equal(result.status, 1, `phase-timeout done_prepare should return blocked JSON and exit nonzero:\n${result.stderr}\n${result.stdout}`);
    assert.ok(
      result.stderr.includes(DONE_REQUIRED_PROGRESS_LABEL),
      `DONE-required validation phase must be attributed in progress output:\n${result.stderr}`,
    );
    assert.ok(!result.stdout.includes('done_prepare progress:'), `JSON stdout must not contain done_prepare progress text:\n${result.stdout}`);
    assert.ok(!result.stdout.includes('done_prepare heartbeat:'), `JSON stdout must not contain done_prepare heartbeat text:\n${result.stdout}`);
    assert.ok(!result.stdout.includes('validate progress:'), `JSON stdout must not contain validate progress text:\n${result.stdout}`);
    const parsed = JSON.parse(result.stdout) as {
      status?: string;
      blockedAt?: string;
      reason?: string;
      transcript?: string;
      disposition?: string;
      result?: string;
      refusalReasons?: string[];
      timeoutLayer?: string | null;
      existingEvidenceBasis?: string;
    };
    assert.equal(parsed.status, 'blocked');
    assert.equal(parsed.blockedAt, 'validate');
    assert.equal(parsed.disposition, 'executed');
    assert.equal(parsed.result, 'timed_out');
    assert.equal(parsed.timeoutLayer, 'phase');
    assert.ok(Array.isArray(parsed.refusalReasons) && parsed.refusalReasons.length > 0);
    assert.match(parsed.existingEvidenceBasis ?? '', /^(fresh|stale|missing)$/);
    assert.match(parsed.reason ?? '', /done_prepare phase "running DONE-required validation" exceeded 500ms timeout/);
    assert.match(parsed.reason ?? '', /heartbeat output is diagnostic only and does not extend the phase deadline/);
    assert.match(parsed.transcript ?? '', /^blockedAt: validate$/m);

    assert.ok(existsSync(descendantPidFile), 'phase timeout fixture must record its descendant pid');
    await sleep(150);
    const descendantPid = Number(readFileSync(descendantPidFile, 'utf8'));
    assert.throws(() => process.kill(descendantPid, 0), /ESRCH/, 'DONE-required phase abort must kill the descendant process tree before returning');

    await sleep(childDurationMs + 250);
    const evidencePath = join(root, '.lattice', 'story', 'actives', storyId, 'done-required-evidence.json');
    if (existsSync(evidencePath)) {
      const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as { status?: string };
      assert.notEqual(
        evidence.status,
        'PASS',
        `DONE-required phase timeout must not allow a late PASS evidence write:\n${readFileSync(evidencePath, 'utf8')}`,
      );
    }
    const retry = runCli(root, ['done_required_validate', '--storyId', storyId, '--json'], {
      LATTICE_MAX_TIMEOUT_MS: '5000',
      LATTICE_VALIDATE_HEARTBEAT_MS: '20',
    });
    assert.equal(JSON.parse(retry.stdout).result, 'pass', 'phase timeout must release process tree/lock/timers for immediate rerun');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    assertActualReuseSwitchAndValidateFalseBasis();
    assertPreflightBlockOmitsUnobservedValidationFields();
    assertPostValidationCloseoutCliTimeouts();
    assertRealValidateDoneRequiredProgressJsonSafe();
    await assertDoneRequiredPhaseTimeoutFailsClosed();
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
