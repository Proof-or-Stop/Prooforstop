#!/usr/bin/env node

/**
 * Smoke: opt-in done_prepare generated-metadata auto-closeout is manifest-only,
 * JSON-clean, and fail-closed.
 *
 * Run:
 *   node packages/main/dist/tasks/done-prepare-auto-closeout-smoke.js
 */

import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

import { resetConfigCache } from '../core/config.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash, EMPTY_STORY_FILES_HASH } from '../core/evidence-freshness.js';
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
import { StoryStore } from '../core/store.js';
import {
  buildDonePrepareGeneratedMetadataManifest,
  captureDonePrepareGeneratedMetadataBaseline,
  gitStatusRowsForDonePrepareGeneratedMetadata,
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
const NOW = '2026-07-09T00:00:00.000Z';
const STORY_ID = 'B-done-prepare-auto-closeout';
const AUTO_CLOSE_MESSAGE = `lattice: auto-close ${STORY_ID} generated DONE metadata`;

interface Fixture {
  root: string;
  storyId: string;
}

interface FixtureOptions {
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
    env: { ...process.env, ...gitIdentityEnv(), ...env },
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
    agentId: 'lattice-review-delivery',
    docsPromises,
    realMachineTests,
    closingSelfCheck,
    _hash: signDeliveryCheck(storyId, docsPromises, realMachineTests, closingSelfCheck, NOW, materialHash, storyFilesHash),
  };
  store.writeDeliveryCheck(storyId, deliveryCheck);
}

function setupFixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-prepare-auto-closeout-'));
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
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'light' },
    validate: {
      commands: [{
        label: 'smoke validate',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 2000,
      }],
    },
    doneRequiredCommands: [{
      label: options.unsafeDoneRequiredSideEffect ? 'unsafe side-effect DONE-required validation' : 'smoke DONE-required validation',
      command: process.execPath,
      args: ['-e', options.unsafeDoneRequiredSideEffect ? unsafeScript : 'process.exit(0)'],
      timeoutMs: 2000,
    }],
    staleThresholds: {
      phaseStale: 10_000_000,
      itemStale: 10_000_000,
      idleLattice: 10_000_000,
      bugStale: 10_000_000,
    },
  };
  write(root, 'lattice.config.json', JSON.stringify(config, null, 2) + '\n');
  write(root, '.gitignore', [
    '.lattice/activity.jsonl',
    '.lattice/learning/runtime-memory-pack-cache/',
    '.lattice/locks/',
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
  seedDoneGateEvidence(root, STORY_ID);
  commitAll(root, 'seed done_prepare auto-closeout story metadata');
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

async function assertManifestOnlyAutoCloseout(): Promise<void> {
  const { root, storyId } = setupFixture();
  const oldCwd = process.cwd();
  const observed: string[] = [];
  const restoreSpy = installCommandSpy(observed);
  try {
    process.chdir(root);
    const deliveryBefore = readFileSync(join(root, '.lattice', 'story', 'actives', storyId, 'delivery-check.json'), 'utf8');
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
    assert.match(transcript, /^autoCloseGeneratedMetadata: PASS$/m);
    assert.match(transcript, /^validationReused: true$/m);
    assert.match(transcript, /^validationReuseRecord: done-required-evidence\.json$/m);
    assert.match(transcript, /lattice story_advance '\{"storyId":"B-done-prepare-auto-closeout","phase":"DONE"\}'/);
    assert.ok(logs.some((line) => line.includes('done_prepare auto-closeout: committed generated metadata')), 'auto-closeout commit is logged to side channel');
    assert.equal(git(root, ['status', '--porcelain']), '', 'auto-closeout leaves the worktree clean');
    assert.equal(git(root, ['log', '-1', '--pretty=%s']), AUTO_CLOSE_MESSAGE);
    const committedFiles = git(root, ['show', '--pretty=', '--name-only', 'HEAD'])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();
    assert.deepEqual(committedFiles, [
      `.lattice/story/actives/${storyId}/done-required-evidence.json`,
      `.lattice/story/actives/${storyId}/test-evidence.json`,
    ]);
    const evidence = new StoryStore(root).readDoneRequiredEvidence(storyId) as any;
    assert.equal(evidence.donePrepareValidationReuse?.status, 'reused');
    assert.equal(evidence.donePrepareValidationReuse?.commandsRerunAfterAutoCloseout, false);
    assert.match(evidence.donePrepareValidationReuse?.statement ?? '', /not rerun/);
    assert.equal(evidence.donePrepareValidationReuse?.priorEvidenceRefs?.testEvidence?.command, `lattice validate --story=${storyId} --json`);
    assert.equal(evidence.donePrepareValidationReuse?.priorEvidenceRefs?.doneRequiredEvidence?.receipts?.[0]?.label, 'smoke DONE-required validation');
    assert.match(evidence.donePrepareValidationReuse?.priorEvidenceRefs?.doneRequiredEvidence?.receipts?.[0]?.outputDigest ?? '', /^[a-f0-9]{64}$/);
    assert.equal(
      readFileSync(join(root, '.lattice', 'story', 'actives', storyId, 'delivery-check.json'), 'utf8'),
      deliveryBefore,
      'done_prepare must not self-sign or rewrite delivery-check evidence',
    );
    assert.ok(observed.some((line) => line.includes('git add --')), `spy must observe explicit git add pathspecs:\n${observed.join('\n')}`);
    assert.ok(observed.some((line) => line.includes('git commit -m')), `spy must observe git commit:\n${observed.join('\n')}`);
  } finally {
    restoreSpy();
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

async function assertCommitHookFailureRollsBackReuseAndIndex(): Promise<void> {
  const { root, storyId } = setupFixture();
  const oldCwd = process.cwd();
  const observed: string[] = [];
  const restoreSpy = installCommandSpy(observed);
  try {
    process.chdir(root);
    const hookPath = join(root, '.git', 'hooks', 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho failing pre-commit >&2\nexit 1\n', 'utf8');
    chmodSync(hookPath, 0o755);

    const headBefore = git(root, ['rev-parse', 'HEAD']);
    const safePaths = [
      `.lattice/story/actives/${storyId}/done-required-evidence.json`,
      `.lattice/story/actives/${storyId}/test-evidence.json`,
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
    assert.match(transcript, /^blockedAt: cleanTree$/m);
    assert.match(transcript, /git commit failed/);
    assert.match(transcript, /failing pre-commit/);
    assert.equal(git(root, ['rev-parse', 'HEAD']), headBefore, 'failed auto-closeout must not advance HEAD');
    assert.equal(git(root, ['diff', '--cached', '--name-only', '--', ...safePaths]), '', 'rollback must leave generated metadata unstaged');
    const unstagedSafePaths = git(root, ['diff', '--name-only', '--', ...safePaths])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const untrackedSafePaths = git(root, ['ls-files', '--others', '--exclude-standard', '--', ...safePaths])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    assert.deepEqual(
      [...unstagedSafePaths, ...untrackedSafePaths].sort(),
      safePaths.sort(),
      'rollback must leave original generated metadata dirty only in the worktree',
    );
    const evidence = new StoryStore(root).readDoneRequiredEvidence(storyId) as any;
    assert.equal(evidence.donePrepareValidationReuse, undefined, 'failed commit rollback must remove the validation reuse claim');
    assert.ok(observed.some((line) => line.includes('git update-index --force-remove --')), `rollback must restore index entries explicitly:\n${observed.join('\n')}`);
    assert.ok(observed.some((line) => line.includes('git update-index --index-info')), `rollback must restore captured index state:\n${observed.join('\n')}`);
  } finally {
    restoreSpy();
    process.chdir(oldCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

function assertPreexistingLifecycleMetadataIsUnsafe(): void {
  const { root, storyId } = setupFixture();
  try {
    const testEvidencePath = `.lattice/story/actives/${storyId}/test-evidence.json`;
    write(root, testEvidencePath, JSON.stringify({ preexisting: true }, null, 2) + '\n');
    const rows = gitStatusRowsForDonePrepareGeneratedMetadata(root);
    assert.match(rows.join('\n'), /test-evidence\.json/, 'fixture must have pre-existing lifecycle metadata dirt');
    const baseline = captureDonePrepareGeneratedMetadataBaseline({
      root,
      storyDirRel: '.lattice/story/actives',
      storyId,
      initialDirtyRows: rows,
    });
    const manifest = buildDonePrepareGeneratedMetadataManifest({
      root,
      storyId,
      storyDirRel: '.lattice/story/actives',
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

function assertDeletesAndRenamesAreUnsafe(): void {
  for (const mode of ['delete', 'rename'] as const) {
    const { root, storyId } = setupFixture();
    try {
      const testEvidencePath = `.lattice/story/actives/${storyId}/test-evidence.json`;
      const baseline = captureDonePrepareGeneratedMetadataBaseline({
        root,
        storyDirRel: '.lattice/story/actives',
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
        storyDirRel: '.lattice/story/actives',
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
      generatedMetadataPaths: [`.lattice/story/actives/${storyId}/test-evidence.json`],
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
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: '.',
      rootDir: '.',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      storyDir: '.lattice/story/actives',
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
    git(root, ['add', 'README.md', 'lattice.config.json']);
    git(root, ['commit', '-m', 'drift material and validation config']);
    resetConfigCache();

    const result = writeDonePrepareValidationReuseRecord({
      root,
      gitCwd: root,
      storyId,
      store,
      basis,
      generatedMetadataPaths: [`.lattice/story/actives/${storyId}/test-evidence.json`],
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
    assert.equal(parsed.schemaVersion, 'lattice.done_prepare.v1');
    assert.equal(parsed.storyId, storyId);
    assert.equal(parsed.status, 'pass', `JSON done_prepare should pass:\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
    assert.match(parsed.transcript ?? '', /^DONE prepare: PASS/);
    assert.match(parsed.transcript ?? '', /^autoCloseGeneratedMetadata: PASS$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void (async () => {
  try {
    await assertManifestOnlyAutoCloseout();
    await assertUnsafePathRefusesBeforeReuseRecord();
    await assertCommitHookFailureRollsBackReuseAndIndex();
    assertPreexistingLifecycleMetadataIsUnsafe();
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
