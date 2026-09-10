#!/usr/bin/env node

/**
 * Smoke: opt-in done_prepare generated-metadata auto-closeout is manifest-only,
 * JSON-clean, and fail-closed.
 *
 * Run:
 *   node packages/main/dist/tasks/done-prepare-auto-closeout-smoke.js
 */

import assert from 'node:assert/strict';
import { stateDirCandidates } from '../core/brand-paths.js';
import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

import { resetConfigCache } from '../core/config.js';
import { DONE_PREPARE_SCHEMA } from '../core/artifact-schema.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash, EMPTY_STORY_FILES_HASH } from '../core/evidence-freshness.js';
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
import { StoryStore } from '../core/store.js';
import { acquireOwnerLease, getSessionId } from '../core/story-owner-lease.js';
import { persistSyntheticAdmittedWindowForTest } from '../core/certification-window.js';
import { deriveCertificationDomainInputHashes } from '../handlers/certification-window.js';
import { createPlaybookRuntimeMemoryHandlers } from '../handlers/playbook-runtime-memory.js';
import { RUNTIME_ARTIFACT_REGISTRY } from '../core/runtime-artifact-registry.js';
import {
  buildDonePrepareGeneratedMetadataManifest,
  captureDonePrepareGeneratedMetadataBaseline,
  captureDonePrepareGeneratedMetadataTransaction,
  commitDonePrepareGeneratedMetadata,
  gitStatusRowsForDonePrepareGeneratedMetadata,
  rollbackDonePrepareGeneratedMetadataTransaction,
  type DonePrepareGeneratedProcessEventBinding,
} from '../core/done-prepare-generated-metadata.js';
import type {
  ChecklistData,
  ClosingSelfCheck,
  DeliveryCheckData,
  DocsPromise,
  RealMachineTest,
  StoryInfo,
  TestEvidenceData,
} from '../core/types.js';
import { captureDonePrepareValidationReuseBasis, writeDonePrepareValidationReuseRecord } from '../core/done-prepare-validation-reuse.js';
import { createDonePrepareHandlers } from '../handlers/done-prepare.js';
import type { HandlerContext } from '../handlers/context.js';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'cli.js');
const repoRoot = join(here, '../../../..');
const NOW = '2026-07-09T00:00:00.000Z';
const STORY_ID = 'B-done-prepare-auto-closeout';
const AUTO_CLOSE_MESSAGE = `proof-or-stop: auto-close ${STORY_ID} generated DONE metadata`;

interface Fixture {
  root: string;
  storyId: string;
}

interface FixtureOptions {
  counterPath?: string;
  unsafeDoneRequiredSideEffect?: boolean;
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
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
      ...gitIdentityEnv(),
    },
  }).trim();
}

function gitIdentityEnv(): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: 'done-prepare-auto-closeout-smoke',
    GIT_AUTHOR_EMAIL: 'done-prepare-auto-closeout-smoke@example.test',
    GIT_COMMITTER_NAME: 'done-prepare-auto-closeout-smoke',
    GIT_COMMITTER_EMAIL: 'done-prepare-auto-closeout-smoke@example.test',
  };
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

function runCli(root: string, args: string[], env: Record<string, string> = {}): CliResult {
  const result = spawnSync(process.execPath, [cliPath, '--root', root, ...args], {
    cwd: root,
    env: { ...process.env, PROOF_OR_STOP_SESSION_ID: getSessionId(), ...gitIdentityEnv(), ...env },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 15_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function donePrepareAutoCloseArgs(storyId: string, json = false): string[] {
  return [
    'done_prepare',
    '--storyId', storyId,
    '--mergeMain=false',
    '--refreshStale=false',
    '--validate=true',
    '--autoCloseGeneratedMetadata=true',
    '--reuseFreshValidation=true',
    ...(json ? ['--json'] : []),
  ];
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
    command: 'done_prepare auto-closeout seed',
    output: JSON.stringify({ allPass: true, summary: 'synthetic validation seed passed' }),
    result: 'PASS',
    timestamp: NOW,
    headHash,
    materialHash,
    ...(rawStoryFilesHash ? { storyFilesHash: rawStoryFilesHash } : {}),
  };
  store.writeTestEvidence(storyId, testEvidence);

  const docsPromises: DocsPromise[] = [];
  const realMachineTests: RealMachineTest[] = [{
    featureId: 'done-prepare-auto-closeout',
    transcript: 'Synthetic fixture proves manifest-only auto-closeout behavior.',
  }];
  const closingSelfCheck: ClosingSelfCheck = {
    hasRealMachineTest: true,
    hasEdgeCaseCoverage: true,
    hasUnresolvedTodos: false,
    summary: 'Synthetic delivery check covers auto-closeout behavior.',
  };
  const deliveryCheck: DeliveryCheckData = {
    storyId,
    checkedAt: NOW,
    headHash,
    materialHash,
    ...(storyFilesHash ? { storyFilesHash } : {}),
    reviewRound: NOW,
    agentId: 'proof-or-stop-review-delivery',
    docsPromises,
    realMachineTests,
    closingSelfCheck,
    _hash: signDeliveryCheck(storyId, docsPromises, realMachineTests, closingSelfCheck, NOW, materialHash, storyFilesHash),
  };
  store.writeDeliveryCheck(storyId, deliveryCheck);
}

function setupFixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-done-prepare-auto-closeout-'));
  const unsafeScript = [
    "const fs = require('fs');",
    "fs.mkdirSync('docs', { recursive: true });",
    "fs.writeFileSync('docs/unsafe.md', 'unsafe side effect\\n');",
  ].join(' ');
  const config = {
    scanRoot: '.',
    rootDir: '.',
    testsDir: 'tests',
    fixturesDir: 'tests/fixtures',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'light' },
    validate: {
      commands: [{
        label: 'smoke validate',
        command: process.execPath,
        args: ['-e', options.counterPath ? `require('fs').appendFileSync(${JSON.stringify(options.counterPath)}, 'start\\n')` : 'process.exit(0)'],
        timeoutMs: 2000,
      }],
    },
    doneRequiredCommands: [{
      label: options.unsafeDoneRequiredSideEffect ? 'unsafe side-effect DONE-required validation' : 'smoke DONE-required validation',
      command: process.execPath,
      args: ['-e', options.unsafeDoneRequiredSideEffect ? unsafeScript : options.counterPath ? `require('fs').appendFileSync(${JSON.stringify(options.counterPath)}, 'start\\n')` : 'process.exit(0)'],
      timeoutMs: 2000,
    }],
    staleThresholds: {
      phaseStale: 10_000_000,
      itemStale: 10_000_000,
      idleProofOrStop: 10_000_000,
      bugStale: 10_000_000,
    },
  };
  write(root, 'proof-or-stop.config.json', JSON.stringify(config, null, 2) + '\n');
  // B-cc10 F-074: these ignore rules covered ONLY the deprecated state dir, but the runtime
  // now writes activity / learning cache / locks under the CANONICAL one. The uncovered
  // canonical cache file then read as untracked and blocked cleanTree ('DONE prepare:
  // BLOCKED'). Both spellings are covered, derived from the resolver.
  write(root, '.gitignore', [
    ...stateDirCandidates('activity.jsonl'),
    ...RUNTIME_ARTIFACT_REGISTRY.filter(entry => ['runtime-story-owner-lease', 'runtime-cache'].includes(entry.id)).flatMap(entry => entry.ignorePatterns ?? []),
    ...stateDirCandidates('learning/runtime-memory-pack-cache').map((rel) => `${rel}/`),
    ...stateDirCandidates('locks').map((rel) => `${rel}/`),
    '',
  ].join('\n'));
  write(root, 'README.md', '# done_prepare auto-closeout fixture\n');

  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  commitAll(root, 'seed done_prepare auto-closeout fixture');
  git(root, ['checkout', '-B', `story/${STORY_ID}`]);

  resetConfigCache();
  const store = new StoryStore(root);
  store.writeStory(STORY_ID, {
    storyId: STORY_ID,
    name: 'done-prepare-auto-closeout',
    title: 'done_prepare auto-closeout smoke',
    description: 'Synthetic TEST story for done_prepare generated metadata auto-closeout.',
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
      title: 'Auto-closeout smoke fixture',
      context: 'Synthetic done item for done_prepare auto-closeout coverage.',
      status: 'done',
      startTime: NOW,
      endTime: NOW,
    }],
  } as ChecklistData);
  const attemptMaterialHash = currentMaterialHash(root, 'HEAD', root)!;
  const attemptStoryFilesHash = currentStoryFilesHash(root, 'HEAD', root)!;
  store.appendProcessEvent(STORY_ID, {
    type: 'phase_transition', storyId: STORY_ID, attemptId: NOW, fromPhase: 'DEV', toPhase: 'REVIEW',
    materialHash: attemptMaterialHash, storyFilesHash: attemptStoryFilesHash, reviewRound: NOW,
  });
  store.appendProcessEvent(STORY_ID, {
    type: 'phase_transition', storyId: STORY_ID, attemptId: NOW, fromPhase: 'REVIEW', toPhase: 'TEST',
    materialHash: attemptMaterialHash, storyFilesHash: attemptStoryFilesHash, reviewRound: NOW,
  });
  createPlaybookRuntimeMemoryHandlers(mkCtx(root)).dev_memory_finish_decision({ storyId: STORY_ID, decision: 'no-reusable-lesson', reason: 'Disposable closeout integration fixture has no implementation lesson to capture.' });
  seedDoneGateEvidence(root, STORY_ID);
  commitAll(root, 'seed done_prepare auto-closeout story metadata');
  acquireOwnerLease(store.storyDirPath(STORY_ID), { command: 'done_prepare', cwd: root });
  // Synthetic admission only: this fixture does not prove real review inventory completion.
  const causalInputHashes = deriveCertificationDomainInputHashes(root, 'HEAD', root);
  assert.ok(causalInputHashes);
  persistSyntheticAdmittedWindowForTest({ store, storyId: STORY_ID, projectRoot: root, causalInputHashes });
  commitAll(root, 'seed synthetic certification admission');
  assert.equal(git(root, ['status', '--porcelain']), '', 'fixture must start clean');
  return { root, storyId: STORY_ID };
}

async function withEnv<T>(patch: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(patch)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withEnvSync<T>(patch: Record<string, string>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(patch)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function installCommandSpy(observed: string[]): () => void {
  const originalExecFileSync = childProcess.execFileSync;
  const originalExecSync = childProcess.execSync;
  const record = (command: unknown, args?: unknown): void => {
    const argv = Array.isArray(args) ? args.map(String) : [];
    const line = [String(command), ...argv].join(' ');
    observed.push(line);
    if (String(command).endsWith('git')) {
      const forbidden = ['push', 'stash', 'reset', 'clean', 'checkout', 'switch'];
      assert.equal(argv.includes('--no-verify'), false, `auto-closeout must not use --no-verify: ${line}`);
      assert.equal(argv.some((arg) => forbidden.includes(arg)), false, `auto-closeout must not use forbidden git operation: ${line}`);
    }
    assert.equal(/release|publish|delivery_check_set|review_pass_set|quorum_submit|authority/i.test(line), false, `auto-closeout must not auto-sign or publish: ${line}`);
  };

  childProcess.execFileSync = ((command: string, argsOrOptions?: readonly string[] | childProcess.ExecFileSyncOptions, options?: childProcess.ExecFileSyncOptions) => {
    record(command, Array.isArray(argsOrOptions) ? argsOrOptions : undefined);
    return (originalExecFileSync as any)(command, argsOrOptions as any, options);
  }) as typeof childProcess.execFileSync;
  childProcess.execSync = ((command: string, options?: childProcess.ExecSyncOptions) => {
    record(command);
    return (originalExecSync as any)(command, options);
  }) as typeof childProcess.execSync;
  syncBuiltinESMExports();

  return () => {
    childProcess.execFileSync = originalExecFileSync;
    childProcess.execSync = originalExecSync;
    syncBuiltinESMExports();
  };
}

async function assertForeignIndexSurvivesOuterCloseout(mode: 'foreign' | 'owned' = 'foreign'): Promise<void> {
  const { root, storyId } = setupFixture();
  const previousCwd = process.cwd();
  const original = childProcess.execFileSync;
  let prepared = false;
  let injected = false;
  let reuseReached = false;
  let foreignPath = '';
  let headBeforeFailure = '';
  let baselineDoneBytes = '';
  let baselineStatus = '';
  try {
    process.chdir(root);
    childProcess.execFileSync = ((command: string, argsOrOptions?: readonly string[] | childProcess.ExecFileSyncOptions, options?: childProcess.ExecFileSyncOptions) => {
      const argv = Array.isArray(argsOrOptions) ? argsOrOptions.map(String) : [];
      if (prepared && !injected && String(command).endsWith('git') && argv[0] === 'update-index' && argv.includes('--cacheinfo')) {
        const evidence = new StoryStore(root).readDoneRequiredEvidence(storyId) as any;
        if (evidence?.donePrepareValidationReuse) {
          reuseReached = true;
          injected = true;
          foreignPath = argv[argv.length - 1];
          headBeforeFailure = git(root, ['rev-parse', 'HEAD^']);
          if (mode === 'foreign') {
            write(root, foreignPath, 'FOREIGN');
            git(root, ['add', '--', foreignPath]);
          }
          throw new Error('outer closeout injected refresh failure after foreign stage');
        }
      }
      return (original as any)(command, argsOrOptions as any, options);
    }) as typeof childProcess.execFileSync;
    syncBuiltinESMExports();
    const transcript = await withEnv(gitIdentityEnv(), async () => String(await createDonePrepareHandlers(mkCtx(root, message => {
      if (!prepared && message === 'done_prepare progress: checking clean tree') {
        const path = `.proof-or-stop/story/actives/${storyId}/test-evidence.json`;
        write(root, path, readFileSync(join(root, path), 'utf8') + '\n');
        baselineDoneBytes = readFileSync(join(root, `.proof-or-stop/story/actives/${storyId}/done-required-evidence.json`), 'utf8');
        baselineStatus = git(root, ['status', '--porcelain']);
        prepared = true;
      }
    })).done_prepare({ storyId, mergeMain: false, refreshStale: false, validate: true,
      autoCloseGeneratedMetadata: true, reuseFreshValidation: true })));
    assert.equal(prepared, true, 'Control must create a current-window safe output delta');
    assert.equal(reuseReached, true, `Control must reach the actual reuse/auto-closeout branch: ${transcript}`);
    assert.equal(injected, true);
    assert.match(transcript, /auto-closeout refused/);
    assert.equal(git(root, ['rev-parse', 'HEAD']), headBeforeFailure);
    if (mode === 'foreign') {
      assert.equal(git(root, ['show', `:${foreignPath}`]), 'FOREIGN', 'Outer rollback must preserve foreign staging');
      assert.equal(readFileSync(join(root, foreignPath), 'utf8'), 'FOREIGN', 'Outer rollback must preserve foreign worktree bytes');
      console.log('DONE_PREPARE_OUTER_FOREIGN_INDEX_GREEN');
    } else {
      assert.equal(readFileSync(join(root, `.proof-or-stop/story/actives/${storyId}/done-required-evidence.json`), 'utf8'), baselineDoneBytes, 'Ordinary refusal restores its own reuse write');
      assert.equal(git(root, ['status', '--porcelain']), baselineStatus, 'Ordinary refusal adds no dirty residue to the captured boundary');
      console.log('DONE_PREPARE_OUTER_OWNED_ROLLBACK_GREEN');
    }
  } finally {
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertManifestOnlyAutoCloseout(): Promise<void> {
  const { root, storyId } = setupFixture();
  const oldCwd = process.cwd();
  const observed: string[] = [];
  const restoreSpy = installCommandSpy(observed);
  try {
    process.chdir(root);
    const deliveryBefore = readFileSync(join(root, '.proof-or-stop', 'story', 'actives', storyId, 'delivery-check.json'), 'utf8');
    const beforeHead = git(root, ['rev-parse', 'HEAD']);
    const logs: string[] = [];
    const transcript = await withEnv(gitIdentityEnv(), async () => String(await createDonePrepareHandlers(mkCtx(root, (msg) => logs.push(msg))).done_prepare({
      storyId,
      mergeMain: false,
      refreshStale: false,
      validate: true,
      autoCloseGeneratedMetadata: true,
      reuseFreshValidation: true,
    })));

    assert.match(transcript, /^DONE prepare: PASS/, transcript);
    // B-f824: one validate execution per command set in the whole window,
    // so observable reviewWindowSuiteExecutions is 0 alongside the blocking counter.
    assert.match(transcript, /^convergence: metadataRollbacks=0 reviewerReattestations=0 postTestReviewerReattestations=0 humanConfirmations=0 unchangedSuiteExecutions=0 reviewWindowSuiteExecutions=0 successfulCloseout=1$/m);
    assert.doesNotMatch(transcript, /^autoCloseGeneratedMetadata:/m, 'canonical validation writers converge without nested auto-closeout recursion');
    // B-cdf6:F-047 follow-on — a stale brand assertion, same class as F-030/F-041.
    // The shipped handler at done-prepare.ts:1720 emits `proof-or-stop story_advance
    // ...`, so this pinned the pre-rename form. It was masked until the commit-prefix
    // fix let execution reach this line.
    // (Wording note: the earlier draft of this comment put the word `production`
    // immediately before `DONE:` across a line break, which the retired-authority
    // vocabulary guard correctly flagged as banned phrasing. Reworded, not exempted.)
    assert.match(transcript, /proof-or-stop story_advance '\{"storyId":"B-done-prepare-auto-closeout","phase":"DONE"\}'/);
    assert.doesNotMatch(transcript, /\bproofOrStop story_advance /);
    assert.ok(logs.some((line) => line.includes('done_prepare convergence: retained review across trusted validation metadata advance')), 'trusted metadata advance is logged to the side channel');
    assert.equal(git(root, ['status', '--porcelain']), '', 'auto-closeout leaves the worktree clean');
    assert.notEqual(git(root, ['log', '-1', '--pretty=%s']), AUTO_CLOSE_MESSAGE, 'one-pass closeout must not create the legacy synthetic auto-close commit');
    const committedFiles = git(root, ['diff', '--name-only', `${beforeHead}..HEAD`])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();
    assert.deepEqual(committedFiles, [
      `.proof-or-stop/story/actives/${storyId}/certification-window.json`,
      `.proof-or-stop/story/actives/${storyId}/closeout-write-receipts.jsonl`,
      `.proof-or-stop/story/actives/${storyId}/done-required-evidence.json`,
      `.proof-or-stop/story/actives/${storyId}/process-events.jsonl`,
      `.proof-or-stop/story/actives/${storyId}/test-evidence.json`,
    ]);
    const evidenceStore = new StoryStore(root);
    const evidence = evidenceStore.readDoneRequiredEvidence(storyId) as any;
    assert.equal(evidence.donePrepareValidationReuse, undefined, 'direct one-pass closeout needs no recursive validation-reuse record');
    assert.equal(evidenceStore.readTestEvidence(storyId)?.commandExecution?.commandCount, 1, 'routine validation suite executes exactly once');
    assert.equal(evidence.receipts?.length, 1, 'DONE-required suite executes exactly once');
    assert.equal(
      readFileSync(join(root, '.proof-or-stop', 'story', 'actives', storyId, 'delivery-check.json'), 'utf8'),
      deliveryBefore,
      'done_prepare must not self-sign or rewrite delivery-check evidence',
    );

    const reuseHeadBefore = git(root, ['rev-parse', 'HEAD']);
    const reuseEventCountBefore = evidenceStore.readProcessEvents(storyId)
      .filter((event) => event.type === 'validation_terminal').length;
    const reuseLogs: string[] = [];
    const reuseTranscript = await withEnv(gitIdentityEnv(), async () => String(await createDonePrepareHandlers(
      mkCtx(root, (msg) => reuseLogs.push(msg)),
    ).done_prepare({
      storyId,
      mergeMain: false,
      refreshStale: false,
      validate: true,
      autoCloseGeneratedMetadata: true,
      reuseFreshValidation: true,
      reuseFreshDoneRequired: true,
    })));
    assert.match(reuseTranscript, /^DONE prepare: PASS/, reuseTranscript);
    assert.ok(
      reuseLogs.some((line) => line.includes('routine validation reused; commandExecutions=0')),
      'same-run reused validation is observable before the canonical transaction closes it',
    );
    assert.ok(
      !reuseLogs.some((line) => line.includes('done_prepare auto-closeout: committed generated metadata')),
      'canonical validation transaction leaves no duplicate generated metadata for done_prepare to close',
    );
    assert.equal(git(root, ['status', '--porcelain']), '', 'reused-validation canonical transaction leaves the worktree clean');
    assert.equal(git(root, ['log', '-1', '--pretty=%s']), `proof-or-stop: record ${storyId} validate metadata`);
    assert.deepEqual(
      git(root, ['diff', '--name-only', `${reuseHeadBefore}..HEAD`]).split('\n').filter(Boolean).sort(),
      [
        `.proof-or-stop/story/actives/${storyId}/closeout-write-receipts.jsonl`,
        `.proof-or-stop/story/actives/${storyId}/process-events.jsonl`,
        `.proof-or-stop/story/actives/${storyId}/test-evidence.json`,
      ],
      'reused validation atomically closes only its canonical PASS, terminal, and receipt',
    );
    const reuseTerminals = evidenceStore.readProcessEvents(storyId)
      .filter((event) => event.type === 'validation_terminal');
    assert.equal(reuseTerminals.length, reuseEventCountBefore + 1);
    assert.equal(reuseTerminals.at(-1)?.disposition, 'reused');
    assert.equal(reuseTerminals.at(-1)?.commandExecutions, 0);
  } finally {
    restoreSpy();
    process.chdir(oldCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertPreexistingProcessEventsRemainFailClosed(): Promise<void> {
  const { root, storyId } = setupFixture();
  const oldCwd = process.cwd();
  try {
    process.chdir(root);
    const first = await withEnv(gitIdentityEnv(), async () => String(await createDonePrepareHandlers(mkCtx(root)).done_prepare({
      storyId,
      mergeMain: false,
      refreshStale: false,
      validate: true,
      autoCloseGeneratedMetadata: true,
      reuseFreshValidation: true,
    })));
    assert.match(first, /^DONE prepare: PASS/, first);

    new StoryStore(root).appendProcessEvent(storyId, {
      type: 'human_confirmation',
      storyId,
      reason: 'pre-existing dirty process event must not be adopted by done_prepare',
    });
    assert.match(git(root, ['status', '--porcelain']), /process-events\.jsonl/);

    const retry = await withEnv(gitIdentityEnv(), async () => String(await createDonePrepareHandlers(mkCtx(root)).done_prepare({
      storyId,
      mergeMain: false,
      refreshStale: false,
      validate: true,
      autoCloseGeneratedMetadata: true,
      reuseFreshValidation: true,
      reuseFreshDoneRequired: true,
    })));
    assert.match(retry, /^DONE prepare: BLOCKED/, retry);
    assert.match(retry, /^blockedAt: validate$/m);
    assert.match(retry, /process-events\.jsonl/);
    assert.match(retry, /canonical metadata was already dirty/);
    assert.match(git(root, ['status', '--porcelain']), /process-events\.jsonl/);
  } finally {
    process.chdir(oldCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertUnsafePathRefusesBeforeReuseRecord(): Promise<void> {
  const { root, storyId } = setupFixture({ unsafeDoneRequiredSideEffect: true });
  const oldCwd = process.cwd();
  try {
    process.chdir(root);
    const transcript = await withEnv(gitIdentityEnv(), async () => String(await createDonePrepareHandlers(mkCtx(root)).done_prepare({
      storyId,
      mergeMain: false,
      refreshStale: false,
      validate: true,
      autoCloseGeneratedMetadata: true,
      reuseFreshValidation: true,
    })));
    assert.match(transcript, /^DONE prepare: BLOCKED/, transcript);
    assert.match(transcript, /^blockedAt: cleanTree$/m);
    assert.match(transcript, /auto-closeout refused/);
    assert.match(transcript, /docs\/unsafe\.md/);
    assert.notEqual(git(root, ['log', '-1', '--pretty=%s']), AUTO_CLOSE_MESSAGE, 'unsafe refusal must not create the auto-closeout commit');
    const evidence = new StoryStore(root).readDoneRequiredEvidence(storyId) as any;
    assert.equal(evidence.donePrepareValidationReuse, undefined, 'unsafe manifest refusal happens before writing reuse metadata');
    assert.match(git(root, ['status', '--porcelain', '--untracked-files=all']), /docs\/unsafe\.md/);
  } finally {
    process.chdir(oldCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertCommitHookFailureRemainsFailClosed(): Promise<void> {
  const { root, storyId } = setupFixture();
  const oldCwd = process.cwd();
  try {
    process.chdir(root);
    const hookPath = join(root, '.git', 'hooks', 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho failing pre-commit >&2\nexit 1\n', 'utf8');
    chmodSync(hookPath, 0o755);

    const headBefore = git(root, ['rev-parse', 'HEAD']);
    const safePaths = [
      `.proof-or-stop/story/actives/${storyId}/closeout-write-receipts.jsonl`,
      `.proof-or-stop/story/actives/${storyId}/done-required-evidence.json`,
      `.proof-or-stop/story/actives/${storyId}/process-events.jsonl`,
      `.proof-or-stop/story/actives/${storyId}/test-evidence.json`,
    ];
    const transcript = await withEnv(gitIdentityEnv(), async () => String(await createDonePrepareHandlers(mkCtx(root)).done_prepare({
      storyId,
      mergeMain: false,
      refreshStale: false,
      validate: true,
      autoCloseGeneratedMetadata: true,
      reuseFreshValidation: true,
    })));

    assert.match(transcript, /^DONE prepare: BLOCKED/, transcript);
    assert.match(transcript, /^blockedAt: validate$/m);
    assert.doesNotMatch(transcript, /^blockedAt: (?:cleanTree|done)$/m);
    assert.match(transcript, /canonical-validation-persistence-failed/);
    assert.match(transcript, /git pre-commit hook failed: failing pre-commit/);
    assert.doesNotMatch(transcript, /^DONE prepare: PASS/m, 'failed canonical validation persistence must never report PASS');
    assert.equal(git(root, ['rev-parse', 'HEAD']), headBefore, 'failed canonical writer commits must not advance HEAD');
    const stagedSafePaths = git(root, ['diff', '--cached', '--name-only', '--', ...safePaths])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();
    assert.deepEqual(stagedSafePaths, [], 'failed validation persistence must restore the captured index state');
    const unstagedSafePaths = git(root, ['diff', '--name-only', '--', ...safePaths])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const untrackedSafePaths = git(root, ['ls-files', '--others', '--exclude-standard', '--', ...safePaths])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    assert.deepEqual([...unstagedSafePaths, ...untrackedSafePaths], [], 'failed validation persistence must restore all bounded generated metadata bytes');
    const evidence = new StoryStore(root).readDoneRequiredEvidence(storyId) as any;
    assert.equal(evidence?.donePrepareValidationReuse, undefined, 'failed writer commits must not mint a validation reuse claim');
  } finally {
    process.chdir(oldCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

function assertPreexistingLifecycleMetadataIsUnsafe(): void {
  const { root, storyId } = setupFixture();
  try {
    const testEvidencePath = `.proof-or-stop/story/actives/${storyId}/test-evidence.json`;
    write(root, testEvidencePath, JSON.stringify({ preexisting: true }, null, 2) + '\n');
    const rows = gitStatusRowsForDonePrepareGeneratedMetadata(root);
    assert.match(rows.join('\n'), /test-evidence\.json/, 'fixture must have pre-existing lifecycle metadata dirt');
    const baseline = captureDonePrepareGeneratedMetadataBaseline({
      root,
      storyDirRel: '.proof-or-stop/story/actives',
      storyId,
      initialDirtyRows: rows,
    });
    const manifest = buildDonePrepareGeneratedMetadataManifest({
      root,
      storyId,
      storyDirRel: '.proof-or-stop/story/actives',
      baseline,
      statusRows: rows,
    });
    const entry = manifest.entries.find((candidate) => candidate.path === testEvidencePath);
    assert.ok(entry, 'pre-existing lifecycle metadata dirt must appear in the manifest');
    assert.equal(entry.safety, 'unsafe_preexisting_dirty');
    assert.equal(entry.currentRunGenerated, false);
    assert.equal(entry.safeToAutoStage, false);
    assert.deepEqual(manifest.safePaths, []);
    assert.deepEqual(manifest.unsafePaths, [testEvidencePath]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertProcessEventBindingIsExactAndFailClosed(): void {
  const { root, storyId } = setupFixture();
  try {
    const processEventsPath = `.proof-or-stop/story/actives/${storyId}/process-events.jsonl`;
    const baseline = captureDonePrepareGeneratedMetadataBaseline({
      root,
      storyDirRel: '.proof-or-stop/story/actives',
      storyId,
      initialDirtyRows: [],
    });
    const before = baseline.initialContents[processEventsPath];
    assert.ok(before?.endsWith('\n'));
    const expected: DonePrepareGeneratedProcessEventBinding = {
      storyId,
      attemptId: NOW,
      reviewRound: NOW,
      commandSetHash: 'a'.repeat(64),
      materialHash: 'b'.repeat(64),
      storyFilesHash: 'c'.repeat(64),
      phase: 'TEST',
      disposition: 'reused',
      result: 'pass',
      commandExecutions: 0,
      notBefore: '2026-07-09T00:00:01.000Z',
      notAfter: '2026-07-09T00:00:03.000Z',
    };
    const validEvent = {
      type: 'validation_terminal',
      storyId,
      attemptId: NOW,
      phase: 'TEST',
      reviewRound: NOW,
      commandSetHash: expected.commandSetHash,
      disposition: 'reused',
      commandExecutions: 0,
      result: 'pass',
      materialHash: expected.materialHash,
      storyFilesHash: expected.storyFilesHash,
      timestamp: '2026-07-09T00:00:02.000Z',
    };
    const classify = (content: string) => {
      write(root, processEventsPath, content);
      return buildDonePrepareGeneratedMetadataManifest({
        root,
        storyId,
        storyDirRel: '.proof-or-stop/story/actives',
        baseline,
        statusRows: gitStatusRowsForDonePrepareGeneratedMetadata(root),
        expectedProcessEventBinding: expected,
      });
    };
    const line = (event: unknown): string => `${before}${JSON.stringify(event)}\n`;
    const valid = classify(line(validEvent));
    assert.deepEqual(valid.safePaths, [processEventsPath], 'exact current-invocation binding is eligible');
    assert.deepEqual(valid.unsafePaths, []);

    const invalidCases: Array<[string, string]> = [
      ['different story', line({ ...validEvent, storyId: 'B-forged' })],
      ['different attempt', line({ ...validEvent, attemptId: 'forged-attempt' })],
      ['different review round', line({ ...validEvent, reviewRound: 'forged-round' })],
      ['different command set', line({ ...validEvent, commandSetHash: 'd'.repeat(64) })],
      ['different material', line({ ...validEvent, materialHash: 'd'.repeat(64) })],
      ['different story files', line({ ...validEvent, storyFilesHash: 'd'.repeat(64) })],
      ['extra field', line({ ...validEvent, forged: true })],
      ['wrong phase', line({ ...validEvent, phase: 'REVIEW' })],
      ['wrong disposition', line({ ...validEvent, disposition: 'executed' })],
      ['wrong result', line({ ...validEvent, result: 'fail' })],
      ['nonzero executions', line({ ...validEvent, commandExecutions: 1 })],
      ['bad hash', line({ ...validEvent, commandSetHash: 'not-a-hash' })],
      ['outside run boundary', line({ ...validEvent, timestamp: '2026-07-09T00:00:04.000Z' })],
      ['bad timestamp', line({ ...validEvent, timestamp: 'not-a-timestamp' })],
      ['malformed json', `${before}{not-json}\n`],
      ['missing final newline', `${before}${JSON.stringify(validEvent)}`],
      ['prefix rewrite', `rewritten-prefix\n${JSON.stringify(validEvent)}\n`],
      ['prefix truncation', `${before.slice(0, -2)}${JSON.stringify(validEvent)}\n`],
      ['mixed valid and invalid', `${line(validEvent)}${JSON.stringify({ ...validEvent, storyId: 'B-forged' })}\n`],
    ];
    for (const [name, content] of invalidCases) {
      const manifest = classify(content);
      const entry = manifest.entries.find((candidate) => candidate.path === processEventsPath);
      assert.equal(entry?.safety, 'unsafe_untrusted_process_events_delta', name);
      assert.equal(entry?.currentRunGenerated, false, name);
      assert.equal(entry?.safeToAutoStage, false, name);
      assert.deepEqual(manifest.safePaths, [], name);
      assert.deepEqual(manifest.unsafePaths, [processEventsPath], name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertIndexValidationClosesMutationWindows(): void {
  for (const seam of ['beforeAdd', 'afterAddBeforeCommit'] as const) {
    const { root, storyId } = setupFixture();
    try {
      const processEventsPath = `.proof-or-stop/story/actives/${storyId}/process-events.jsonl`;
      const baseline = captureDonePrepareGeneratedMetadataBaseline({
        root,
        storyDirRel: '.proof-or-stop/story/actives',
        storyId,
        initialDirtyRows: [],
      });
      const expected: DonePrepareGeneratedProcessEventBinding = {
        storyId,
        attemptId: NOW,
        reviewRound: NOW,
        commandSetHash: 'a'.repeat(64),
        materialHash: 'b'.repeat(64),
        storyFilesHash: 'c'.repeat(64),
        phase: 'TEST',
        disposition: 'reused',
        result: 'pass',
        commandExecutions: 0,
        notBefore: '2026-07-09T00:00:01.000Z',
        notAfter: '2026-07-09T00:00:03.000Z',
      };
      const validEvent = {
        type: 'validation_terminal',
        storyId,
        attemptId: NOW,
        phase: 'TEST',
        reviewRound: NOW,
        commandSetHash: expected.commandSetHash,
        disposition: 'reused',
        commandExecutions: 0,
        result: 'pass',
        materialHash: expected.materialHash,
        storyFilesHash: expected.storyFilesHash,
        timestamp: '2026-07-09T00:00:02.000Z',
      };
      const before = baseline.initialContents[processEventsPath]!;
      const validContent = `${before}${JSON.stringify(validEvent)}\n`;
      const forgedContent = `${before}${JSON.stringify({ ...validEvent, storyId: 'B-forged' })}\n`;
      write(root, processEventsPath, validContent);
      const transaction = captureDonePrepareGeneratedMetadataTransaction({
        root,
        gitCwd: root,
        paths: [processEventsPath],
      });
      const headBefore = git(root, ['rev-parse', 'HEAD']);
      const mutate = () => write(root, processEventsPath, forgedContent);
      const result = commitDonePrepareGeneratedMetadata({
        root,
        gitCwd: root,
        storyId,
        storyDirRel: '.proof-or-stop/story/actives',
        baseline,
        expectedProcessEventBinding: expected,
        testHooks: { [seam]: mutate },
      });
      assert.equal(result.ok, false, `${seam} mutation must refuse commit`);
      assert.match(result.reason ?? '', /changed after manifest verification/, seam);
      assert.equal(git(root, ['rev-parse', 'HEAD']), headBefore, `${seam} mutation must not create a commit`);
      assert.equal(readFileSync(join(root, processEventsPath), 'utf8'), forgedContent, `${seam} reproducer reached the mutation window`);

      const rollback = rollbackDonePrepareGeneratedMetadataTransaction({ root, gitCwd: root, transaction });
      assert.equal(rollback.ok, true, `${seam} rollback succeeds`);
      assert.equal(readFileSync(join(root, processEventsPath), 'utf8'), validContent, `${seam} rollback restores verified worktree bytes`);
      assert.equal(git(root, ['diff', '--cached', '--name-only']), '', `${seam} rollback restores the original index`);
      assert.match(git(root, ['status', '--porcelain']), /process-events\.jsonl/, `${seam} leaves the original safe unstaged delta`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

function isolatedCommitCandidate(): Fixture & {
  processEventsPath: string;
  baseline: ReturnType<typeof captureDonePrepareGeneratedMetadataBaseline>;
  expected: DonePrepareGeneratedProcessEventBinding;
  validContent: string;
} {
  const fixture = setupFixture();
  const processEventsPath = `.proof-or-stop/story/actives/${fixture.storyId}/process-events.jsonl`;
  const baseline = captureDonePrepareGeneratedMetadataBaseline({
    root: fixture.root,
    storyDirRel: '.proof-or-stop/story/actives',
    storyId: fixture.storyId,
    initialDirtyRows: [],
  });
  const expected: DonePrepareGeneratedProcessEventBinding = {
    storyId: fixture.storyId,
    attemptId: NOW,
    reviewRound: NOW,
    commandSetHash: 'a'.repeat(64),
    materialHash: 'b'.repeat(64),
    storyFilesHash: 'c'.repeat(64),
    phase: 'TEST',
    disposition: 'reused',
    result: 'pass',
    commandExecutions: 0,
    notBefore: '2026-07-09T00:00:01.000Z',
    notAfter: '2026-07-09T00:00:03.000Z',
  };
  const event = {
    type: 'validation_terminal',
    storyId: fixture.storyId,
    attemptId: NOW,
    phase: 'TEST',
    reviewRound: NOW,
    commandSetHash: expected.commandSetHash,
    disposition: 'reused',
    commandExecutions: 0,
    result: 'pass',
    materialHash: expected.materialHash,
    storyFilesHash: expected.storyFilesHash,
    timestamp: '2026-07-09T00:00:02.000Z',
  };
  const validContent = `${baseline.initialContents[processEventsPath]}${JSON.stringify(event)}\n`;
  write(fixture.root, processEventsPath, validContent);
  return { ...fixture, processEventsPath, baseline, expected, validContent };
}

function temporaryIndexGit(root: string, indexFile: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    env: { ...process.env, ...gitIdentityEnv(), GIT_INDEX_FILE: indexFile },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function installHook(root: string, name: string, body: string): void {
  const path = join(root, '.git', 'hooks', name);
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
}

function assertIsolatedTreeExcludesSharedIndexRaces(): void {
  const candidate = isolatedCommitCandidate();
  const { root, storyId, processEventsPath, baseline, expected } = candidate;
  try {
    write(root, 'README.md', '# unrelated pre-staged user change\n');
    git(root, ['add', 'README.md']);
    const readmeBlob = git(root, ['rev-parse', ':README.md']);
    const parent = git(root, ['rev-parse', 'HEAD']);
    let temporaryIndexFile = '';
    const result = withEnvSync(gitIdentityEnv(), () => commitDonePrepareGeneratedMetadata({
      root,
      gitCwd: root,
      storyId,
      storyDirRel: '.proof-or-stop/story/actives',
      baseline,
      expectedProcessEventBinding: expected,
      testHooks: {
        afterTreeVerificationBeforeCommit: (indexFile) => {
          temporaryIndexFile = indexFile;
          write(root, 'late-unrelated.txt', 'late shared-index mutation\n');
          git(root, ['add', 'late-unrelated.txt']);
        },
      },
    }));
    assert.equal(result.ok, true, result.reason);
    assert.equal(existsSync(temporaryIndexFile), false, 'successful isolated commit removes its temporary index');
    assert.equal(git(root, ['rev-parse', 'HEAD^']), parent, 'isolated commit retains the captured parent');
    assert.equal(git(root, ['log', '-1', '--pretty=%s']), AUTO_CLOSE_MESSAGE, 'default commit message is unchanged');
    assert.equal(git(root, ['log', '-1', '--pretty=%an <%ae>|%cn <%ce>']),
      'done-prepare-auto-closeout-smoke <done-prepare-auto-closeout-smoke@example.test>|done-prepare-auto-closeout-smoke <done-prepare-auto-closeout-smoke@example.test>',
      'commit-tree retains configured author and committer identities');
    assert.deepEqual(
      git(root, ['diff', '--name-only', `${parent}..HEAD`]).split('\n').filter(Boolean),
      [processEventsPath],
      'immutable closeout tree excludes late real-index staging',
    );
    assert.equal(git(root, ['rev-parse', ':README.md']), readmeBlob, 'pre-staged blob survives successful CAS byte-for-byte');
    assert.equal(git(root, ['rev-parse', ':late-unrelated.txt']).length, 40, 'late unrelated blob remains staged for the user');
    assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), '# unrelated pre-staged user change\n');
    assert.equal(readFileSync(join(root, 'late-unrelated.txt'), 'utf8'), 'late shared-index mutation\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertConcurrentHeadCasRefusesAndPreservesIndex(): void {
  const candidate = isolatedCommitCandidate();
  const { root, storyId, baseline, expected, validContent, processEventsPath } = candidate;
  try {
    const postCommitMarker = join(root, 'post-commit-ran');
    installHook(root, 'post-commit', `printf 'ran\\n' > '${postCommitMarker}'`);
    write(root, 'README.md', '# unrelated staged before CAS failure\n');
    git(root, ['add', 'README.md']);
    const readmeBlob = git(root, ['rev-parse', ':README.md']);
    const parent = git(root, ['rev-parse', 'HEAD']);
    let temporaryIndexFile = '';
    const transaction = captureDonePrepareGeneratedMetadataTransaction({
      root,
      gitCwd: root,
      paths: [processEventsPath],
    });
    const result = commitDonePrepareGeneratedMetadata({
      root,
      gitCwd: root,
      storyId,
      storyDirRel: '.proof-or-stop/story/actives',
      baseline,
      expectedProcessEventBinding: expected,
      testHooks: {
        afterTreeVerificationBeforeCommit: (indexFile) => {
          temporaryIndexFile = indexFile;
        },
        beforeCasUpdate: (oldHead, targetRef) => {
          const tree = git(root, ['rev-parse', `${oldHead}^{tree}`]);
          const concurrent = git(root, ['commit-tree', tree, '-p', oldHead, '-m', 'concurrent head advance']);
          git(root, ['update-ref', targetRef, concurrent, oldHead]);
        },
      },
    });
    assert.equal(result.ok, false);
    assert.equal(existsSync(postCommitMarker), false, 'post-commit does not run when CAS fails');
    assert.equal(existsSync(temporaryIndexFile), false, 'CAS refusal removes its temporary index');
    assert.match(result.reason ?? '', /HEAD changed.*CAS/);
    assert.equal(git(root, ['log', '-1', '--pretty=%s']), 'concurrent head advance');
    assert.deepEqual(git(root, ['diff', '--name-only', `${parent}..HEAD`]), '', 'CAS failure installs no closeout tree');
    assert.equal(git(root, ['rev-parse', ':README.md']), readmeBlob, 'pre-staged blob survives CAS failure byte-for-byte');
    const rollback = rollbackDonePrepareGeneratedMetadataTransaction({ root, gitCwd: root, transaction });
    assert.equal(rollback.ok, true);
    assert.equal(readFileSync(join(root, processEventsPath), 'utf8'), validContent);
    assert.equal(git(root, ['rev-parse', ':README.md']), readmeBlob, 'rollback does not disturb unrelated staged state');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertHeadRollbackSurvivesRefreshAndRestoreFailures(): void {
  const candidate = isolatedCommitCandidate();
  const { root, storyId, baseline, expected } = candidate;
  const originalExecFileSync = childProcess.execFileSync;
  let refreshFailed = false;
  let refreshCalls = 0;
  write(root, `.proof-or-stop/story/actives/${storyId}/test-evidence.json`, JSON.stringify({ result: "PASS" }) + "\n");
  let restoreFailed = false;
  try {
    const parent = git(root, ['rev-parse', 'HEAD']);
    childProcess.execFileSync = ((command: string, argsOrOptions?: readonly string[] | childProcess.ExecFileSyncOptions, options?: childProcess.ExecFileSyncOptions) => {
      const argv = Array.isArray(argsOrOptions) ? argsOrOptions.map(String) : [];
      if (String(command).endsWith('git') && argv[0] === 'update-index' && argv.includes('--cacheinfo') && ++refreshCalls === 2) {
        refreshFailed = true;
        throw new Error('injected real-index refresh failure');
      }
      if (refreshFailed && String(command).endsWith('git') && argv[0] === 'update-index' && argv.includes('--index-info') && argv.includes('-z')) {
        restoreFailed = true;
        throw new Error('injected real-index restore failure');
      }
      return (originalExecFileSync as any)(command, argsOrOptions as any, options);
    }) as typeof childProcess.execFileSync;
    syncBuiltinESMExports();

    const result = withEnvSync(gitIdentityEnv(), () => commitDonePrepareGeneratedMetadata({
      root,
      gitCwd: root,
      storyId,
      storyDirRel: '.proof-or-stop/story/actives',
      baseline,
      expectedProcessEventBinding: expected,
    }));

    assert.equal(result.ok, false, 'post-CAS cleanup failure remains fail-closed');
    assert.equal(result.files[0], `.proof-or-stop/story/actives/${storyId}/process-events.jsonl`, 'First safe path is the successfully staged owned entry');
    assert.equal(refreshCalls, 2);
    assert.equal(refreshFailed, true, 'production real-index refresh path was exercised');
    assert.equal(restoreFailed, true, 'production real-index restore path was exercised');
    assert.match(result.reason ?? '', /real index refresh.*injected real-index refresh failure/);
    assert.match(result.reason ?? '', /real index restore.*injected real-index restore failure/);
    assert.equal(git(root, ['rev-parse', 'HEAD']), parent, 'HEAD CAS rollback is independent of index cleanup failures');
  } finally {
    childProcess.execFileSync = originalExecFileSync;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
}

function assertIsolatedIndexPathSetIsExact(): void {
  for (const mode of ['missing', 'extra'] as const) {
    const candidate = isolatedCommitCandidate();
    const { root, storyId, processEventsPath, baseline, expected } = candidate;
    try {
      const parent = git(root, ['rev-parse', 'HEAD']);
      const result = commitDonePrepareGeneratedMetadata({
        root,
        gitCwd: root,
        storyId,
        storyDirRel: '.proof-or-stop/story/actives',
        baseline,
        expectedProcessEventBinding: expected,
        testHooks: {
          afterAddBeforeCommit: (indexFile) => {
            if (mode === 'missing') {
              temporaryIndexGit(root, indexFile, ['read-tree', parent]);
            } else {
              write(root, 'README.md', '# injected only into isolated index\n');
              temporaryIndexGit(root, indexFile, ['add', '--', 'README.md']);
            }
          },
        },
      });
      assert.equal(result.ok, false, mode);
      assert.match(result.reason ?? '', /isolated index paths do not exactly match/, mode);
      assert.equal(git(root, ['rev-parse', 'HEAD']), parent, `${mode} path-set mutation does not advance HEAD`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

function assertCommitMessageHooksAndPostCommitSemantics(): void {
  const candidate = isolatedCommitCandidate();
  const { root, storyId, baseline, expected } = candidate;
  try {
    const marker = join(root, 'post-commit-ran');
    installHook(root, 'prepare-commit-msg', [
      'test "$2" = "message"',
      'test -f "$GIT_INDEX_FILE"',
      'printf "hook-edited closeout message\\n" > "$1"',
    ].join('\n'));
    installHook(root, 'commit-msg', 'grep -q "^hook-edited closeout message$" "$1"');
    installHook(root, 'post-commit', [
      'test -f "$GIT_INDEX_FILE"',
      `printf 'ran\\n' > '${marker}'`,
    ].join('\n'));
    const parent = git(root, ['rev-parse', 'HEAD']);
    const result = commitDonePrepareGeneratedMetadata({
      root,
      gitCwd: root,
      storyId,
      storyDirRel: '.proof-or-stop/story/actives',
      baseline,
      expectedProcessEventBinding: expected,
    });
    assert.equal(result.ok, true, result.reason);
    assert.equal(git(root, ['rev-parse', 'HEAD^']), parent);
    assert.equal(git(root, ['log', '-1', '--pretty=%s']), 'hook-edited closeout message');
    assert.equal(readFileSync(marker, 'utf8'), 'ran\n', 'post-commit runs only after successful CAS');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertCommitMsgRejectionIsFailClosed(): void {
  const candidate = isolatedCommitCandidate();
  const { root, storyId, baseline, expected, validContent, processEventsPath } = candidate;
  try {
    installHook(root, 'commit-msg', 'echo rejected commit message >&2\nexit 1');
    const parent = git(root, ['rev-parse', 'HEAD']);
    let temporaryIndexFile = '';
    const result = commitDonePrepareGeneratedMetadata({
      root,
      gitCwd: root,
      storyId,
      storyDirRel: '.proof-or-stop/story/actives',
      baseline,
      expectedProcessEventBinding: expected,
      testHooks: {
        afterAddBeforeCommit: (indexFile) => {
          temporaryIndexFile = indexFile;
        },
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /commit-msg hook failed.*rejected commit message/);
    assert.equal(git(root, ['rev-parse', 'HEAD']), parent);
    assert.equal(readFileSync(join(root, processEventsPath), 'utf8'), validContent);
    assert.equal(git(root, ['diff', '--cached', '--name-only']), '', 'commit-msg rejection leaves real index unchanged');
    assert.equal(existsSync(temporaryIndexFile), false, 'commit-msg rejection cleans temporary assets');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertSigningConfigPropagatesAndFailsClosed(): void {
  const candidate = isolatedCommitCandidate();
  const { root, storyId, baseline, expected, validContent, processEventsPath } = candidate;
  try {
    git(root, ['config', 'commit.gpgSign', 'true']);
    git(root, ['config', 'gpg.format', 'ssh']);
    git(root, ['config', 'user.signingKey', join(root, 'missing-signing-key')]);
    const parent = git(root, ['rev-parse', 'HEAD']);
    let observedArgs: string[] = [];
    let observedSigning: { enabled: boolean; key?: string; format?: string } | undefined;
    const result = commitDonePrepareGeneratedMetadata({
      root,
      gitCwd: root,
      storyId,
      storyDirRel: '.proof-or-stop/story/actives',
      baseline,
      expectedProcessEventBinding: expected,
      testHooks: {
        beforeCommitTree: (args, signing) => {
          observedArgs = [...args];
          observedSigning = signing;
        },
      },
    });
    assert.equal(result.ok, false, 'required signing with a missing key must fail closed');
    assert.match(result.reason ?? '', /isolated generated metadata commit failed/);
    assert.deepEqual(observedSigning, {
      enabled: true,
      key: join(root, 'missing-signing-key'),
      format: 'ssh',
    });
    assert.ok(observedArgs.includes(`-S${join(root, 'missing-signing-key')}`), 'commit-tree receives configured signing key');
    assert.equal(git(root, ['rev-parse', 'HEAD']), parent);
    assert.equal(readFileSync(join(root, processEventsPath), 'utf8'), validContent);
    assert.equal(git(root, ['diff', '--cached', '--name-only']), '', 'signing failure leaves real index unchanged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertDeletesAndRenamesAreUnsafe(): void {
  for (const mode of ['delete', 'rename'] as const) {
    const { root, storyId } = setupFixture();
    try {
      const testEvidencePath = `.proof-or-stop/story/actives/${storyId}/test-evidence.json`;
      const baseline = captureDonePrepareGeneratedMetadataBaseline({
        root,
        storyDirRel: '.proof-or-stop/story/actives',
        storyId,
        initialDirtyRows: [],
      });
      if (mode === 'delete') {
        git(root, ['rm', testEvidencePath]);
      } else {
        git(root, ['mv', testEvidencePath, `${testEvidencePath}.renamed`]);
      }
      const manifest = buildDonePrepareGeneratedMetadataManifest({
        root,
        storyId,
        storyDirRel: '.proof-or-stop/story/actives',
        baseline,
        statusRows: gitStatusRowsForDonePrepareGeneratedMetadata(root),
      });
      assert.equal(manifest.safePaths.length, 0, `${mode} must not produce safe auto-stage paths`);
      assert.ok(manifest.unsafePaths.length > 0, `${mode} must produce unsafe paths`);
      assert.ok(
        manifest.entries.some((entry) => entry.safety === (mode === 'delete' ? 'unsafe_deleted' : 'unsafe_rename')),
        `${mode} must be classified as unsafe`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

function assertMissingHashesRefuseReuse(): void {
  const { root, storyId } = setupFixture();
  try {
    const store = new StoryStore(root);
    const basis = captureDonePrepareValidationReuseBasis({ root, gitCwd: root, storyId, store });
    const testEvidence = store.readTestEvidence(storyId);
    assert.ok(testEvidence, 'fixture has test evidence');
    store.writeTestEvidence(storyId, {
      ...testEvidence,
      materialHash: undefined,
      storyFilesHash: undefined,
    });
    const result = writeDonePrepareValidationReuseRecord({
      root,
      gitCwd: root,
      storyId,
      store,
      basis,
      generatedMetadataPaths: [`.proof-or-stop/story/actives/${storyId}/test-evidence.json`],
    });
    assert.equal(result.ok, false, 'missing material/story hashes must not be eligible for validation reuse');
    assert.match(result.reasons.join('\n'), /test-evidence materialHash does not match current materialHash/);
    assert.equal((store.readDoneRequiredEvidence(storyId) as any)?.donePrepareValidationReuse, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertReuseRefusesConfigAndMaterialDrift(): Promise<void> {
  const { root, storyId } = setupFixture();
  const oldCwd = process.cwd();
  try {
    process.chdir(root);
    const prepare = await withEnv(gitIdentityEnv(), async () => String(await createDonePrepareHandlers(mkCtx(root)).done_prepare({
      storyId,
      mergeMain: false,
      refreshStale: false,
      validate: true,
      autoCloseGeneratedMetadata: true,
      reuseFreshValidation: true,
    })));
    assert.match(prepare, /^DONE prepare: PASS/, prepare);

    const store = new StoryStore(root);
    const basis = captureDonePrepareValidationReuseBasis({ root, gitCwd: root, storyId, store });
    assert.ok(basis.doneRequiredEvidence, 'drift refusal fixture must have DONE-required evidence before drift');
    const reuseRecordBeforeDrift = JSON.stringify((store.readDoneRequiredEvidence(storyId) as any)?.donePrepareValidationReuse ?? null);
    write(root, 'README.md', '# done_prepare auto-closeout fixture changed\n');
    write(root, 'proof-or-stop.config.json', JSON.stringify({
      scanRoot: '.',
      rootDir: '.',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'light' },
      validate: {
        commands: [{
          label: 'changed validate',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          timeoutMs: 2000,
        }],
      },
      doneRequiredCommands: [{
        label: 'changed DONE-required validation',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 2000,
      }],
    }, null, 2) + '\n');
    git(root, ['add', 'README.md', 'proof-or-stop.config.json']);
    git(root, ['commit', '-m', 'drift material and validation config']);
    resetConfigCache();

    const result = writeDonePrepareValidationReuseRecord({
      root,
      gitCwd: root,
      storyId,
      store,
      basis,
      generatedMetadataPaths: [`.proof-or-stop/story/actives/${storyId}/test-evidence.json`],
    });
    assert.equal(result.ok, false, 'material/config drift must not be eligible for validation reuse');
    const reasons = result.reasons.join('\n');
    assert.match(reasons, /materialHash changed/);
    assert.match(reasons, /validateCommandSetHash changed/);
    assert.match(reasons, /doneRequiredCommandSetHash changed/);
    assert.match(reasons, /configHash changed/);
    assert.equal(
      JSON.stringify((store.readDoneRequiredEvidence(storyId) as any)?.donePrepareValidationReuse ?? null),
      reuseRecordBeforeDrift,
      'failed drift reuse must not rewrite the prior reuse record',
    );
  } finally {
    process.chdir(oldCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

function assertJsonStdoutClean(): void {
  const { root, storyId } = setupFixture();
  try {
    const result = runCli(root, donePrepareAutoCloseArgs(storyId, true));
    assert.equal(result.status, 0, `json auto-closeout should exit 0:\n${result.stderr}\n${result.stdout}`);
    assert.ok(!result.stdout.includes('done_prepare progress:'), `JSON stdout must not contain progress text:\n${result.stdout}`);
    assert.ok(!result.stdout.includes('done_prepare auto-closeout:'), `JSON stdout must not contain side-channel auto-closeout text:\n${result.stdout}`);
    assert.match(result.stderr, /done_prepare progress:/, 'progress remains on the side channel');
    const parsed = JSON.parse(result.stdout) as {
      schemaVersion?: string;
      storyId?: string;
      status?: string;
      transcript?: string;
    };
    assert.equal(parsed.schemaVersion, DONE_PREPARE_SCHEMA);
    assert.equal(parsed.storyId, storyId);
    assert.equal(parsed.status, 'pass', `JSON done_prepare should pass:\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
    assert.match(parsed.transcript ?? '', /^DONE prepare: PASS/);
    // B-f824: single auto-closeout run, no duplicate executions in any phase.
    assert.match(parsed.transcript ?? '', /^convergence: metadataRollbacks=0 reviewerReattestations=0 postTestReviewerReattestations=0 humanConfirmations=0 unchangedSuiteExecutions=0 reviewWindowSuiteExecutions=0 successfulCloseout=1$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDryRunScopeReportsBlocked(): Promise<void> {
  const {root,storyId}=setupFixture();
  try {
    const store=new StoryStore(root);
    const ready=runCli(root,donePrepareAutoCloseArgs(storyId,true));
    assert.equal(JSON.parse(ready.stdout).status,'pass',ready.stdout+ready.stderr);
    writeFileSync(store.storyFilePath(storyId,'scope-contract.json'),'{corrupt\n');
    commitAll(root,'arrange invalid scope for dry-run diagnosis');
    const result=runCli(root,['done_prepare','--storyId',storyId,'--mergeMain=false','--refreshStale=false','--validate=false','--dryRun','--json']);
    const parsed=JSON.parse(result.stdout);
    console.log('DRY_RUN_SCOPE_V7 '+result.stdout);
    assert.notEqual(parsed.status,'pass','DRY_RUN_SCOPE_MUST_NOT_REPORT_PASS');
    assert.equal(parsed.blockedAt,'lifecycleReadiness','DRY_RUN_MUST_PRESERVE_UPSTREAM_DIAGNOSIS');
  } finally {rmSync(root,{recursive:true,force:true});}
}

async function assertUpstreamReviewRefusesBeforeExecution(): Promise<void> {
  const outside = mkdtempSync(join(tmpdir(), 'closeout-upstream-count-'));
  const counter = join(outside, 'starts');
  const { root, storyId } = setupFixture({ counterPath: counter });
  try {
    const store = new StoryStore(root);
    writeFileSync(store.storyFilePath(storyId, 'review-loops.jsonl'), '{corrupt\n');
    commitAll(root, 'arrange unreadable review prerequisite');
    // Synthetic admission isolates review-readiness from certification freshness;
    // this is not proof of real inventory completion or reviewer authorization.
    const causalInputHashes = deriveCertificationDomainInputHashes(root, 'HEAD', root);
    assert.ok(causalInputHashes);
    persistSyntheticAdmittedWindowForTest({ store, storyId, projectRoot: root, causalInputHashes });
    commitAll(root, 'bind synthetic fixture admission to current inputs');
    const result = runCli(root, donePrepareAutoCloseArgs(storyId, true));
    const starts = existsSync(counter) ? readFileSync(counter, 'utf8').split('start').length - 1 : 0;
    console.log('CLOSEOUT_UPSTREAM ' + JSON.stringify({ starts, ...result }));
    assert.equal(starts, 0, 'UPSTREAM_REVIEW_MUST_REFUSE_BEFORE_COMMANDS');
    assert.match(result.stdout + result.stderr, /review_loop_record_error|review loop records unreadable/);
    assert.notEqual(JSON.parse(result.stdout).status, 'pass');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
}

void (async () => {
  try {
    if (process.argv.includes('--dry-run-scope-only')) { await assertDryRunScopeReportsBlocked(); return; }
    if (process.argv.includes('--upstream-only')) { await assertUpstreamReviewRefusesBeforeExecution(); return; }
    await assertUpstreamReviewRefusesBeforeExecution();
    await assertDryRunScopeReportsBlocked();
    execFileSync(process.execPath, [join(repoRoot, 'scripts/verify-closeout-certification-order.mjs')], { cwd: repoRoot, stdio: 'inherit', timeout: 30000 });
    execFileSync(process.execPath, [join(repoRoot, 'scripts/verify-closeout-late-drift-v3.mjs')], { cwd: repoRoot, stdio: 'inherit', timeout: 30000 });
    for (const scenario of ['preexisting', 'status-error', 'clean', 'concurrent', 'source-drift', 'event-tamper', 'evidence-tamper', 'terminal-read-failure', 'owner-fence']) {
      execFileSync(process.execPath, [join(repoRoot, 'scripts/probe-validation-publication-integrity.mjs'), `--scenario=${scenario}`], { cwd: repoRoot, stdio: 'pipe', timeout: 30000 });
    }
    for (const probe of ['probe-index-refresh-foreign.mjs', 'probe-index-refresh-unreadable.mjs', 'probe-index-refresh-owned.mjs', 'probe-closeout-rollback-root.mjs', 'probe-index-intended-read.mjs', 'probe-index-refresh-sha256.mjs']) {
      execFileSync(process.execPath, [join(repoRoot, 'scripts', probe)], { cwd: repoRoot, stdio: 'inherit', timeout: 30000 });
    }
    await assertForeignIndexSurvivesOuterCloseout();
    await assertForeignIndexSurvivesOuterCloseout('owned');
    await assertManifestOnlyAutoCloseout();
    await assertPreexistingProcessEventsRemainFailClosed();
    await assertUnsafePathRefusesBeforeReuseRecord();
    await assertCommitHookFailureRemainsFailClosed();
    assertPreexistingLifecycleMetadataIsUnsafe();
    assertProcessEventBindingIsExactAndFailClosed();
    assertIndexValidationClosesMutationWindows();
    assertIsolatedTreeExcludesSharedIndexRaces();
    assertConcurrentHeadCasRefusesAndPreservesIndex();
    assertHeadRollbackSurvivesRefreshAndRestoreFailures();
    assertIsolatedIndexPathSetIsExact();
    assertCommitMessageHooksAndPostCommitSemantics();
    assertCommitMsgRejectionIsFailClosed();
    assertSigningConfigPropagatesAndFailsClosed();
    assertDeletesAndRenamesAreUnsafe();
    assertMissingHashesRefuseReuse();
    await assertReuseRefusesConfigAndMaterialDrift();
    assertJsonStdoutClean();
    console.log('done-prepare-auto-closeout smoke passed');
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  }
})();
