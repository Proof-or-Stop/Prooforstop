#!/usr/bin/env node

/**
 * @task B-d3f7
 * @checklist CHK-001
 * @title DONE readiness flow timing benchmark
 * @type chore
 * @priority high
 * @description
 * Repeatable benchmark harness for DONE readiness flow optimizations. It runs
 * in isolated temporary repositories and reports before/after-comparable timing
 * for metadata-only evidence drift, done_prepare dirty metadata behavior, and
 * material-drift safety.
 * @changes
 * - [CHK-001] Add a temp-repo benchmark that records metadata drift recovery
 *   time and material drift safety without changing lifecycle semantics.
 * - [CHK-002] Support optional baseline JSON comparison for future before/after
 *   timing validation.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
import { evaluateDoneRequiredEvidence, runDoneRequiredValidation } from '../core/done-required-validation.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, ClosingSelfCheck, DocsPromise, RealMachineTest, StoryInfo } from '../core/types.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');
const COMMIT_ENV = ['-c', 'user.email=benchmark@example.test', '-c', 'user.name=Proofbound Benchmark'];
const DEFAULT_ROUNDS = 3;
const DEFAULT_SLOW_COMMAND_MS = 800;
const METADATA_STORY_ID = 'B-readiness-bench';
const PREPARE_STORY_ID = 'B-readiness-prepare';

interface Args {
  rounds: number;
  slowMs: number;
  baselinePath?: string;
  writeCurrentPath?: string;
  keepTemp: boolean;
}

interface Timed<T> {
  value: T;
  ms: number;
}

interface HashSnapshot {
  headHash?: string;
  materialHash?: string;
  storyFilesHash?: string;
}

interface MetadataRoundResult {
  round: number;
  firstRunMs: number;
  postMetadataEvalMs: number;
  recoveryRerunMs: number;
  recoveryMs: number;
  metadataOnlyHeadChanged: boolean;
  materialSameAfterMetadataCommit: boolean;
  storyFilesSameAfterMetadataCommit: boolean;
  metadataHeadDriftOk: boolean;
  metadataHeadDriftBlocked: boolean;
  metadataHeadDriftReasons: string[];
  materialDriftBlocked: boolean;
  materialDriftReasons: string[];
}

interface DonePrepareDirtyMetadataResult {
  durationMs: number;
  dirtyStatusBefore: string;
  closureDiagnosticProbe: DonePrepareClosureSnapshot;
  closureCanAttemptDone: boolean | null;
  closureBlockingRows: unknown[];
  status: 'pass' | 'blocked' | 'unknown';
  blockedAt: string | null;
  outputFirstLine: string;
  blockerCleared: boolean;
  avoidedHumanLoop: boolean;
}

interface DonePrepareClosureSnapshot {
  closureCanAttemptDone: boolean | null;
  closureBlockingRows: unknown[];
}

interface DonePrepareDirtyMetadataComparison {
  baselineStatus: DonePrepareDirtyMetadataResult['status'] | null;
  currentStatus: DonePrepareDirtyMetadataResult['status'];
  baselineBlockedAt: string | null;
  currentBlockedAt: string | null;
  baselineDurationMs: number | null;
  currentDurationMs: number;
  savedMs: number | null;
  savedPercent: number | null;
  blockerCleared: boolean;
  avoidedHumanLoop: boolean;
}

interface BenchmarkReport {
  status: 'PASS';
  benchmark: 'done-readiness-flow-benchmark';
  schemaVersion: 1;
  rounds: number;
  slowCommandMs: number;
  current: {
    metadataHeadDrift: {
      freshRounds: number;
      blockedRounds: number;
      averageFirstRunMs: number;
      averagePostMetadataEvalMs: number;
      averageRecoveryRerunMs: number;
      averageRecoveryMs: number;
      rounds: MetadataRoundResult[];
    };
    materialDrift: {
      blockedRounds: number;
      reasons: string[];
    };
    donePrepareDirtyMetadata: DonePrepareDirtyMetadataResult;
  };
  baseline?: unknown;
  comparison?: {
    baselineAverageRecoveryMs: number;
    currentAverageRecoveryMs: number;
    savedMs: number;
    savedPercent: number;
    donePrepareDirtyMetadata: DonePrepareDirtyMetadataComparison;
  };
}

function parseArgs(argv: string[]): Args {
  const args: Args = { rounds: DEFAULT_ROUNDS, slowMs: DEFAULT_SLOW_COMMAND_MS, keepTemp: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg.startsWith('--rounds=')) {
      const value = Number(arg.slice('--rounds='.length));
      if (!Number.isInteger(value) || value <= 0) throw new Error(`--rounds must be a positive integer, got ${arg}`);
      args.rounds = value;
    } else if (arg === '--rounds' && next) {
      const value = Number(next);
      if (!Number.isInteger(value) || value <= 0) throw new Error(`--rounds must be a positive integer, got ${next}`);
      args.rounds = value;
      index += 1;
    } else if (arg.startsWith('--slow-ms=')) {
      const value = Number(arg.slice('--slow-ms='.length));
      if (!Number.isInteger(value) || value <= 0) throw new Error(`--slow-ms must be a positive integer, got ${arg}`);
      args.slowMs = value;
    } else if (arg === '--slow-ms' && next) {
      const value = Number(next);
      if (!Number.isInteger(value) || value <= 0) throw new Error(`--slow-ms must be a positive integer, got ${next}`);
      args.slowMs = value;
      index += 1;
    } else if (arg.startsWith('--baseline=')) {
      args.baselinePath = arg.slice('--baseline='.length);
    } else if (arg === '--baseline' && next) {
      args.baselinePath = next;
      index += 1;
    } else if (arg.startsWith('--write-current=')) {
      args.writeCurrentPath = arg.slice('--write-current='.length);
    } else if (arg === '--write-current' && next) {
      args.writeCurrentPath = next;
      index += 1;
    } else if (arg.startsWith('--json-out=')) {
      args.writeCurrentPath = arg.slice('--json-out='.length);
    } else if (arg === '--json-out' && next) {
      args.writeCurrentPath = next;
      index += 1;
    } else if (arg === '--keep-temp') {
      args.keepTemp = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.rounds > 20) throw new Error(`--rounds must be 20 or less, got ${args.rounds}`);
  if (args.slowMs > 10_000) throw new Error(`--slow-ms must be 10000 or less, got ${args.slowMs}`);
  return args;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitCommit(cwd: string, message: string): void {
  git(cwd, [...COMMIT_ENV, 'commit', '-m', message]);
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, 'utf8');
}

function gitStatus(root: string): string {
  return git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
}

function writeConfig(root: string, slowMs: number): void {
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
    workflow: { profile: 'light' },
    doneRequiredCommands: [{
      label: 'slow-required-proof',
      command: 'node',
      args: ['-e', `setTimeout(() => process.exit(0), ${slowMs})`],
    }],
  }, null, 2) + '\n');
  resetConfigCache();
}

function hashes(root: string): HashSnapshot {
  return {
    headHash: currentGitHead(root),
    materialHash: currentMaterialHash(root, 'HEAD', root),
    storyFilesHash: currentStoryFilesHash(root, 'HEAD', root),
  };
}

async function timed<T>(fn: () => T | Promise<T>): Promise<Timed<T>> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - start) };
}

function createStory(store: StoryStore, storyId: string, phase: StoryInfo['phase'] = 'TEST'): void {
  const now = '2026-06-22T00:00:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'done-readiness-flow-benchmark',
    title: 'DONE readiness flow benchmark',
    description: 'Synthetic story used by the DONE readiness flow benchmark.',
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
      title: 'Synthetic benchmark item',
      context: 'Synthetic benchmark context',
      status: 'done',
      startTime: now,
      endTime: now,
    }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
}

function createMetadataFixture(slowMs: number): { root: string; store: StoryStore } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lattice-readiness-metadata-')));
  writeConfig(root, slowMs);
  write(root, 'README.md', '# DONE readiness metadata benchmark\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', 'README.md', 'lattice.config.json']);
  gitCommit(root, 'base');
  const store = new StoryStore(root);
  createStory(store, METADATA_STORY_ID);
  return { root, store };
}

async function runMetadataRound(round: number, slowMs: number, keepTemp: boolean): Promise<MetadataRoundResult> {
  const { root, store } = createMetadataFixture(slowMs);
  try {
    const before = hashes(root);
    const first = await timed(() => runDoneRequiredValidation({
      projectRoot: root,
      storyId: METADATA_STORY_ID,
      store,
      gitCwd: root,
    }));
    assert.equal(first.value.status, 'PASS', `round ${round}: initial DONE-required validation must pass`);

    const immediate = evaluateDoneRequiredEvidence({ projectRoot: root, storyId: METADATA_STORY_ID, store, gitCwd: root });
    assert.equal(immediate.blocking, false, `round ${round}: freshly written evidence must not block: ${immediate.reasons.join(', ')}`);

    git(root, ['add', '.lattice/story/actives']);
    gitCommit(root, 'metadata evidence commit');
    const afterMetadataCommit = hashes(root);

    const metadataEval = await timed(() => evaluateDoneRequiredEvidence({
      projectRoot: root,
      storyId: METADATA_STORY_ID,
      store,
      gitCwd: root,
    }));

    let recoveryRerunMs = 0;
    if (metadataEval.value.blocking) {
      const recovery = await timed(() => runDoneRequiredValidation({
        projectRoot: root,
        storyId: METADATA_STORY_ID,
        store,
        gitCwd: root,
      }));
      assert.equal(recovery.value.status, 'PASS', `round ${round}: recovery rerun must pass`);
      recoveryRerunMs = recovery.ms;
    }

    write(root, 'README.md', '# DONE readiness metadata benchmark changed\n');
    git(root, ['add', 'README.md']);
    gitCommit(root, 'material drift commit');
    const materialEval = evaluateDoneRequiredEvidence({
      projectRoot: root,
      storyId: METADATA_STORY_ID,
      store,
      gitCwd: root,
    });

    const result: MetadataRoundResult = {
      round,
      firstRunMs: first.ms,
      postMetadataEvalMs: metadataEval.ms,
      recoveryRerunMs,
      recoveryMs: metadataEval.ms + recoveryRerunMs,
      metadataOnlyHeadChanged: before.headHash !== afterMetadataCommit.headHash,
      materialSameAfterMetadataCommit: first.value.materialHash === afterMetadataCommit.materialHash,
      storyFilesSameAfterMetadataCommit: first.value.storyFilesHash === afterMetadataCommit.storyFilesHash,
      metadataHeadDriftOk: metadataEval.value.ok,
      metadataHeadDriftBlocked: metadataEval.value.blocking,
      metadataHeadDriftReasons: metadataEval.value.reasons,
      materialDriftBlocked: materialEval.blocking,
      materialDriftReasons: materialEval.reasons,
    };

    assert.equal(result.metadataOnlyHeadChanged, true, `round ${round}: metadata commit must change HEAD`);
    assert.equal(result.materialSameAfterMetadataCommit, true, `round ${round}: metadata commit must not change materialHash`);
    assert.equal(result.storyFilesSameAfterMetadataCommit, true, `round ${round}: metadata commit must not change storyFilesHash`);
    assert.equal(result.materialDriftBlocked, true, `round ${round}: real material drift must block`);
    assert.ok(
      result.materialDriftReasons.includes('stale-material'),
      `round ${round}: material drift must report stale-material, got ${result.materialDriftReasons.join(', ')}`,
    );
    return result;
  } finally {
    if (!keepTemp) rmSync(root, { recursive: true, force: true });
  }
}

function runLattice(
  cwd: string,
  command: string,
  args: Record<string, unknown>,
): string {
  const env = { ...process.env };
  delete env.LATTICE_PROJECT_ROOT;
  const legacyAuthorityEnvPrefix = 'LATTICE_' + 'AUTHORITY_';
  for (const key of Object.keys(env)) {
    if (key.startsWith(legacyAuthorityEnvPrefix)) delete (env as Record<string, string | undefined>)[key];
  }
  return execFileSync(process.execPath, [cliPath, command, JSON.stringify(args)], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function probeDoneClosure(worktreePath: string): DonePrepareClosureSnapshot {
  try {
    const closure = JSON.parse(runLattice(worktreePath, 'done_closure', { storyId: PREPARE_STORY_ID, json: true })) as {
      canAttemptDone?: unknown;
      blockers?: unknown;
    };
    const closureBlockingRows = Array.isArray(closure.blockers)
      ? closure.blockers.filter((row) => {
        const blocker = objectValue(row);
        return blocker?.blocking === true && blocker.status === 'fail';
      })
      : [];
    return {
      closureCanAttemptDone: closure.canAttemptDone === true,
      closureBlockingRows,
    };
  } catch {
    return {
      closureCanAttemptDone: null,
      closureBlockingRows: [],
    };
  }
}

function writeDoneGateEvidence(store: StoryStore, root: string, storyId: string): void {
  const now = '2026-06-22T00:00:00.000Z';
  const storyFilesHash = currentStoryFilesHash(root, 'HEAD', root);
  const headHash = currentGitHead(root);
  const materialHash = currentMaterialHash(root, 'HEAD', root);
  assert.ok(headHash, 'done readiness benchmark fixture must have git HEAD for delivery-check freshness');
  assert.ok(materialHash, 'done readiness benchmark fixture must have materialHash for delivery-check freshness');
  store.writeTestEvidence(storyId, {
    command: 'done-readiness-flow-benchmark',
    output: JSON.stringify({ allPass: true, summary: 'done readiness benchmark ready' }),
    result: 'PASS',
    timestamp: now,
    headHash,
    materialHash,
    ...(storyFilesHash ? { storyFilesHash } : {}),
    verificationCoverage: {
      total: 0,
      required: 0,
      covered: 0,
      missingRequired: 0,
      entries: [],
    },
  });
  store.writeBugs(storyId, { bugs: [] });
  const docsPromises: DocsPromise[] = [];
  const realMachineTests: RealMachineTest[] = [{
    featureId: 'CHK-001',
    transcript: 'done readiness benchmark synthetic transcript',
  }];
  const closingSelfCheck: ClosingSelfCheck = {
    hasRealMachineTest: true,
    hasEdgeCaseCoverage: true,
    hasUnresolvedTodos: false,
    summary: 'done readiness benchmark closure evidence is complete.',
  };
  store.writeDeliveryCheck(storyId, {
    storyId,
    checkedAt: now,
    headHash,
    materialHash,
    reviewRound: '',
    agentId: 'lattice-review-delivery',
    docsPromises,
    realMachineTests,
    closingSelfCheck,
    _hash: signDeliveryCheck(storyId, docsPromises, realMachineTests, closingSelfCheck, '', materialHash),
  });
  store.writeSummary(storyId, {
    storyId,
    createdAt: now,
    updatedAt: now,
    changes: 'Synthetic DONE readiness benchmark fixture.',
    usage: 'Run done-readiness-flow-benchmark.',
    expectedOutcome: 'Synthetic fixture reaches local DONE readiness.',
    actualTranscript: 'Synthetic fixture evidence is present.',
    outcomeDiff: 'No difference.',
    acceptanceVerdict: 'accepted',
    outcomeKind: 'success',
    realMachineCoverage: { ran: [], skipped: [] },
    limitations: 'Synthetic benchmark fixture only.',
    pitfalls: 'None; generated inside a temp repository.',
  });
}

function createDonePrepareFixture(slowMs: number): { root: string; worktreePath: string; store: StoryStore } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lattice-readiness-prepare-')));
  writeConfig(root, slowMs);
  write(root, '.gitignore', '.worktrees/\n.lattice/activity.jsonl\n');
  write(root, 'README.md', '# DONE readiness prepare benchmark\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  gitCommit(root, 'base');

  const store = new StoryStore(root);
  createStory(store, PREPARE_STORY_ID);
  const story = store.readStory(PREPARE_STORY_ID);
  store.writeStory(PREPARE_STORY_ID, {
    ...story,
    worktree: {
      path: `.worktrees/${PREPARE_STORY_ID}`,
      branch: `story/${PREPARE_STORY_ID}`,
      createdAt: '2026-06-22T00:00:00.000Z',
    },
  });
  git(root, ['add', '.']);
  gitCommit(root, 'story metadata');
  git(root, ['branch', `story/${PREPARE_STORY_ID}`]);

  const worktreePath = join(root, '.worktrees', PREPARE_STORY_ID);
  git(root, ['worktree', 'add', worktreePath, `story/${PREPARE_STORY_ID}`]);
  const canonicalWorktreePath = realpathSync(worktreePath);
  resetConfigCache();

  const worktreeStore = new StoryStore(canonicalWorktreePath);
  writeDoneGateEvidence(worktreeStore, canonicalWorktreePath, PREPARE_STORY_ID);
  git(canonicalWorktreePath, ['add', '.']);
  gitCommit(canonicalWorktreePath, 'story ready');

  return { root, worktreePath: canonicalWorktreePath, store: worktreeStore };
}

async function runDonePrepareDirtyMetadataScenario(slowMs: number, keepTemp: boolean): Promise<DonePrepareDirtyMetadataResult> {
  const { root, worktreePath, store } = createDonePrepareFixture(slowMs);
  try {
    const closureDiagnosticProbe = probeDoneClosure(worktreePath);
    assert.equal(
      closureDiagnosticProbe.closureCanAttemptDone,
      false,
      'dirty metadata diagnostic probe must show closure is not attemptable before done-required evidence exists',
    );
    assert.ok(
      closureDiagnosticProbe.closureBlockingRows.length > 0,
      'dirty metadata diagnostic probe must expose at least one closure blocker',
    );

    const doneRequired = await timed(() => runDoneRequiredValidation({
      projectRoot: worktreePath,
      storyId: PREPARE_STORY_ID,
      store,
      gitCwd: worktreePath,
    }));
    assert.equal(doneRequired.value.status, 'PASS', 'dirty metadata scenario requires a fresh done-required evidence file');

    const dirtyStatusBefore = gitStatus(worktreePath);
    assert.match(dirtyStatusBefore, /done-required-evidence\.json/, 'done-required evidence must be dirty before done_prepare scenario');

    const finalClosure = probeDoneClosure(worktreePath);
    assert.equal(
      finalClosure.closureCanAttemptDone,
      true,
      'dirty metadata scenario must be otherwise closure-ready after done-required evidence exists',
    );
    assert.deepEqual(
      finalClosure.closureBlockingRows,
      [],
      'dirty metadata scenario must have no closure blockers after done-required evidence exists',
    );

    const prepared = await timed(() => runLattice(worktreePath, 'done_prepare', {
      storyId: PREPARE_STORY_ID,
      validate: false,
      mergeMain: false,
    }));
    const firstLine = prepared.value.split(/\r?\n/).find(Boolean) || '';
    const blockedAt = prepared.value.match(/blockedAt:\s*([A-Za-z0-9_-]+)/)?.[1] ?? null;
    const status: DonePrepareDirtyMetadataResult['status'] = /DONE prepare: PASS/.test(prepared.value)
      ? 'pass'
      : /DONE prepare: BLOCKED/.test(prepared.value)
        ? 'blocked'
        : 'unknown';
    const blockerCleared = status === 'pass' || (status === 'blocked' && blockedAt !== null && blockedAt !== 'cleanTree');
    return {
      durationMs: prepared.ms,
      dirtyStatusBefore,
      closureDiagnosticProbe,
      closureCanAttemptDone: finalClosure.closureCanAttemptDone,
      closureBlockingRows: finalClosure.closureBlockingRows,
      status,
      blockedAt,
      outputFirstLine: firstLine,
      blockerCleared,
      avoidedHumanLoop: finalClosure.closureCanAttemptDone === true && blockerCleared,
    };
  } finally {
    if (!keepTemp) rmSync(root, { recursive: true, force: true });
  }
}

function average(results: MetadataRoundResult[], key: keyof Pick<MetadataRoundResult, 'firstRunMs' | 'postMetadataEvalMs' | 'recoveryRerunMs' | 'recoveryMs'>): number {
  return Math.round(results.reduce((sum, result) => sum + result[key], 0) / results.length);
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function donePrepareStatusValue(value: unknown): DonePrepareDirtyMetadataResult['status'] | null {
  return value === 'pass' || value === 'blocked' || value === 'unknown' ? value : null;
}

function baselineAverageRecoveryMs(baseline: unknown): number | null {
  const current = objectValue(objectValue(baseline)?.current);
  const metadata = objectValue(current?.metadataHeadDrift);
  return numberValue(metadata?.averageRecoveryMs);
}

function baselineDonePrepareDirtyMetadata(baseline: unknown): Partial<DonePrepareDirtyMetadataResult> | null {
  const current = objectValue(objectValue(baseline)?.current);
  const dirtyMetadata = objectValue(current?.donePrepareDirtyMetadata);
  if (!dirtyMetadata) return null;
  return {
    ...(numberValue(dirtyMetadata.durationMs) !== null ? { durationMs: numberValue(dirtyMetadata.durationMs)! } : {}),
    ...(donePrepareStatusValue(dirtyMetadata.status) !== null ? { status: donePrepareStatusValue(dirtyMetadata.status)! } : {}),
    ...(stringValue(dirtyMetadata.blockedAt) !== null || dirtyMetadata.blockedAt === null ? { blockedAt: stringValue(dirtyMetadata.blockedAt) } : {}),
  };
}

function compareDonePrepareDirtyMetadata(
  baseline: unknown,
  current: DonePrepareDirtyMetadataResult,
): DonePrepareDirtyMetadataComparison {
  const baselineDirtyMetadata = baselineDonePrepareDirtyMetadata(baseline);
  const baselineDurationMs = numberValue(baselineDirtyMetadata?.durationMs);
  const savedMs = baselineDurationMs === null ? null : baselineDurationMs - current.durationMs;
  const savedPercent = baselineDurationMs && savedMs !== null
    ? Math.round((savedMs / baselineDurationMs) * 1000) / 10
    : null;
  const baselineBlockedAt = baselineDirtyMetadata?.blockedAt ?? null;
  return {
    baselineStatus: baselineDirtyMetadata?.status ?? null,
    currentStatus: current.status,
    baselineBlockedAt,
    currentBlockedAt: current.blockedAt,
    baselineDurationMs,
    currentDurationMs: current.durationMs,
    savedMs,
    savedPercent,
    blockerCleared: baselineBlockedAt === 'cleanTree' && current.blockerCleared,
    avoidedHumanLoop: baselineBlockedAt === 'cleanTree' && current.avoidedHumanLoop,
  };
}

function compareToBaseline(
  baseline: unknown,
  currentAverageRecoveryMs: number,
  donePrepareDirtyMetadata: DonePrepareDirtyMetadataResult,
): BenchmarkReport['comparison'] | undefined {
  const baselineMs = baselineAverageRecoveryMs(baseline);
  if (baselineMs === null) return undefined;
  const savedMs = baselineMs - currentAverageRecoveryMs;
  const savedPercent = baselineMs > 0 ? Math.round((savedMs / baselineMs) * 1000) / 10 : 0;
  return {
    baselineAverageRecoveryMs: baselineMs,
    currentAverageRecoveryMs,
    savedMs,
    savedPercent,
    donePrepareDirtyMetadata: compareDonePrepareDirtyMetadata(baseline, donePrepareDirtyMetadata),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseline = args.baselinePath
    ? JSON.parse(readFileSync(args.baselinePath, 'utf8')) as unknown
    : undefined;

  const rounds: MetadataRoundResult[] = [];
  for (let round = 1; round <= args.rounds; round += 1) {
    rounds.push(await runMetadataRound(round, args.slowMs, args.keepTemp));
  }
  const donePrepareDirtyMetadata = await runDonePrepareDirtyMetadataScenario(args.slowMs, args.keepTemp);
  const averageRecoveryMs = average(rounds, 'recoveryMs');
  const report: BenchmarkReport = {
    status: 'PASS',
    benchmark: 'done-readiness-flow-benchmark',
    schemaVersion: 1,
    rounds: args.rounds,
    slowCommandMs: args.slowMs,
    current: {
      metadataHeadDrift: {
        freshRounds: rounds.filter(result => !result.metadataHeadDriftBlocked).length,
        blockedRounds: rounds.filter(result => result.metadataHeadDriftBlocked).length,
        averageFirstRunMs: average(rounds, 'firstRunMs'),
        averagePostMetadataEvalMs: average(rounds, 'postMetadataEvalMs'),
        averageRecoveryRerunMs: average(rounds, 'recoveryRerunMs'),
        averageRecoveryMs,
        rounds,
      },
      materialDrift: {
        blockedRounds: rounds.filter(result => result.materialDriftBlocked && result.materialDriftReasons.includes('stale-material')).length,
        reasons: unique(rounds.flatMap(result => result.materialDriftReasons)),
      },
      donePrepareDirtyMetadata,
    },
    ...(baseline !== undefined ? { baseline } : {}),
    ...(baseline !== undefined ? { comparison: compareToBaseline(baseline, averageRecoveryMs, donePrepareDirtyMetadata) } : {}),
  };

  assert.equal(report.current.materialDrift.blockedRounds, args.rounds, 'every material-drift round must block');
  assert.notEqual(report.current.donePrepareDirtyMetadata.status, 'unknown', 'done_prepare dirty metadata result must be classified');
  assert.equal(
    report.current.donePrepareDirtyMetadata.closureCanAttemptDone,
    true,
    'dirty metadata scenario precondition must be DONE-closure ready before done_prepare',
  );
  assert.notEqual(
    `${report.current.donePrepareDirtyMetadata.status}:${report.current.donePrepareDirtyMetadata.blockedAt}`,
    'blocked:cleanTree',
    'metadata-only done-required-evidence dirt must not block done_prepare at cleanTree',
  );

  if (args.writeCurrentPath) {
    writeFileSync(args.writeCurrentPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  console.log('done-readiness-flow-benchmark passed');
  console.log(JSON.stringify(report, null, 2));
}

await main();
