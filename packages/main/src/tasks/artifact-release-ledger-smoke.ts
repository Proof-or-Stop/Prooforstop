#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  selectArtifactReleasePathsV1,
} from '../core/artifact-release.js';
import { StoryStore } from '../core/store.js';
import { createArtifactReleaseHandlers } from '../handlers/artifact-release.js';
import {
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

function makeGitFixture(): string {
  const root = mkdtemp('artifact-release-ledger-git-');
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
