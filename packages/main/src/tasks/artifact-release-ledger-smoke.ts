#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ARTIFACT_RELEASE_LEDGER_REL_PATH,
  artifactReleaseLedgerPath,
  computeArtifactSetDigest,
  createArtifactReleaseRecordForTest,
  isArtifactReleasePathV1,
  readArtifactReleaseLedger,
  recordArtifactReleaseForDoneMerge,
  resolveArtifactReleaseLedgerRoot,
  selectArtifactReleasePathsV1,
} from '../core/artifact-release.js';
import { StoryStore } from '../core/store.js';
import { createArtifactReleaseHandlers } from '../handlers/artifact-release.js';
import { createDoneRecoverHandlers } from '../handlers/done-recover.js';
import {
  commitArtifactReleaseLedgerIfNeeded,
  isDoneMainRuntimeBuildInput,
  shouldBuildDoneMainPackageForChangedPaths,
} from '../handlers/done-effects.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, path: string, content: string): void {
  const abs = join(root, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

function writeLatticeConfig(root: string, config: Record<string, unknown> = {}): void {
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

function makeGitFixture(): string {
  const root = mkdtemp('artifact-release-ledger-git-');
  writeLatticeConfig(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Artifact Release Smoke']);
  write(root, 'docs/release.md', '# Release\n');
  write(root, 'experiments/proof/run.mjs', 'export const ok = true;\n');
  write(root, 'packages/main/src/runtime.ts', 'export const runtime = true;\n');
  write(root, '.lattice/story/actives/B-demo/index.json', '{"phase":"DONE"}\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);
  return root;
}

function makeWrapperGitFixture(): { metadataRoot: string; gitCwd: string; head: string } {
  const metadataRoot = mkdtemp('artifact-release-ledger-wrapper-');
  writeLatticeConfig(metadataRoot, { gitRoot: 'repo' });
  const gitCwd = join(metadataRoot, 'repo');
  mkdirSync(gitCwd, { recursive: true });
  git(gitCwd, ['init', '-b', 'main']);
  git(gitCwd, ['config', 'user.email', 'smoke@example.test']);
  git(gitCwd, ['config', 'user.name', 'Artifact Release Wrapper Smoke']);
  write(gitCwd, 'docs/release.md', '# Git release bytes\n');
  git(gitCwd, ['add', '.']);
  git(gitCwd, ['commit', '-m', 'fixture']);
  write(metadataRoot, 'docs/release.md', '# Metadata fallback bytes\n');
  return { metadataRoot, gitCwd, head: git(gitCwd, ['rev-parse', 'HEAD']) };
}

function makePartialDoneRecoveryFixture(): { root: string; storyId: string } {
  const root = mkdtemp('artifact-release-ledger-recover-');
  const storyId = 'B-recover';
  const now = '2026-07-05T00:06:00.000Z';
  writeLatticeConfig(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Artifact Release Recovery Smoke']);
  write(root, 'README.md', '# fixture\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial']);

  git(root, ['checkout', '-b', `story/${storyId}`]);
  write(root, 'docs/recovered.md', '# Recovered doc\n');
  write(root, 'experiments/recovery/result.txt', 'observed\n');
  write(root, `.lattice/story/actives/${storyId}/index.json`, JSON.stringify({
    storyId,
    name: 'recover-artifact-release',
    title: 'Recover artifact release',
    description: 'partial DONE recovery fixture',
    type: 'feature',
    phase: 'DONE',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: now,
    events: [{ phase: 'DONE', action: 'advance', timestamp: now }],
  }, null, 2) + '\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'story done']);
  git(root, ['checkout', 'main']);
  return { root, storyId };
}

function mkdtemp(prefix: string): string {
  return execFileSync('mktemp', ['-d', join(tmpdir(), `${prefix}XXXXXX`)], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const cleanup: string[] = [];

try {
  const root = makeGitFixture();
  cleanup.push(root);
  const head = git(root, ['rev-parse', 'HEAD']);
  const changedPaths = [
    'docs/release.md',
    'experiments/proof/run.mjs',
    '.lattice/story/actives/B-demo/index.json',
    'packages/main/src/runtime.ts',
    'package.json',
    'docs/story/legacy.json',
  ];

  check('V1 path classifier includes docs and experiments only after runtime/lifecycle exclusions', () => {
    assert.equal(isArtifactReleasePathV1('docs/release.md', { isRuntimeBuildInput: isDoneMainRuntimeBuildInput }), true);
    assert.equal(isArtifactReleasePathV1('experiments/proof/run.mjs', { isRuntimeBuildInput: isDoneMainRuntimeBuildInput }), true);
    assert.equal(isArtifactReleasePathV1('.lattice/story/actives/B-demo/index.json', { isRuntimeBuildInput: isDoneMainRuntimeBuildInput }), false);
    assert.equal(isArtifactReleasePathV1('packages/main/src/runtime.ts', { isRuntimeBuildInput: isDoneMainRuntimeBuildInput }), false);
    assert.equal(isArtifactReleasePathV1('package.json', { isRuntimeBuildInput: isDoneMainRuntimeBuildInput }), false);
    assert.deepEqual(
      selectArtifactReleasePathsV1(changedPaths, { isRuntimeBuildInput: isDoneMainRuntimeBuildInput }),
      ['docs/release.md', 'experiments/proof/run.mjs'],
    );
  });

  check('digest is deterministic, sha256-prefixed, and bound to git blobs at the supplied commit', () => {
    const digest1 = computeArtifactSetDigest(root, ['experiments/proof/run.mjs', 'docs/release.md'], head);
    const digest2 = computeArtifactSetDigest(root, ['docs/release.md', 'experiments/proof/run.mjs'], head);
    assert.match(digest1, /^sha256:[a-f0-9]{64}$/);
    assert.equal(digest1, digest2);
    write(root, 'docs/release.md', '# Changed after commit\n');
    assert.equal(computeArtifactSetDigest(root, ['docs/release.md', 'experiments/proof/run.mjs'], head), digest1);
  });

  check('wrapper-root read commands use the same resolved ledger root that DONE writes', () => {
    const { metadataRoot, gitCwd, head: wrapperHead } = makeWrapperGitFixture();
    cleanup.push(metadataRoot);
    const ledgerRoot = resolveArtifactReleaseLedgerRoot(metadataRoot);
    assert.equal(realpathSync(ledgerRoot), realpathSync(gitCwd));
    const paths = ['docs/release.md'];
    const metadataFsDigest = computeArtifactSetDigest(metadataRoot, paths);
    const gitDigest = computeArtifactSetDigest(ledgerRoot, paths, wrapperHead, gitCwd);
    assert.match(gitDigest, /^sha256:[a-f0-9]{64}$/);
    assert.notEqual(gitDigest, metadataFsDigest);

    write(metadataRoot, 'docs/release.md', '# Metadata fallback changed after commit\n');
    assert.equal(computeArtifactSetDigest(ledgerRoot, paths, wrapperHead, gitCwd), gitDigest);
    assert.equal(
      computeArtifactSetDigest(ledgerRoot, paths, undefined, gitCwd),
      computeArtifactSetDigest(ledgerRoot, paths),
    );
    assert.notEqual(computeArtifactSetDigest(metadataRoot, paths), metadataFsDigest);

    const result = recordArtifactReleaseForDoneMerge({
      root: ledgerRoot,
      gitCwd,
      storyId: 'B-wrapper',
      mainCommit: wrapperHead,
      changedPaths: paths,
      runtimeSemverChanged: false,
      isRuntimeBuildInput: isDoneMainRuntimeBuildInput,
      now: '2026-07-05T00:02:30.000Z',
    });
    assert.equal(result.status, 'recorded');
    assert.equal(result.record?.artifactSetDigest, gitDigest);
    assert.equal(existsSync(artifactReleaseLedgerPath(ledgerRoot)), true);
    assert.equal(existsSync(artifactReleaseLedgerPath(metadataRoot)), false);

    const handlers = createArtifactReleaseHandlers({
      root: metadataRoot,
      store: new StoryStore(metadataRoot),
      scanRoot: join(metadataRoot, 'packages/main'),
    });
    const listJson = handlers.artifact_release_list({ format: 'json', limit: 5 }) as unknown[];
    assert.equal(listJson.length, 1);
    const statusJson = handlers.artifact_release_status({ storyId: 'B-wrapper', format: 'json' }) as { count: number };
    assert.equal(statusJson.count, 1);
  });

  check('partial-DONE recovery writes and commits artifact release ledger for docs and experiments', () => {
    const { root: recoveryRoot, storyId } = makePartialDoneRecoveryFixture();
    cleanup.push(recoveryRoot);
    const store = new StoryStore(recoveryRoot);
    const handlers = createDoneRecoverHandlers({
      root: recoveryRoot,
      store,
      scanRoot: join(recoveryRoot, 'packages/main'),
      doneMainBuildRunner: () => {
        throw new Error('docs/experiments-only recovery must not run the runtime package build');
      },
    });

    const output = handlers.done_recover({ storyId });
    assert.match(output, /partial-DONE recovered: B-recover/);
    assert.match(output, /packages\/main build skipped after DONE merge/);
    assert.match(output, /artifact release recorded: story=B-recover/);

    const ledgerRoot = resolveArtifactReleaseLedgerRoot(recoveryRoot);
    const records = readArtifactReleaseLedger(ledgerRoot);
    assert.equal(records.length, 1);
    assert.equal(records[0].storyId, storyId);
    assert.deepEqual(records[0].paths, ['docs/recovered.md', 'experiments/recovery/result.txt']);
    assert.equal(records[0].runtimeSemverChanged, false);
    assert.ok(git(recoveryRoot, ['show', `HEAD:${ARTIFACT_RELEASE_LEDGER_REL_PATH}`]).includes('"storyId":"B-recover"'));
    assert.equal(git(recoveryRoot, ['status', '--short']), '');
    assert.equal(git(recoveryRoot, ['branch', '--list', `story/${storyId}`]), '');
  });

  check('filesystem fallback works when no commit is supplied', () => {
    const fsRoot = mkdtemp('artifact-release-ledger-fs-');
    cleanup.push(fsRoot);
    write(fsRoot, 'docs/fs.md', 'one\n');
    const digest1 = computeArtifactSetDigest(fsRoot, ['docs/fs.md']);
    write(fsRoot, 'docs/fs.md', 'two\n');
    const digest2 = computeArtifactSetDigest(fsRoot, ['docs/fs.md']);
    assert.match(digest1, /^sha256:[a-f0-9]{64}$/);
    assert.notEqual(digest1, digest2);
  });

  check('record append is idempotent for storyId + mainCommit + artifactSetDigest', () => {
    const runtimeSemverChanged = shouldBuildDoneMainPackageForChangedPaths(changedPaths);
    assert.equal(runtimeSemverChanged, true);
    const first = recordArtifactReleaseForDoneMerge({
      root,
      storyId: 'B-demo',
      mainCommit: head,
      changedPaths,
      runtimeSemverChanged,
      isRuntimeBuildInput: isDoneMainRuntimeBuildInput,
      now: '2026-07-05T00:00:00.000Z',
    });
    const second = recordArtifactReleaseForDoneMerge({
      root,
      storyId: 'B-demo',
      mainCommit: head,
      changedPaths,
      runtimeSemverChanged,
      isRuntimeBuildInput: isDoneMainRuntimeBuildInput,
      now: '2026-07-05T00:01:00.000Z',
    });
    assert.equal(first.status, 'recorded');
    assert.equal(second.status, 'already_recorded');
    const records = readArtifactReleaseLedger(root);
    assert.equal(records.length, 1);
    assert.equal(records[0].storyId, 'B-demo');
    assert.equal(records[0].mainCommit, head);
    assert.equal(records[0].changedPathCount, 2);
    assert.deepEqual(records[0].paths, ['docs/release.md', 'experiments/proof/run.mjs']);
    assert.equal(records[0].runtimeSemverChanged, true);
    assert.ok(records[0].claimBoundary.includes('provenance-only'));
    assert.ok(readFileSync(artifactReleaseLedgerPath(root), 'utf-8').includes('"schemaVersion"'));
  });

  check('already-recorded dirty ledger retry commits the existing row durably', () => {
    const retryRoot = makeGitFixture();
    cleanup.push(retryRoot);
    const retryHead = git(retryRoot, ['rev-parse', 'HEAD']);
    const retryChangedPaths = ['docs/release.md', 'experiments/proof/run.mjs'];
    const first = recordArtifactReleaseForDoneMerge({
      root: retryRoot,
      storyId: 'B-retry',
      mainCommit: retryHead,
      changedPaths: retryChangedPaths,
      runtimeSemverChanged: false,
      isRuntimeBuildInput: isDoneMainRuntimeBuildInput,
      now: '2026-07-05T00:03:00.000Z',
    });
    assert.equal(first.status, 'recorded');
    assert.notEqual(git(retryRoot, ['status', '--short', '--', ARTIFACT_RELEASE_LEDGER_REL_PATH]), '');

    const second = recordArtifactReleaseForDoneMerge({
      root: retryRoot,
      storyId: 'B-retry',
      mainCommit: retryHead,
      changedPaths: retryChangedPaths,
      runtimeSemverChanged: false,
      isRuntimeBuildInput: isDoneMainRuntimeBuildInput,
      now: '2026-07-05T00:04:00.000Z',
    });
    assert.equal(second.status, 'already_recorded');

    commitArtifactReleaseLedgerIfNeeded(retryRoot, 'B-retry', second, (args, cwd) => git(cwd, args));
    assert.equal(git(retryRoot, ['status', '--short', '--', ARTIFACT_RELEASE_LEDGER_REL_PATH]), '');
    assert.ok(git(retryRoot, ['show', `HEAD:${ARTIFACT_RELEASE_LEDGER_REL_PATH}`]).includes('"storyId":"B-retry"'));
    const committedHead = git(retryRoot, ['rev-parse', 'HEAD']);

    const third = recordArtifactReleaseForDoneMerge({
      root: retryRoot,
      storyId: 'B-retry',
      mainCommit: retryHead,
      changedPaths: retryChangedPaths,
      runtimeSemverChanged: false,
      isRuntimeBuildInput: isDoneMainRuntimeBuildInput,
      now: '2026-07-05T00:05:00.000Z',
    });
    assert.equal(third.status, 'already_recorded');
    commitArtifactReleaseLedgerIfNeeded(retryRoot, 'B-retry', third, (args, cwd) => git(cwd, args));
    assert.equal(git(retryRoot, ['rev-parse', 'HEAD']), committedHead);
  });

  check('empty releasable set skips without creating a ledger file', () => {
    const emptyRoot = mkdtemp('artifact-release-ledger-empty-');
    cleanup.push(emptyRoot);
    const result = recordArtifactReleaseForDoneMerge({
      root: emptyRoot,
      storyId: 'B-empty',
      mainCommit: 'abc123',
      changedPaths: ['.lattice/story/actives/B-empty/index.json', 'packages/main/src/x.ts'],
      runtimeSemverChanged: true,
      isRuntimeBuildInput: isDoneMainRuntimeBuildInput,
    });
    assert.equal(result.status, 'skipped_empty');
    assert.equal(existsSync(join(emptyRoot, ARTIFACT_RELEASE_LEDGER_REL_PATH)), false);
  });

  check('read-only handlers list and filter records without mutating', () => {
    const handlers = createArtifactReleaseHandlers({
      root,
      store: new StoryStore(root),
      scanRoot: join(root, 'packages/main'),
    });
    const listJson = handlers.artifact_release_list({ format: 'json', limit: 5 }) as unknown[];
    assert.equal(Array.isArray(listJson), true);
    assert.equal(listJson.length, 1);
    const listText = handlers.artifact_release_list({ format: 'text', limit: 5 }) as string;
    assert.ok(listText.includes('B-demo'));
    assert.ok(listText.includes('runtimeSemverChanged=true'));
    const statusJson = handlers.artifact_release_status({ storyId: 'B-demo', format: 'json' }) as { count: number; latest: unknown };
    assert.equal(statusJson.count, 1);
    assert.ok(statusJson.latest);
    const absent = handlers.artifact_release_status({ storyId: 'B-none', format: 'text' }) as string;
    assert.equal(absent, 'No artifact release records found for B-none');
  });

  check('test record helper preserves the provenance-only semver boundary note', () => {
    const record = createArtifactReleaseRecordForTest({
      root,
      storyId: 'B-helper',
      mainCommit: head,
      changedPaths: ['docs/release.md'],
      runtimeSemverChanged: false,
      isRuntimeBuildInput: isDoneMainRuntimeBuildInput,
      now: '2026-07-05T00:02:00.000Z',
    });
    assert.equal(record.runtimeSemverChanged, false);
    assert.ok(record.notes.join('\n').includes('not a non-runtime artifact release ledger'));
  });

  console.log(`artifact-release-ledger smoke passed: ${passed} assertions`);
} finally {
  for (const dir of cleanup.reverse()) {
    rmSync(dir, { recursive: true, force: true });
  }
}
