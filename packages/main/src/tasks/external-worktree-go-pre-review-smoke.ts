#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import * as runtimeRootModule from '../cli/runtime-root.js';
import * as discoveryModule from '../core/acceptance-discovery-adapters.js';
import * as preReviewModule from '../core/pre-review-check.js';
import { deriveAcceptanceCoverageBasis } from '../core/acceptance-coverage-basis.js';
import { issueAcceptanceBasisReceipt, verifyAcceptanceBasisReceipt } from '../core/acceptance-basis-receipt.js';
import { evaluateAcceptanceTopologyCheck } from '../core/acceptance-topology.js';
import { checkScopeContract, readChangedFiles } from '../core/scope-contract.js';
import { SCOPE_PATH_CANONICALIZER_VERSION } from '../core/scope-path-classifier.js';
import { resolveStoryMergeBase } from '../core/story-aware-validation.js';
import { buildMaterialClassificationSnapshot } from '../core/material-code-policy.js';
import { evaluateReviewAssuranceFloor } from '../core/review-assurance-floor.js';
import { loadConfig } from '../core/config.js';
import { inspectExpectedControllerRuntimeProjection } from '../core/runtime-artifact-registry.js';
import {
  classifierOptionsForCheck,
  classifyGitStatusRows,
  isBlockingDirty,
  readGitStatusLines,
} from '../core/dirty-worktree-gate.js';
import { renderReproFirstStoryCreatePreflight } from '../handlers/story-create.js';
import { createReviewRunHandlers } from '../handlers/review-run.js';
import { StoryStore } from '../core/store.js';
import { captureVerificationFreshness, createCurrentVerificationAssertionReceipt, createVerificationExecutionReceipt } from '../core/verification-execution-evidence.js';
import type { ChecklistData, StoryInfo, VerificationEvidence } from '../core/types.js';

type ProjectControllerAssets = (input: { controllerRoot: string; worktreeRoot: string; storyId: string }) => {
  storyRoot: string;
  configDigest: string;
};
type ResolveProfile = (workspaceRoot: string) => 'typescript-topology' | 'go-command' | 'unsupported';
type EvaluateCommands = (input: {
  gitCwd: string;
  metadataRoot: string;
  storyId: string;
  checklist: ChecklistData;
  cutoffAt: string;
  freshness: { headHash: string; materialHash: string; storyFilesHash: string };
}) => { ok: boolean; codes: string[]; goTestReceiptCount: number };

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepository(root: string): void {
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'lab@example.invalid']);
  git(root, ['config', 'user.name', 'Lab']);
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'fixture']);
}

function assertOrdinaryLinkedWorktreeHasNoControllerProjectionGate(): void {
  const primaryRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-ordinary-primary-'));
  const storyId = 'B-ordinary';
  const worktreeRoot = join(primaryRoot, '.worktrees', storyId);
  try {
    initRepository(primaryRoot);
    git(primaryRoot, ['branch', `story/${storyId}`]);
    mkdirSync(join(primaryRoot, '.worktrees'), { recursive: true });
    git(primaryRoot, ['worktree', 'add', '-q', worktreeRoot, `story/${storyId}`]);
    const status = inspectExpectedControllerRuntimeProjection({
      projectRoot: worktreeRoot,
      gitCwd: worktreeRoot,
      storyId,
    });
    assert.equal(status.expected, false, 'ordinary linked worktrees must not require controller runtime assets');
    assert.equal(status.valid, true, 'ordinary linked worktree applicability resolves without a projection failure');
    assert.equal(status.reason, 'not-controller-managed-worktree');
    const unresolved = inspectExpectedControllerRuntimeProjection({
      projectRoot: join(worktreeRoot, 'missing-project-root'),
      gitCwd: join(worktreeRoot, 'missing-git-root'),
      storyId,
    });
    assert.equal(unresolved.expected, false, 'an applicability resolution error must not invent a controller projection requirement');
    assert.equal(unresolved.reason, 'controller-applicability-unresolved');
  } finally {
    rmSync(primaryRoot, { recursive: true, force: true });
  }
}

function story(storyId: string, worktreePath: string): StoryInfo {
  const now = '2026-09-11T00:00:00.000Z';
  return {
    storyId, name: 'external-controller-fixture', title: 'External controller fixture',
    description: 'Fixture for branch-local Story metadata projection.', type: 'bug', phase: 'DEV', priority: 'high',
    createdAt: now, startedAt: now, endedAt: null,
    worktree: { path: worktreePath, branch: `story/${storyId}`, createdAt: now },
    events: [{ phase: 'DEV', action: 'advance', timestamp: now }],
  };
}

function assertExternalControllerProjection(project: ProjectControllerAssets): void {
  const cliEntry = join(process.cwd(), 'packages', 'main', 'dist', 'cli.js');
  const controllerRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-controller-'));
  const storyId = 'B-ext-controller';
  const worktreeRoot = join(controllerRoot, '.worktrees', storyId);
  try {
    initRepository(controllerRoot);
    mkdirSync(join(controllerRoot, '.proof-or-stop'), { recursive: true });
    writeFileSync(join(controllerRoot, '.proof-or-stop', 'proof-or-stop.json'), '{"assetMode":"global-thin"}\n');
    mkdirSync(join(controllerRoot, '.codex', 'hooks'), { recursive: true });
    writeFileSync(join(controllerRoot, '.codex', 'hooks.json'), '{"hooks":[]}\n');
    writeFileSync(join(controllerRoot, '.codex', 'hooks', 'proof-or-stop-evidence-pretool.cjs'), 'module.exports = {};\n');
    writeFileSync(join(controllerRoot, '.codex', 'hooks', 'proof-or-stop-scope-pretool.cjs'), 'module.exports = {};\n');
    git(controllerRoot, ['branch', `story/${storyId}`]);
    mkdirSync(join(controllerRoot, '.worktrees'), { recursive: true });
    git(controllerRoot, ['worktree', 'add', '-q', worktreeRoot, `story/${storyId}`]);

    const configBytes = JSON.stringify({ storyDir: '.proof-or-stop/story/actives', scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures' }, null, 2);
    writeFileSync(join(controllerRoot, 'proof-or-stop.config.json'), configBytes);
    const controllerStore = new StoryStore(controllerRoot);
    controllerStore.writeStory(storyId, story(storyId, worktreeRoot));
    controllerStore.writeChecklist(storyId, { items: [{ id: 'CHK-001', title: 'projection', context: 'external controller fixture', status: 'pending', startTime: null, endTime: null }] });
    const controllerLeasePath = join(controllerStore.storyDirPath(storyId), 'owner-lease.json');
    const lease = { leaseId: 'lab-lease', sessionId: 'lab-owner', sessionSource: 'explicit-env', hostname: 'lab', pid: 1, cwd: controllerRoot, command: 'story_create', acquiredAt: '2026-09-11T00:00:00.000Z', heartbeatAt: '2026-09-11T00:00:00.000Z' };
    writeFileSync(controllerLeasePath, JSON.stringify(lease));
    const controllerLeaseBytes = readFileSync(controllerLeasePath, 'utf8');

    // Simulate a crash after installing config but before Story projection.
    writeFileSync(join(worktreeRoot, 'proof-or-stop.config.json'), configBytes);
    const cliOutput = execFileSync(process.execPath, [cliEntry, '--root', controllerRoot, 'checklist_update', `--storyId=${storyId}`, '--itemId=CHK-001', '--status=in_progress'], {
      cwd: worktreeRoot,
      encoding: 'utf8',
      env: { ...process.env, PROOF_OR_STOP_AGENT: 'main', PROOF_OR_STOP_SESSION_ID: 'lab-owner' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(cliOutput, /metadata auto-committed/, 'real CLI projects and commits controller metadata in the linked worktree');
    const projectionReceiptPaths = [
      `.proof-or-stop/story/actives/${storyId}/evidence/controller-config-projection.json`,
      `.proof-or-stop/story/actives/${storyId}/evidence/controller-runtime-projection.json`,
    ];
    for (const receiptPath of projectionReceiptPaths) {
      assert.equal(existsSync(join(worktreeRoot, receiptPath)), true, `${receiptPath} remains present for runtime verification`);
      assert.equal(
        git(worktreeRoot, ['ls-files', '--', receiptPath]),
        '',
        `LAB_RED: controller projection receipt must remain untracked after the first real metadata auto-commit: ${receiptPath}`,
      );
    }
    const secondCliOutput = execFileSync(process.execPath, [cliEntry, '--root', controllerRoot, 'checklist_update', `--storyId=${storyId}`, '--itemId=CHK-001', '--status=pending'], {
      cwd: worktreeRoot,
      encoding: 'utf8',
      env: { ...process.env, PROOF_OR_STOP_AGENT: 'main', PROOF_OR_STOP_SESSION_ID: 'lab-owner' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(secondCliOutput, /metadata auto-committed/, 'second real CLI metadata mutation is auto-committed');
    for (const receiptPath of projectionReceiptPaths) {
      assert.equal(existsSync(join(worktreeRoot, receiptPath)), true, `${receiptPath} remains present after the second metadata auto-commit`);
      assert.equal(
        git(worktreeRoot, ['ls-files', '--', receiptPath]),
        '',
        `controller projection receipt must remain untracked after repeated metadata auto-commit: ${receiptPath}`,
      );
    }
    assert.equal(readFileSync(controllerLeasePath, 'utf8'), controllerLeaseBytes, 'controller owner lease remains byte-identical during bootstrap');
    const projected = project({ controllerRoot, worktreeRoot, storyId });
    assert.equal(projected.storyRoot, join(realpathSync(worktreeRoot), '.proof-or-stop/story/actives', storyId));
    assert.equal(readFileSync(join(worktreeRoot, 'proof-or-stop.config.json'), 'utf8'), configBytes, 'controller config bytes are projected exactly');
    const localStore = new StoryStore(worktreeRoot);
    const checklist = localStore.readChecklist(storyId);
    assert.equal(checklist.items[0]!.status, 'pending');
    const projectedStatus = readGitStatusLines(worktreeRoot);
    assert.equal(projectedStatus.ok, true, 'projected Story worktree git status is readable');
    const projectedClassification = classifyGitStatusRows(
      projectedStatus.ok ? projectedStatus.lines : [],
      classifierOptionsForCheck(loadConfig(worktreeRoot), storyId, localStore, worktreeRoot),
    );
    const projectedDirty = isBlockingDirty(projectedClassification);
    assert.equal(
      projectedDirty.blocked,
      false,
      `LAB_RED: valid signed controller config and hook projections must not block review_run_start: ${projectedDirty.blockingPaths.join(', ')}`,
    );
    const projectedRuntimePaths = projectedClassification.groups.runtime_artifact_changes.map(entry => entry.path);
    assert.ok(projectedRuntimePaths.includes('proof-or-stop.config.json'), 'valid projected controller config is classified as a runtime artifact');
    for (const hookPath of [
      '.codex/hooks.json',
      '.codex/hooks/proof-or-stop-evidence-pretool.cjs',
      '.codex/hooks/proof-or-stop-scope-pretool.cjs',
    ]) {
      assert.ok(projectedRuntimePaths.includes(hookPath), `${hookPath} is classified as a runtime artifact`);
    }

    const expectedHookPaths = [
      '.codex/hooks.json',
      '.codex/hooks/proof-or-stop-evidence-pretool.cjs',
      '.codex/hooks/proof-or-stop-scope-pretool.cjs',
    ];
    for (const expectedHookPath of expectedHookPaths) rmSync(join(worktreeRoot, expectedHookPath));
    const missingProjection = inspectExpectedControllerRuntimeProjection({
      projectRoot: worktreeRoot,
      gitCwd: worktreeRoot,
      storyId,
    });
    assert.equal(missingProjection.expected, true, 'global-thin Story worktree requires the controller runtime projection');
    assert.equal(
      missingProjection.valid,
      false,
      'LAB_RED: review preflight must reject an entirely absent untracked controller runtime projection',
    );
    project({ controllerRoot, worktreeRoot, storyId });
    const restoredProjection = inspectExpectedControllerRuntimeProjection({
      projectRoot: worktreeRoot,
      gitCwd: worktreeRoot,
      storyId,
    });
    assert.equal(restoredProjection.valid, true, 'CLI bootstrap restores the exact signed controller runtime projection before review');

    git(controllerRoot, ['add', '-f', 'proof-or-stop.config.json', ...expectedHookPaths]);
    git(controllerRoot, ['commit', '-qm', 'adopt controller runtime assets']);
    const controllerOwnedProjection = inspectExpectedControllerRuntimeProjection({
      projectRoot: worktreeRoot,
      gitCwd: worktreeRoot,
      storyId,
    });
    assert.equal(
      controllerOwnedProjection.valid,
      true,
      `LAB_RED: committing byte-identical controller assets must not poison a valid Story projection (${controllerOwnedProjection.reason})`,
    );
    git(controllerRoot, ['reset', '--mixed', 'HEAD^']);

    git(worktreeRoot, ['add', '-f', ...expectedHookPaths]);
    assert.equal(
      inspectExpectedControllerRuntimeProjection({ projectRoot: worktreeRoot, gitCwd: worktreeRoot, storyId }).valid,
      true,
      'tracking exact signed hook projections does not invalidate projection identity',
    );
    const stagedHookStatus = readGitStatusLines(worktreeRoot);
    assert.equal(stagedHookStatus.ok, true);
    assert.equal(isBlockingDirty(classifyGitStatusRows(
      stagedHookStatus.ok ? stagedHookStatus.lines : [],
      classifierOptionsForCheck(loadConfig(worktreeRoot), storyId, localStore, worktreeRoot),
    )).blocked, true, 'newly tracked hook projections remain subject to the ordinary dirty gate');
    git(worktreeRoot, ['rm', '--cached', '-q', ...expectedHookPaths]);
    git(worktreeRoot, ['add', '-f', 'proof-or-stop.config.json']);
    assert.equal(
      inspectExpectedControllerRuntimeProjection({ projectRoot: worktreeRoot, gitCwd: worktreeRoot, storyId }).valid,
      true,
      'tracking the exact signed config projection does not invalidate projection identity',
    );
    const stagedConfigStatus = readGitStatusLines(worktreeRoot);
    assert.equal(stagedConfigStatus.ok, true);
    assert.equal(isBlockingDirty(classifyGitStatusRows(
      stagedConfigStatus.ok ? stagedConfigStatus.lines : [],
      classifierOptionsForCheck(loadConfig(worktreeRoot), storyId, localStore, worktreeRoot),
    )).blocked, true, 'a newly tracked config projection remains subject to the ordinary dirty gate');
    git(worktreeRoot, ['rm', '--cached', '-q', 'proof-or-stop.config.json']);

    for (const expectedHookPath of expectedHookPaths) rmSync(join(worktreeRoot, expectedHookPath));
    const reviewStory = localStore.readStory(storyId);
    localStore.writeStory(storyId, { ...reviewStory, phase: 'REVIEW' });
    const previousReviewerAgent = process.env.PROOF_OR_STOP_AGENT;
    const previousCwd = process.cwd();
    process.env.PROOF_OR_STOP_AGENT = 'proof-or-stop-review-quality';
    process.chdir(worktreeRoot);
    try {
      const reviewHandlers = createReviewRunHandlers({ store: localStore, root: worktreeRoot, scanRoot: worktreeRoot });
      assert.throws(
        () => reviewHandlers.review_run_start({ storyId }),
        /controller runtime projection is incomplete or invalid/,
        'real review_run_start handler rejects an entirely absent controller projection before snapshotting',
      );
    } finally {
      process.chdir(previousCwd);
      if (previousReviewerAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
      else process.env.PROOF_OR_STOP_AGENT = previousReviewerAgent;
    }
    localStore.writeStory(storyId, reviewStory);
    project({ controllerRoot, worktreeRoot, storyId });

    const singleMissingHookPath = '.codex/hooks/proof-or-stop-scope-pretool.cjs';
    rmSync(join(worktreeRoot, singleMissingHookPath));
    const singleMissingStatus = readGitStatusLines(worktreeRoot);
    assert.equal(singleMissingStatus.ok, true, 'single-hook deletion git status remains readable');
    assert.equal(
      singleMissingStatus.ok && singleMissingStatus.lines.some(line => line.endsWith(` ${singleMissingHookPath}`)),
      false,
      'git status has no row for the absent untracked controller hook',
    );
    assert.equal(
      inspectExpectedControllerRuntimeProjection({ projectRoot: worktreeRoot, gitCwd: worktreeRoot, storyId }).valid,
      false,
      'LAB_RED: review preflight must reject a single absent untracked controller hook that git status cannot observe',
    );
    localStore.writeStory(storyId, { ...reviewStory, phase: 'REVIEW' });
    process.env.PROOF_OR_STOP_AGENT = 'proof-or-stop-review-quality';
    process.chdir(worktreeRoot);
    try {
      const reviewHandlers = createReviewRunHandlers({ store: localStore, root: worktreeRoot, scanRoot: worktreeRoot });
      assert.throws(
        () => reviewHandlers.review_run_start({ storyId }),
        /uncommitted unexpected_dirty_files|controller runtime projection is incomplete or invalid/,
        'real review_run_start handler rejects one absent untracked controller hook before snapshotting',
      );
    } finally {
      process.chdir(previousCwd);
      if (previousReviewerAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
      else process.env.PROOF_OR_STOP_AGENT = previousReviewerAgent;
    }
    localStore.writeStory(storyId, reviewStory);
    project({ controllerRoot, worktreeRoot, storyId });

    const hookPath = '.codex/hooks/proof-or-stop-evidence-pretool.cjs';
    const hookBytes = readFileSync(join(worktreeRoot, hookPath));
    writeFileSync(join(worktreeRoot, hookPath), `${hookBytes.toString('utf8')}tampered\n`);
    const tamperedStatus = readGitStatusLines(worktreeRoot);
    assert.equal(tamperedStatus.ok, true, 'tampered Story worktree git status is readable');
    const tamperedDirty = isBlockingDirty(classifyGitStatusRows(
      tamperedStatus.ok ? tamperedStatus.lines : [],
      classifierOptionsForCheck(loadConfig(worktreeRoot), storyId, localStore, worktreeRoot),
    ));
    assert.equal(tamperedDirty.blocked, true, 'a changed projected hook must return to fail-closed dirty classification');
    assert.ok(tamperedDirty.blockingPaths.includes(hookPath), 'fail-closed classification identifies the changed projected hook');
    writeFileSync(join(worktreeRoot, hookPath), hookBytes);
    assert.match(git(worktreeRoot, ['show', '--name-only', '--format=', 'HEAD']), new RegExp(`^\\.proof-or-stop/story/actives/${storyId}/`, 'm'));
    assert.equal(git(controllerRoot, ['status', '--porcelain', '--', `.proof-or-stop/story/actives/${storyId}`]).startsWith('??'), true, 'controller Story copy remains read-only and uncommitted');

    rmSync(join(worktreeRoot, '.proof-or-stop'), { recursive: true, force: true });
    assert.throws(() => execFileSync(process.execPath, [cliEntry, '--root', controllerRoot, 'checklist_update', `--storyId=${storyId}`, '--itemId=CHK-001', '--status=in_progress'], {
      cwd: worktreeRoot, encoding: 'utf8', env: { ...process.env, PROOF_OR_STOP_AGENT: 'main', PROOF_OR_STOP_SESSION_ID: 'lab-owner' }, stdio: ['ignore', 'pipe', 'pipe'],
    }), /branch-local authoritative Story/, 'a committed branch-local Story cannot be repopulated from the stale controller copy');
    git(worktreeRoot, ['checkout', '--', '.proof-or-stop']);
    assert.equal(new StoryStore(worktreeRoot).readChecklist(storyId).items[0]!.status, 'pending', 'branch-local recovery restores the committed authority');

    rmSync(join(worktreeRoot, '.proof-or-stop'), { recursive: true, force: true });
    const escapeTarget = join(controllerRoot, 'escape-target');
    mkdirSync(escapeTarget);
    symlinkSync(escapeTarget, join(worktreeRoot, '.proof-or-stop'));
    assert.throws(() => project({ controllerRoot, worktreeRoot, storyId }), /symlink|escaping|unsafe/i, 'destination ancestor symlink is rejected');
    rmSync(join(worktreeRoot, '.proof-or-stop'));
    git(worktreeRoot, ['checkout', '--', '.proof-or-stop']);

    writeFileSync(join(worktreeRoot, 'proof-or-stop.config.json'), '{"storyDir":"wrong"}\n');
    assert.throws(() => project({ controllerRoot, worktreeRoot, storyId }), /mismatched worktree configuration/i, 'an existing mismatched config cannot be blessed');
    writeFileSync(join(worktreeRoot, 'proof-or-stop.config.json'), configBytes);
    rmSync(join(worktreeRoot, 'proof-or-stop.config.json'));
    symlinkSync(join(controllerRoot, 'proof-or-stop.config.json'), join(worktreeRoot, 'proof-or-stop.config.json'));
    assert.throws(() => project({ controllerRoot, worktreeRoot, storyId }), /symlink|no-follow|unsafe/i, 'escaping config symlink is rejected');

    const nested = join(worktreeRoot, 'nested');
    mkdirSync(nested);
    initRepository(nested);
    assert.throws(() => project({ controllerRoot, worktreeRoot: nested, storyId }), /signed|linked worktree|authority/i, 'nested repository guessing is rejected');

    const deniedStoryId = 'B-reviewer-denied';
    const deniedWorktree = join(controllerRoot, '.worktrees', deniedStoryId);
    git(controllerRoot, ['branch', `story/${deniedStoryId}`]);
    git(controllerRoot, ['worktree', 'add', '-q', deniedWorktree, `story/${deniedStoryId}`]);
    controllerStore.writeStory(deniedStoryId, story(deniedStoryId, deniedWorktree));
    controllerStore.writeChecklist(deniedStoryId, { items: [{ id: 'CHK-001', title: 'denied', context: 'reviewer cannot mutate', status: 'pending', startTime: null, endTime: null }] });
    assert.throws(() => execFileSync(process.execPath, [cliEntry, '--root', controllerRoot, 'checklist_update', `--storyId=${deniedStoryId}`, '--itemId=CHK-001', '--status=in_progress'], {
      cwd: deniedWorktree, encoding: 'utf8', env: { ...process.env, PROOF_OR_STOP_AGENT: 'proof-or-stop-review-quality' }, stdio: ['ignore', 'pipe', 'pipe'],
    }), /agent_dispatch_mutation_denied/, 'reviewer authority is rejected before projection');
    assert.equal(existsSync(join(deniedWorktree, 'proof-or-stop.config.json')), false);
    assert.equal(existsSync(join(deniedWorktree, '.proof-or-stop')), false);
  } finally {
    rmSync(controllerRoot, { recursive: true, force: true });
  }
}

function assertUntrackedControllerConfigAndMasterBaseline(project: ProjectControllerAssets): void {
  const controllerRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-untracked-config-'));
  const storyId = 'B-untracked-config';
  const worktreeRoot = join(controllerRoot, '.worktrees', storyId);
  try {
    git(controllerRoot, ['init', '-q', '-b', 'master']);
    git(controllerRoot, ['config', 'user.email', 'lab@example.invalid']);
    git(controllerRoot, ['config', 'user.name', 'Lab']);
    writeFileSync(join(controllerRoot, 'README.md'), 'fixture\n');
    const controllerStore = new StoryStore(controllerRoot);
    controllerStore.writeStory(storyId, story(storyId, worktreeRoot));
    controllerStore.writeChecklist(storyId, { items: [{ id: 'CHK-001', title: 'feature', context: 'master-only external fixture', status: 'done', startTime: null, endTime: null }] });
    git(controllerRoot, ['add', 'README.md']);
    git(controllerRoot, ['add', '-f', `.proof-or-stop/story/actives/${storyId}`]);
    git(controllerRoot, ['commit', '-qm', 'master fixture with Story metadata']);
    const masterHead = git(controllerRoot, ['rev-parse', 'HEAD']);
    git(controllerRoot, ['branch', `story/${storyId}`]);
    mkdirSync(join(controllerRoot, '.worktrees'), { recursive: true });
    git(controllerRoot, ['worktree', 'add', '-q', worktreeRoot, `story/${storyId}`]);

    const configBytes = JSON.stringify({ storyDir: '.proof-or-stop/story/actives', scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures' }, null, 2);
    writeFileSync(join(controllerRoot, 'proof-or-stop.config.json'), configBytes);
    assert.equal(git(controllerRoot, ['ls-files', '--', 'proof-or-stop.config.json']), '', 'controller config is intentionally untracked');
    try {
      project({ controllerRoot, worktreeRoot, storyId });
    } catch (error) {
      assert.fail(`LAB_RED: missing untracked controller config cannot bootstrap: ${error instanceof Error ? error.message : String(error)}`);
    }
    assert.equal(readFileSync(join(worktreeRoot, 'proof-or-stop.config.json'), 'utf8'), configBytes, 'missing target config is installed from the controller');

    writeFileSync(join(worktreeRoot, 'feature.go'), 'implemented\n');
    git(worktreeRoot, ['add', 'feature.go']);
    git(worktreeRoot, ['commit', '-qm', 'implement benchmark feature']);
    git(controllerRoot, ['update-ref', 'refs/remotes/origin/story/poison', git(worktreeRoot, ['rev-parse', 'HEAD'])]);
    git(controllerRoot, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/story/poison']);
    assert.equal(resolveStoryMergeBase(worktreeRoot, 'HEAD'), masterHead, 'master-only repositories resolve the real baseline without a local main alias');
    const changedFiles = readChangedFiles(worktreeRoot);
    assert.ok(changedFiles.includes('feature.go'), `master-relative scope includes the feature commit: ${changedFiles.join(',')}`);
    assert.ok(changedFiles.includes('proof-or-stop.config.json'), 'the untracked projected config remains visible for provenance classification');
    const scope = checkScopeContract({
      storyId, mode: 'enforce', allowedModify: [], allowedCreate: ['feature.go'], allowedTest: [], protectedFiles: [], explicitExcludes: [], acknowledgements: [],
      pathCanonicalizerVersion: SCOPE_PATH_CANONICALIZER_VERSION, pathCanonicalizationMode: 'enforce', createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
    }, changedFiles, { projectRoot: worktreeRoot, gitCwd: worktreeRoot });
    assert.equal(scope.status, 'pass', `byte-identical projected config is a control asset, not an acceptance amendment: ${JSON.stringify(scope.violations)}`);
    assert.equal(scope.rows?.find(row => row.path === 'proof-or-stop.config.json')?.rule, 'runtime_artifact');
    assert.equal(new StoryStore(worktreeRoot).readProofStoryContract(storyId), null, 'recovery does not require or synthesize a ProofStory contract');
    const material = buildMaterialClassificationSnapshot(worktreeRoot, { gitCwd: worktreeRoot });
    assert.ok(material.files.some(file => file.path === 'feature.go'), 'material-code scope assurance resolves the master baseline');
    const assurance = evaluateReviewAssuranceFloor({ projectRoot: worktreeRoot, gitCwd: worktreeRoot, storyId });
    assert.equal(assurance.diffError, undefined, 'review-assurance consumer can enumerate a master-only repository');
    assert.ok(assurance.changedFiles.some(file => file.path === 'feature.go'), 'review-assurance consumer receives the master-relative feature diff');
    const intake = renderReproFirstStoryCreatePreflight({
      projectRoot: worktreeRoot, storyId: 'B-intake-probe', name: 'master-intake', title: 'Master intake probe',
      description: 'Verify that Story intake classifies a material file on a master-only repository.', type: 'bug', phase: 'INIT', priority: 'medium',
      checklist: { items: [{ id: 'CHK-001', title: 'feature', context: 'master-only intake', status: 'pending', startTime: null, endTime: null, files: { modify: ['feature.go'], create: [], test: [] } }] },
    });
    assert.match(intake, /missing_story_evidence_binding/, 'the production Story intake handler sees the master-relative material change');
    writeFileSync(join(worktreeRoot, 'proof-or-stop.config.json'), `${configBytes}\n`);
    const drifted = checkScopeContract({
      storyId, mode: 'enforce', allowedModify: [], allowedCreate: ['feature.go'], allowedTest: [], protectedFiles: [], explicitExcludes: [], acknowledgements: [],
      pathCanonicalizerVersion: SCOPE_PATH_CANONICALIZER_VERSION, pathCanonicalizationMode: 'enforce', createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
    }, changedFiles, { projectRoot: worktreeRoot, gitCwd: worktreeRoot });
    assert.equal(drifted.status, 'fail', 'changed projected config returns to ordinary enforce-scope handling');
    const changedBoth = `${configBytes}\nchanged together\n`;
    writeFileSync(join(controllerRoot, 'proof-or-stop.config.json'), changedBoth);
    writeFileSync(join(worktreeRoot, 'proof-or-stop.config.json'), changedBoth);
    const doubleDrift = checkScopeContract({
      storyId, mode: 'enforce', allowedModify: [], allowedCreate: ['feature.go'], allowedTest: [], protectedFiles: [], explicitExcludes: [], acknowledgements: [],
      pathCanonicalizerVersion: SCOPE_PATH_CANONICALIZER_VERSION, pathCanonicalizationMode: 'enforce', createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
    }, changedFiles, { projectRoot: worktreeRoot, gitCwd: worktreeRoot });
    assert.equal(doubleDrift.status, 'fail', 'changing both untracked copies identically cannot rewrite the signed initial projection');
    writeFileSync(join(controllerRoot, 'proof-or-stop.config.json'), configBytes);
    writeFileSync(join(worktreeRoot, 'proof-or-stop.config.json'), configBytes);
    const commonDir = git(worktreeRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const commonReceipt = join(commonDir, 'proof-or-stop-controller-config-projections', `${storyId}.json`);
    const receiptBytes = readFileSync(commonReceipt);
    const storyReceipt = join(worktreeRoot, '.proof-or-stop', 'story', 'actives', storyId, 'evidence', 'controller-config-projection.json');
    const storyReceiptBytes = readFileSync(storyReceipt);
    rmSync(storyReceipt);
    symlinkSync(commonReceipt, storyReceipt);
    assert.throws(() => project({ controllerRoot, worktreeRoot, storyId }), /symlink|receipt|initial projection/i, 'the Story receipt cannot alias the Git-common receipt');
    rmSync(storyReceipt);
    writeFileSync(storyReceipt, storyReceiptBytes, { mode: 0o600 });
    const evidenceDir = join(worktreeRoot, '.proof-or-stop', 'story', 'actives', storyId, 'evidence');
    const escapedEvidence = join(controllerRoot, 'escaped-evidence');
    rmSync(evidenceDir, { recursive: true, force: true });
    mkdirSync(escapedEvidence);
    writeFileSync(join(escapedEvidence, 'controller-config-projection.json'), storyReceiptBytes);
    symlinkSync(escapedEvidence, evidenceDir);
    assert.throws(() => project({ controllerRoot, worktreeRoot, storyId }), /symlink|receipt|initial projection/i, 'the Story evidence parent cannot redirect receipt storage outside the worktree');
    rmSync(evidenceDir);
    mkdirSync(evidenceDir);
    writeFileSync(storyReceipt, storyReceiptBytes, { mode: 0o600 });
    const commonReceiptDir = join(commonDir, 'proof-or-stop-controller-config-projections');
    const commonReceiptBackup = `${commonReceiptDir}.backup`;
    const escapedCommon = join(controllerRoot, 'escaped-common-receipts');
    renameSync(commonReceiptDir, commonReceiptBackup);
    mkdirSync(escapedCommon);
    writeFileSync(join(escapedCommon, `${storyId}.json`), receiptBytes);
    symlinkSync(escapedCommon, commonReceiptDir);
    assert.throws(() => project({ controllerRoot, worktreeRoot, storyId }), /symlink|receipt|initial projection/i, 'the Git-common receipt directory cannot redirect authority outside Git metadata');
    rmSync(commonReceiptDir);
    renameSync(commonReceiptBackup, commonReceiptDir);
    writeFileSync(commonReceipt, '{}\n');
    assert.throws(() => project({ controllerRoot, worktreeRoot, storyId }), /drift|receipt|initial projection/i, 'a corrupted receipt cannot be replaced');
    writeFileSync(commonReceipt, receiptBytes);
    const signingKey = join(commonDir, 'proof-story-aware-validation-artifact-v1.key');
    const keyBytes = readFileSync(signingKey);
    rmSync(signingKey);
    const missingKey = checkScopeContract({
      storyId, mode: 'enforce', allowedModify: [], allowedCreate: ['feature.go'], allowedTest: [], protectedFiles: [], explicitExcludes: [], acknowledgements: [],
      pathCanonicalizerVersion: SCOPE_PATH_CANONICALIZER_VERSION, pathCanonicalizationMode: 'enforce', createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
    }, changedFiles, { projectRoot: worktreeRoot, gitCwd: worktreeRoot });
    assert.equal(missingKey.status, 'fail', 'loss of the trusted signing key removes scope authority');
    writeFileSync(signingKey, keyBytes, { mode: 0o600 });
    rmSync(commonReceipt);
    rmSync(join(worktreeRoot, 'proof-or-stop.config.json'));
    writeFileSync(join(controllerRoot, 'proof-or-stop.config.json'), `${configBytes}\nreissue attempt\n`);
    assert.throws(() => project({ controllerRoot, worktreeRoot, storyId }), /ordinary bootstrap cannot reissue/i, 'deleting the initial receipt cannot authorize a new controller digest');
  } finally {
    rmSync(controllerRoot, { recursive: true, force: true });
  }
}

function assertPrimaryDevelopBeatsStaleMain(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-develop-baseline-'));
  const worktree = join(root, '.worktrees', 'B-develop-baseline');
  try {
    git(root, ['init', '-q', '-b', 'develop']);
    git(root, ['config', 'user.email', 'lab@example.invalid']);
    git(root, ['config', 'user.name', 'Lab']);
    writeFileSync(join(root, 'base.txt'), 'base\n');
    git(root, ['add', 'base.txt']);
    git(root, ['commit', '-qm', 'base']);
    git(root, ['branch', 'main']);
    const staleMain = git(root, ['rev-parse', 'main']);
    writeFileSync(join(root, 'develop.txt'), 'current integration\n');
    git(root, ['add', 'develop.txt']);
    git(root, ['commit', '-qm', 'advance develop']);
    const developHead = git(root, ['rev-parse', 'HEAD']);
    assert.equal(resolveStoryMergeBase(root, 'HEAD'), staleMain, 'an ordinary checkout prefers a conventional baseline over its current non-default branch');
    git(root, ['branch', 'story/B-develop-baseline']);
    mkdirSync(join(root, '.worktrees'), { recursive: true });
    git(root, ['worktree', 'add', '-q', worktree, 'story/B-develop-baseline']);
    writeFileSync(join(worktree, 'feature.go'), 'story\n');
    git(worktree, ['add', 'feature.go']);
    git(worktree, ['commit', '-qm', 'story change']);
    assert.equal(resolveStoryMergeBase(worktree, 'HEAD'), developHead, 'a linked Story worktree uses the primary develop branch instead of a stale conventional main');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertMissingTrackedConfigIsNotRecreated(project: ProjectControllerAssets): void {
  const controllerRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-tracked-config-'));
  const storyId = 'B-tracked-config';
  const worktreeRoot = join(controllerRoot, '.worktrees', storyId);
  try {
    git(controllerRoot, ['init', '-q', '-b', 'main']);
    git(controllerRoot, ['config', 'user.email', 'lab@example.invalid']);
    git(controllerRoot, ['config', 'user.name', 'Lab']);
    const configBytes = JSON.stringify({ storyDir: '.proof-or-stop/story/actives', scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures' }, null, 2);
    writeFileSync(join(controllerRoot, 'proof-or-stop.config.json'), configBytes);
    writeFileSync(join(controllerRoot, 'README.md'), 'fixture\n');
    const store = new StoryStore(controllerRoot);
    store.writeStory(storyId, story(storyId, worktreeRoot));
    store.writeChecklist(storyId, { items: [] });
    git(controllerRoot, ['add', 'README.md', 'proof-or-stop.config.json']);
    git(controllerRoot, ['add', '-f', `.proof-or-stop/story/actives/${storyId}`]);
    git(controllerRoot, ['commit', '-qm', 'tracked configuration fixture']);
    git(controllerRoot, ['branch', `story/${storyId}`]);
    mkdirSync(join(controllerRoot, '.worktrees'), { recursive: true });
    git(controllerRoot, ['worktree', 'add', '-q', worktreeRoot, `story/${storyId}`]);
    rmSync(join(worktreeRoot, 'proof-or-stop.config.json'));
    writeFileSync(join(controllerRoot, 'proof-or-stop.config.json'), `${configBytes}\ncontroller drift\n`);
    assert.throws(
      () => project({ controllerRoot, worktreeRoot, storyId }),
      /missing tracked worktree configuration/i,
      'a deleted tracked config must be restored from Git rather than recreated from controller working bytes',
    );
    assert.equal(existsSync(join(worktreeRoot, 'proof-or-stop.config.json')), false);
  } finally {
    rmSync(controllerRoot, { recursive: true, force: true });
  }
}

function evidenceFixture(root: string, storyId: string, run: { code?: number; output?: string; timedOut?: boolean } = {}): { checklist: ChecklistData; evidence: VerificationEvidence; freshness: ReturnType<typeof captureVerificationFreshness> } {
  const command = 'go test ./...';
  const selector = 'ok\tfixture';
  const freshness = captureVerificationFreshness(root, root);
  const execution = createVerificationExecutionReceipt({
    projectRoot: root,
    storyId,
    command,
    cwd: root,
    run: { code: run.code ?? 0, output: run.output ?? `${selector}\n`, timedOut: run.timedOut ?? false, durationMs: 5, timeoutMs: 120_000, executable: 'go', args: ['test', './...'] },
  });
  assert.equal(basename(execution.executable), 'go');
  const receipt = createCurrentVerificationAssertionReceipt({ projectRoot: root, storyId, executionReceipt: execution, intentRef: 'GO-TEST', selector, freshness });
  const evidence: VerificationEvidence = {
    intentRef: 'GO-TEST', kind: 'manual_transcript', mechanical: true, receipt, command, result: 'pass', note: 'tool-owned Go test receipt',
    ...freshness, timestamp: new Date(Date.now() - 1_000).toISOString(),
  };
  const checklist: ChecklistData = { items: [{
    id: 'CHK-001', title: 'Go verification', context: 'pure Go fixture', status: 'done', startTime: null, endTime: null,
    verificationIntent: { happy: [{ id: 'GO-TEST', desc: 'go test passes', type: 'cli', priority: 'must', verification: { command, selector } }], edge: [], adversarial: [] },
    verificationEvidence: [evidence],
  }] };
  return { checklist, evidence, freshness };
}

function assertGoCommandProfile(resolveProfile: ResolveProfile, evaluate: EvaluateCommands): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-go-profile-'));
  try {
    initRepository(root);
    writeFileSync(join(root, 'go.mod'), 'module fixture\n\ngo 1.22\n');
    writeFileSync(join(root, 'fixture.go'), 'package fixture\n');
    git(root, ['add', 'go.mod', 'fixture.go']);
    git(root, ['commit', '-qm', 'go fixture']);
    assert.equal(resolveProfile(root), 'go-command', 'pure Go workspace selects go-command');
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    assert.equal(resolveProfile(root), 'typescript-topology', 'mixed workspace retains strict TypeScript topology');
    rmSync(join(root, 'tsconfig.json'));
    mkdirSync(join(root, 'packages', 'frontend'), { recursive: true });
    writeFileSync(join(root, 'packages', 'frontend', 'tsconfig.json'), '{}');
    assert.equal(resolveProfile(root), 'typescript-topology', 'nested TypeScript packages keep mixed monorepos on strict topology');
    rmSync(join(root, 'packages'), { recursive: true });
    let deep = root;
    for (let index = 0; index < 7; index += 1) {
      deep = join(deep, `level-${index}`);
      mkdirSync(deep);
    }
    writeFileSync(join(deep, 'tsconfig.json'), '{}');
    assert.equal(resolveProfile(root), 'unsupported', 'depth-limited TypeScript discovery fails closed instead of selecting Go');
    rmSync(join(root, 'level-0'), { recursive: true });
    const crowded = join(root, 'crowded');
    mkdirSync(crowded);
    for (let index = 0; index < 4_097; index += 1) writeFileSync(join(crowded, `entry-${index}`), '');
    assert.equal(resolveProfile(root), 'unsupported', 'budget-limited discovery fails closed instead of selecting Go');
    rmSync(crowded, { recursive: true });

    const storyId = 'B-go-command';
    const { checklist, freshness } = evidenceFixture(root, storyId);
    // Keep the fixed cutoff comfortably beyond this fixture's later receipt
    // mutations; a one-second horizon made selector/failure negatives depend on
    // machine speed rather than evidence semantics.
    const cutoffAt = new Date(Date.now() + 60_000).toISOString();
    const pass = evaluate({ gitCwd: root, metadataRoot: root, storyId, checklist, cutoffAt, freshness });
    assert.equal(pass.ok, true, `current tool-owned go test receipt passes: ${pass.codes.join(',')}`);
    assert.equal(pass.goTestReceiptCount, 1);

    const plan = deriveAcceptanceCoverageBasis({ storyId, workspaceRoot: root, checklist, contract: null, scopeCheck: null, scopeContract: null, ...freshness, verificationProfile: 'go-command', phaseBasis: 'plan' });
    const planArtifact = { schemaVersion: 'proofstory.acceptance_basis_artifact.v1' as const, basis: plan.basis, receipt: issueAcceptanceBasisReceipt({ gitCwd: root, basis: plan.basis, topologyDigest: plan.topologyDigest }) };
    const planReceipt = verifyAcceptanceBasisReceipt({ artifact: planArtifact, gitCwd: root, metadataRoot: root, expectedStoryId: storyId, expectedTopologyDigest: plan.topologyDigest, expectedClosureFilesHash: plan.basis.binding.closureFilesHash, expectedSealDigest: plan.basis.snapshotSeal.sealDigest });
    const planGate = evaluateAcceptanceTopologyCheck({ storyId, mode: 'enforce', checklist, contract: null, ledger: null, artifact: planArtifact, receiptVerification: planReceipt, currentBasisDiagnostics: plan.diagnostics, topologyBasisDiagnostics: [] });
    assert.equal(planGate.structuralPass, true, `go-command PLAN admission is reachable in enforce mode: ${planGate.diagnostics.map(row => row.code).join(',')}; basis=${plan.basis.status}; receipt=${JSON.stringify(planReceipt)}`);
    const current = deriveAcceptanceCoverageBasis({ storyId, workspaceRoot: root, checklist, contract: null, scopeCheck: null, scopeContract: null, ...freshness, verificationProfile: 'go-command', phaseBasis: 'pre_review', priorPlanBasisDigest: plan.basis.basisDigest });
    const currentArtifact = { schemaVersion: 'proofstory.acceptance_basis_artifact.v1' as const, basis: current.basis, receipt: issueAcceptanceBasisReceipt({ gitCwd: root, basis: current.basis, topologyDigest: current.topologyDigest }) };
    const rebound = evaluate({ gitCwd: root, metadataRoot: root, storyId, checklist, cutoffAt, freshness: current.basis.binding });
    assert.equal(rebound.ok, true, `basis freshness retains command receipt authority: ${rebound.codes.join(',')}; basis=${JSON.stringify(current.basis.binding)} receipt=${JSON.stringify(freshness)}`);
    const preReviewInput = { gitCwd: root, metadataRoot: root, storyId, mode: 'enforce' as const, cutoffAt, planArtifact, currentArtifact, checklist, contract: null, executableProof: null, topologyDigest: current.topologyDigest, topologyDiagnosticCodes: [], verificationProfile: 'go-command' as const };
    const artifact = preReviewModule.issuePreReviewCheckArtifact(preReviewInput);
    assert.equal(artifact.status, 'pass', `pure Go pre-review issues a passing artifact: ${artifact.codes.join(',')}`);
    const verified = preReviewModule.verifyPreReviewCheckArtifact({ ...preReviewInput, artifact });
    assert.equal(verified.ok, true, `pure Go pre-review verifies registered current evidence: ${verified.codes.join(',')}`);
    assert.equal(verified.mutations, 'not_required');
    assert.equal(verified.transcript, 'not_required');

    mkdirSync(join(root, '.proof-or-stop', 'story', 'actives', storyId), { recursive: true });
    writeFileSync(join(root, '.proof-or-stop', 'story', 'actives', storyId, 'metadata-only.json'), '{}\n');
    git(root, ['add', '-f', `.proof-or-stop/story/actives/${storyId}/metadata-only.json`]);
    git(root, ['commit', '-qm', 'metadata-only receipt publication']);
    const afterMetadataCommit = captureVerificationFreshness(root, root);
    assert.equal(evaluate({ gitCwd: root, metadataRoot: root, storyId, checklist, cutoffAt, freshness: afterMetadataCommit }).ok, true, 'metadata auto-commit does not stale current Go evidence');

    const missing = structuredClone(checklist); missing.items[0]!.verificationEvidence = [];
    assert.ok(evaluate({ gitCwd: root, metadataRoot: root, storyId, checklist: missing, cutoffAt, freshness }).codes.includes('PR_POSITIVE_EVIDENCE_MISSING'));
    const failed = structuredClone(checklist); failed.items[0]!.verificationEvidence![0]!.result = 'fail';
    assert.ok(evaluate({ gitCwd: root, metadataRoot: root, storyId, checklist: failed, cutoffAt, freshness }).codes.includes('PR_POSITIVE_EVIDENCE_MISSING'));
    const signedFailure = evidenceFixture(root, `${storyId}-signed-failure`, { code: 1 });
    assert.ok(evaluate({ gitCwd: root, metadataRoot: root, storyId: `${storyId}-signed-failure`, checklist: signedFailure.checklist, cutoffAt, freshness: signedFailure.freshness }).codes.includes('PR_POSITIVE_EVIDENCE_MISSING'), 'a signed non-zero execution cannot be relabeled pass');
    const selectorMiss = evidenceFixture(root, `${storyId}-selector-miss`, { output: 'ok\tother\n' });
    assert.ok(evaluate({ gitCwd: root, metadataRoot: root, storyId: `${storyId}-selector-miss`, checklist: selectorMiss.checklist, cutoffAt, freshness: selectorMiss.freshness }).codes.includes('PR_POSITIVE_EVIDENCE_MISSING'), 'a signed selector miss cannot be relabeled pass');
    const renewed = structuredClone(checklist);
    const historical = structuredClone(renewed.items[0]!.verificationEvidence![0]!);
    historical.storyFilesHash = `sha256:${'0'.repeat(64)}`;
    renewed.items[0]!.verificationEvidence!.unshift(historical);
    assert.equal(evaluate({ gitCwd: root, metadataRoot: root, storyId, checklist: renewed, cutoffAt, freshness }).ok, true, 'a stale historical receipt does not override a current renewal');
    const mismatch = structuredClone(checklist); mismatch.items[0]!.verificationEvidence![0]!.command = 'go test ./other';
    assert.ok(evaluate({ gitCwd: root, metadataRoot: root, storyId, checklist: mismatch, cutoffAt, freshness }).codes.includes('PR_AUTHORITY_INADMISSIBLE'));
    writeFileSync(join(root, 'fixture.go'), 'package fixture\n// material drift\n');
    git(root, ['add', 'fixture.go']);
    git(root, ['commit', '-qm', 'material drift']);
    const staleFreshness = captureVerificationFreshness(root, root);
    const stale = evaluate({ gitCwd: root, metadataRoot: root, storyId, checklist, cutoffAt, freshness: staleFreshness });
    assert.ok(stale.codes.includes('PR_EVIDENCE_STALE'), `material drift is stale: ${stale.codes.join(',')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const project = (runtimeRootModule as unknown as Record<string, unknown>).projectControllerAssetsIntoStoryWorktree;
assert.equal(typeof project, 'function', 'LAB_RED: external controller assets are not projected into the signed Story worktree');
assertOrdinaryLinkedWorktreeHasNoControllerProjectionGate();
assertExternalControllerProjection(project as ProjectControllerAssets);
assertUntrackedControllerConfigAndMasterBaseline(project as ProjectControllerAssets);
assertMissingTrackedConfigIsNotRecreated(project as ProjectControllerAssets);
assertPrimaryDevelopBeatsStaleMain();

const resolveProfile = (discoveryModule as unknown as Record<string, unknown>).resolveAcceptanceVerificationProfile;
const evaluateCommands = (preReviewModule as unknown as Record<string, unknown>).evaluateRegisteredCommandEvidence;
assert.equal(typeof resolveProfile, 'function', 'LAB_RED: pure Go has no registered command verification profile');
assert.equal(typeof evaluateCommands, 'function', 'LAB_RED: pre-review cannot validate tool-owned Go command receipts');
assertGoCommandProfile(resolveProfile as ResolveProfile, evaluateCommands as EvaluateCommands);

console.log('external-worktree-go-pre-review-smoke: PASS');
