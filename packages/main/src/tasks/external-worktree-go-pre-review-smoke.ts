#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  const cliEntry = join(process.cwd(), 'packages', 'main', 'dist', 'cli.js');
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
    assert.equal(readFileSync(controllerLeasePath, 'utf8'), controllerLeaseBytes, 'controller owner lease remains byte-identical during bootstrap');
    const projected = project({ controllerRoot, worktreeRoot, storyId });
    assert.equal(projected.storyRoot, join(realpathSync(worktreeRoot), '.proof-or-stop/story/actives', storyId));
    assert.equal(readFileSync(join(worktreeRoot, 'proof-or-stop.config.json'), 'utf8'), configBytes, 'controller config bytes are projected exactly');
    const localStore = new StoryStore(worktreeRoot);
    const checklist = localStore.readChecklist(storyId);
    assert.equal(checklist.items[0]!.status, 'in_progress');
    assert.match(git(worktreeRoot, ['show', '--name-only', '--format=', 'HEAD']), new RegExp(`^\\.proof-or-stop/story/actives/${storyId}/`, 'm'));
    assert.equal(git(controllerRoot, ['status', '--porcelain', '--', `.proof-or-stop/story/actives/${storyId}`]).startsWith('??'), true, 'controller Story copy remains read-only and uncommitted');

    rmSync(join(worktreeRoot, '.proof-or-stop'), { recursive: true, force: true });
    assert.throws(() => execFileSync(process.execPath, [cliEntry, '--root', controllerRoot, 'checklist_update', `--storyId=${storyId}`, '--itemId=CHK-001', '--status=in_progress'], {
      cwd: worktreeRoot, encoding: 'utf8', env: { ...process.env, PROOF_OR_STOP_AGENT: 'main', PROOF_OR_STOP_SESSION_ID: 'lab-owner' }, stdio: ['ignore', 'pipe', 'pipe'],
    }), /branch-local authoritative Story/, 'a committed branch-local Story cannot be repopulated from the stale controller copy');
    git(worktreeRoot, ['checkout', '--', '.proof-or-stop']);
    assert.equal(new StoryStore(worktreeRoot).readChecklist(storyId).items[0]!.status, 'in_progress', 'branch-local recovery restores the committed authority');

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

    writeFileSync(join(worktreeRoot, 'feature.txt'), 'implemented\n');
    git(worktreeRoot, ['add', 'feature.txt']);
    git(worktreeRoot, ['commit', '-qm', 'implement benchmark feature']);
    assert.equal(resolveStoryMergeBase(worktreeRoot, 'HEAD'), masterHead, 'master-only repositories resolve the real baseline without a local main alias');
    const changedFiles = readChangedFiles(worktreeRoot);
    assert.ok(changedFiles.includes('feature.txt'), `master-relative scope includes the feature commit: ${changedFiles.join(',')}`);
    assert.ok(changedFiles.includes('proof-or-stop.config.json'), 'the untracked projected config remains visible for provenance classification');
    const scope = checkScopeContract({
      storyId, mode: 'enforce', allowedModify: [], allowedCreate: ['feature.txt'], allowedTest: [], protectedFiles: [], explicitExcludes: [], acknowledgements: [],
      pathCanonicalizerVersion: SCOPE_PATH_CANONICALIZER_VERSION, pathCanonicalizationMode: 'enforce', createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
    }, changedFiles, { projectRoot: worktreeRoot, gitCwd: worktreeRoot });
    assert.equal(scope.status, 'pass', `byte-identical projected config is a control asset, not an acceptance amendment: ${JSON.stringify(scope.violations)}`);
    assert.equal(scope.rows?.find(row => row.path === 'proof-or-stop.config.json')?.rule, 'runtime_artifact');
    assert.equal(new StoryStore(worktreeRoot).readProofStoryContract(storyId), null, 'recovery does not require or synthesize a ProofStory contract');
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
    const cutoffAt = new Date(Date.now() + 1_000).toISOString();
    const pass = evaluate({ gitCwd: root, metadataRoot: root, storyId, checklist, cutoffAt, freshness });
    assert.equal(pass.ok, true, `current tool-owned go test receipt passes: ${pass.codes.join(',')}`);
    assert.equal(pass.goTestReceiptCount, 1);

    const plan = deriveAcceptanceCoverageBasis({ storyId, workspaceRoot: root, checklist, contract: null, scopeCheck: null, scopeContract: null, ...freshness, verificationProfile: 'go-command', phaseBasis: 'plan' });
    const planArtifact = { schemaVersion: 'proofstory.acceptance_basis_artifact.v1' as const, basis: plan.basis, receipt: issueAcceptanceBasisReceipt({ gitCwd: root, basis: plan.basis, topologyDigest: plan.topologyDigest }) };
    const planReceipt = verifyAcceptanceBasisReceipt({ artifact: planArtifact, gitCwd: root, metadataRoot: root, expectedStoryId: storyId, expectedTopologyDigest: plan.topologyDigest, expectedClosureFilesHash: plan.basis.binding.closureFilesHash, expectedSealDigest: plan.basis.snapshotSeal.sealDigest });
    const planGate = evaluateAcceptanceTopologyCheck({ storyId, mode: 'enforce', checklist, contract: null, ledger: null, artifact: planArtifact, receiptVerification: planReceipt, currentBasisDiagnostics: plan.diagnostics, topologyBasisDiagnostics: [] });
    assert.equal(planGate.structuralPass, true, `go-command PLAN admission is reachable in enforce mode: ${planGate.diagnostics.map(row => row.code).join(',')}`);
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
assertExternalControllerProjection(project as ProjectControllerAssets);
assertUntrackedControllerConfigAndMasterBaseline(project as ProjectControllerAssets);

const resolveProfile = (discoveryModule as unknown as Record<string, unknown>).resolveAcceptanceVerificationProfile;
const evaluateCommands = (preReviewModule as unknown as Record<string, unknown>).evaluateRegisteredCommandEvidence;
assert.equal(typeof resolveProfile, 'function', 'LAB_RED: pure Go has no registered command verification profile');
assert.equal(typeof evaluateCommands, 'function', 'LAB_RED: pre-review cannot validate tool-owned Go command receipts');
assertGoCommandProfile(resolveProfile as ResolveProfile, evaluateCommands as EvaluateCommands);

console.log('external-worktree-go-pre-review-smoke: PASS');
