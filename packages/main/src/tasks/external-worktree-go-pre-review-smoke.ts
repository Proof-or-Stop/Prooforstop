#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import * as runtimeRootModule from '../cli/runtime-root.js';
import * as discoveryModule from '../core/acceptance-discovery-adapters.js';
import * as preReviewModule from '../core/pre-review-check.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
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
  const controllerRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-controller-'));
  const storyId = 'B-ext-controller';
  const worktreeRoot = join(controllerRoot, '.worktrees', storyId);
  try {
    initRepository(controllerRoot);
    git(controllerRoot, ['branch', `story/${storyId}`]);
    mkdirSync(join(controllerRoot, '.worktrees'), { recursive: true });
    git(controllerRoot, ['worktree', 'add', '-q', worktreeRoot, `story/${storyId}`]);

    const configBytes = JSON.stringify({ storyDir: '.proof-or-stop/story/actives', scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures' }, null, 2);
    writeFileSync(join(controllerRoot, 'proof-or-stop.config.json'), configBytes);
    const controllerStore = new StoryStore(controllerRoot);
    controllerStore.writeStory(storyId, story(storyId, worktreeRoot));
    controllerStore.writeChecklist(storyId, { items: [{ id: 'CHK-001', title: 'projection', context: 'external controller fixture', status: 'pending', startTime: null, endTime: null }] });

    const projected = project({ controllerRoot, worktreeRoot, storyId });
    assert.equal(projected.storyRoot, join(worktreeRoot, '.proof-or-stop/story/actives', storyId));
    assert.equal(readFileSync(join(worktreeRoot, 'proof-or-stop.config.json'), 'utf8'), configBytes, 'controller config bytes are projected exactly');
    const localStore = new StoryStore(worktreeRoot);
    const checklist = localStore.readChecklist(storyId);
    checklist.items[0]!.status = 'in_progress';
    localStore.writeChecklist(storyId, checklist);
    const commitOutput = autoCommitStoryMetadata(worktreeRoot, storyId, 'lab_projection');
    assert.match(commitOutput, /metadata auto-committed/, 'Story artifact committed in linked worktree');
    assert.match(git(worktreeRoot, ['show', '--name-only', '--format=', 'HEAD']), new RegExp(`^\\.proof-or-stop/story/actives/${storyId}/`, 'm'));
    assert.equal(git(controllerRoot, ['status', '--porcelain', '--', `.proof-or-stop/story/actives/${storyId}`]).startsWith('??'), true, 'controller Story copy remains read-only and uncommitted');

    rmSync(join(worktreeRoot, 'proof-or-stop.config.json'));
    symlinkSync(join(controllerRoot, 'proof-or-stop.config.json'), join(worktreeRoot, 'proof-or-stop.config.json'));
    assert.throws(() => project({ controllerRoot, worktreeRoot, storyId }), /symlink|no-follow|unsafe/i, 'escaping config symlink is rejected');

    const nested = join(worktreeRoot, 'nested');
    mkdirSync(nested);
    initRepository(nested);
    assert.throws(() => project({ controllerRoot, worktreeRoot: nested, storyId }), /signed|linked worktree|authority/i, 'nested repository guessing is rejected');
  } finally {
    rmSync(controllerRoot, { recursive: true, force: true });
  }
}

function evidenceFixture(root: string, storyId: string): { checklist: ChecklistData; evidence: VerificationEvidence; freshness: ReturnType<typeof captureVerificationFreshness> } {
  const command = 'go test ./...';
  const selector = 'ok\tfixture';
  const freshness = captureVerificationFreshness(root, root);
  const execution = createVerificationExecutionReceipt({
    projectRoot: root,
    storyId,
    command,
    cwd: root,
    run: { code: 0, output: `${selector}\n`, timedOut: false, durationMs: 5, timeoutMs: 120_000, executable: 'go', args: ['test', './...'] },
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

    const storyId = 'B-go-command';
    const { checklist, freshness } = evidenceFixture(root, storyId);
    const cutoffAt = new Date(Date.now() + 1_000).toISOString();
    const pass = evaluate({ gitCwd: root, metadataRoot: root, storyId, checklist, cutoffAt, freshness });
    assert.equal(pass.ok, true, `current tool-owned go test receipt passes: ${pass.codes.join(',')}`);
    assert.equal(pass.goTestReceiptCount, 1);

    const missing = structuredClone(checklist); missing.items[0]!.verificationEvidence = [];
    assert.ok(evaluate({ gitCwd: root, metadataRoot: root, storyId, checklist: missing, cutoffAt, freshness }).codes.includes('PR_POSITIVE_EVIDENCE_MISSING'));
    const mismatch = structuredClone(checklist); mismatch.items[0]!.verificationEvidence![0]!.command = 'go test ./other';
    assert.ok(evaluate({ gitCwd: root, metadataRoot: root, storyId, checklist: mismatch, cutoffAt, freshness }).codes.includes('PR_AUTHORITY_INADMISSIBLE'));
    writeFileSync(join(root, 'fixture.go'), 'package fixture\n// material drift\n');
    const staleFreshness = captureVerificationFreshness(root, root);
    assert.ok(evaluate({ gitCwd: root, metadataRoot: root, storyId, checklist, cutoffAt, freshness: staleFreshness }).codes.includes('PR_EVIDENCE_STALE'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const project = (runtimeRootModule as unknown as Record<string, unknown>).projectControllerAssetsIntoStoryWorktree;
assert.equal(typeof project, 'function', 'LAB_RED: external controller assets are not projected into the signed Story worktree');
assertExternalControllerProjection(project as ProjectControllerAssets);

const resolveProfile = (discoveryModule as unknown as Record<string, unknown>).resolveAcceptanceVerificationProfile;
const evaluateCommands = (preReviewModule as unknown as Record<string, unknown>).evaluateRegisteredCommandEvidence;
assert.equal(typeof resolveProfile, 'function', 'LAB_RED: pure Go has no registered command verification profile');
assert.equal(typeof evaluateCommands, 'function', 'LAB_RED: pre-review cannot validate tool-owned Go command receipts');
assertGoCommandProfile(resolveProfile as ResolveProfile, evaluateCommands as EvaluateCommands);

console.log('external-worktree-go-pre-review-smoke: PASS');
