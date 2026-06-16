#!/usr/bin/env node
/**
 * B-e74e CHK-003 — Regression coverage for DONE main worktree preflight.
 *
 * Proves:
 *   1. DONE rejected (phase stays TEST) when main worktree is on a non-main branch.
 *   2. DONE rejected (phase stays TEST) when main worktree is dirty.
 *   3. DONE succeeds when branch main is owned by a separate registered worktree.
 *   4. done_recover succeeds from a non-main root when branch main is owned elsewhere.
 *   5. The success path is not regressed — a clean main-on-main setup still completes.
 *
 * Uses an isolated temporary git repo so no real developer checkout is touched.
 * The story worktree is linked via `git worktree add` so detectDoneStoryWorktreeContext
 * resolves correctly, then the main repo is put into the test condition AFTER the
 * worktree is linked.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import { buildDoneChecklist } from '../core/done-oracle.js';
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
import {
  upsertAuthorityGateReceiptRef,
  type AuthorityGateDecisionReceiptRef,
} from '../core/authority-gate-receipts.js';
import type { ChecklistData, ClosingSelfCheck, DocsPromise, RealMachineTest, StoryInfo } from '../core/types.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function runLatticeFromCwd(
  cwd: string,
  command: string,
  args: Record<string, unknown>,
  envOverride: Record<string, string | undefined> = {},
): string {
  const env = { ...process.env };
  delete env.LATTICE_PROJECT_ROOT;
  for (const key of Object.keys(env)) {
    if (key.startsWith('LATTICE_AUTHORITY_')) {
      delete env[key];
    }
  }
  for (const [key, value] of Object.entries(envOverride)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return execFileSync(process.execPath, [cliPath, command, JSON.stringify(args)], {
    cwd,
    env,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runLatticeFromCwdExpectFail(cwd: string, command: string, args: Record<string, unknown>): string {
  try {
    runLatticeFromCwd(cwd, command, args);
  } catch (e: any) {
    return [
      e?.stdout?.toString?.() ?? '',
      e?.stderr?.toString?.() ?? '',
      e?.message ?? '',
    ].join('\n');
  }
  assert.fail(`${command} should have failed`);
}

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

function gitStatus(root: string): string {
  return execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function evidenceFreshnessRow(store: StoryStore, root: string, storyId: string) {
  const row = buildDoneChecklist(storyId, store, root, { auditWriter: null })
    .find((candidate) => candidate.id === 'evidence-freshness');
  assert.ok(row, 'DONE checklist must include evidence-freshness row');
  return row;
}

function writeDoneGateEvidence(store: StoryStore, root: string, storyId: string): void {
  const now = '2026-06-04T10:00:00.000Z';
  store.writeTestEvidence(storyId, {
    command: 'done-preflight-smoke',
    output: JSON.stringify({ allPass: true, summary: 'done preflight smoke passed' }),
    result: 'PASS',
    timestamp: now,
    headHash: currentGitHead(root),
    materialHash: currentMaterialHash(root),
    verificationCoverage: {
      total: 0,
      required: 0,
      covered: 0,
      missingRequired: 0,
      entries: [],
    },
  });

  const docsPromises: DocsPromise[] = [];
  const realMachineTests: RealMachineTest[] = [{
    featureId: 'CHK-001',
    transcript: 'DONE preflight smoke: main worktree branch and cleanliness checks verified.',
  }];
  const closingSelfCheck: ClosingSelfCheck = {
    hasRealMachineTest: true,
    hasEdgeCaseCoverage: true,
    hasUnresolvedTodos: false,
    summary: 'DONE preflight main worktree readiness checks verified.',
  };
  store.writeDeliveryCheck(storyId, {
    storyId,
    checkedAt: now,
    reviewRound: '',
    agentId: 'lattice-review-delivery',
    docsPromises,
    realMachineTests,
    closingSelfCheck,
    _hash: signDeliveryCheck(storyId, docsPromises, realMachineTests, closingSelfCheck, ''),
  });
}

function writePassingTestEvidence(store: StoryStore, root: string, storyId: string): void {
  store.writeTestEvidence(storyId, {
    command: 'done_closure read-only smoke',
    output: JSON.stringify({ allPass: true, summary: 'done_closure read-only smoke passed' }),
    result: 'PASS',
    timestamp: '2026-06-04T10:00:00.000Z',
    headHash: currentGitHead(root),
    materialHash: currentMaterialHash(root),
    verificationCoverage: {
      total: 0,
      required: 0,
      covered: 0,
      missingRequired: 0,
      entries: [],
    },
  });
}

function authorityDoneRefFor(root: string, storyId: string): AuthorityGateDecisionReceiptRef {
  const headHash = currentGitHead(root);
  const materialHash = currentMaterialHash(root);
  assert.ok(headHash, 'smoke repo must have git HEAD');
  assert.ok(materialHash, 'smoke repo must have material hash');
  return {
    receiptId: 'AR-DONE-CLOSURE',
    receiptKind: 'gate_decision',
    classification: 'production-gate-decision',
    authorityUrl: 'https://authority.example',
    authorityKeyId: 'server-key-1',
    authorityPublicKeyDigest: 'sha256:key',
    decisionId: 'GD-DONE-CLOSURE',
    stateVersion: 7,
    gateInputDigest: 'sha256:input',
    decisionDigest: 'sha256:decision',
    decisionVerdict: 'pass',
    storyId,
    targetPhase: 'DONE',
    headHash,
    materialHash,
    policyMode: 'light',
    authorityMode: 'enforce',
    producerRunIds: ['run-producer-1'],
    verifierRunIds: ['run-verifier-1'],
    runnerSessionIds: ['session-1'],
    evidenceDigests: ['sha256:evidence-1'],
    verifiedAt: new Date().toISOString(),
    verifiedBy: 'lattice authority receipt verify',
    eligibleGates: ['DONE'],
    status: 'active',
    consumptionEvents: [],
  };
}

/**
 * Build a minimal TEST-phase story with a linked worktree and DONE-gate
 * evidence committed on the story branch. Main stays on branch main throughout
 * this helper — callers mutate it afterwards to create the test condition.
 */
function buildDoneReadyStoryWithLinkedWorktree(
  root: string,
  storyId: string,
  workflowProfile: 'light' | 'balanced' = 'light',
  writeClosureEvidence = true,
): { worktreePath: string; store: StoryStore } {
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
    workflow: { profile: workflowProfile },
  }, null, 2));
  write(root, 'README.md', `done-preflight-smoke ${storyId}\n`);
  write(root, '.gitignore', '.worktrees/\n.linked-worktrees/\n.lattice/activity.jsonl\n');

  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Lattice Smoke', 'commit', '-m', 'base']);
  resetConfigCache();

  const now = '2026-06-04T10:00:00.000Z';
  const worktreePath = join(root, '.worktrees', storyId);
  const store = new StoryStore(root);

  const story: StoryInfo = {
    storyId,
    name: 'done-preflight-smoke',
    title: `Done preflight smoke ${storyId}`,
    description: 'Synthetic story for DONE preflight smoke.',
    type: 'chore',
    phase: 'TEST',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    worktree: {
      path: `.worktrees/${storyId}`,
      branch: `story/${storyId}`,
      createdAt: now,
    },
    events: [{ phase: 'TEST' as StoryInfo['phase'], action: 'advance', timestamp: now }],
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic item',
      context: 'Synthetic context',
      status: 'pending',
      startTime: null,
      endTime: null,
    }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);

  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Lattice Smoke', 'commit', '-m', 'story metadata']);
  git(root, ['branch', `story/${storyId}`]);
  git(root, ['worktree', 'add', worktreePath, `story/${storyId}`]);

  resetConfigCache();
  const worktreeStore = new StoryStore(worktreePath);
  if (writeClosureEvidence) {
    writeDoneGateEvidence(worktreeStore, worktreePath, storyId);
    git(worktreePath, ['add', '.']);
    git(worktreePath, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Lattice Smoke', 'commit', '-m', 'done gate evidence']);
  }

  return { worktreePath, store };
}

function buildTestPassedStoryMissingClosureArtifacts(root: string, storyId: string): { worktreePath: string } {
  const { worktreePath } = buildDoneReadyStoryWithLinkedWorktree(root, storyId, 'balanced', false);
  const worktreeStore = new StoryStore(worktreePath);
  writePassingTestEvidence(worktreeStore, worktreePath, storyId);
  git(worktreePath, ['add', '.']);
  git(worktreePath, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Lattice Smoke', 'commit', '-m', 'test evidence only']);
  return { worktreePath };
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

/**
 * DONE main worktree preflight smoke: PASS
 *
 * When the main worktree is on "main" and clean, DONE completes normally.
 * Regression guard — the new preflight must not break the happy path.
 */
function assertDoneSucceedsWhenMainIsCleanAndOnMain(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-preflight-happy-'));
  try {
    const storyId = 'B-preflight-happy';
    const { worktreePath } = buildDoneReadyStoryWithLinkedWorktree(root, storyId);

    const output = runLatticeFromCwd(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
    assert.ok(output.includes(`Story ${storyId} advanced to DONE`), `DONE success expected, got:\n${output}`);
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'DONE', 'story must be DONE on happy path');
    assert.equal(existsSync(worktreePath), false, 'worktree directory must be removed on happy path');
    assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '', 'story branch must be deleted on happy path');
    console.log('  ✓ DONE main worktree preflight smoke: PASS — happy path not regressed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * DONE main worktree preflight smoke: PASS — main branch registered elsewhere.
 *
 * When the repository's primary worktree is not on branch main but branch main
 * is checked out in another registered worktree, DONE must use that registered
 * main worktree as the merge target.
 */
function assertDoneSucceedsWhenMainBranchOwnedBySeparateWorktree(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-preflight-main-holder-'));
  try {
    const storyId = 'B-preflight-main-holder';
    const { worktreePath } = buildDoneReadyStoryWithLinkedWorktree(root, storyId);
    const mainWorktreePath = join(root, '.linked-worktrees', 'main');

    git(root, ['checkout', '-b', 'root-side-branch']);
    git(root, ['worktree', 'add', mainWorktreePath, 'main']);

    const output = runLatticeFromCwd(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
    assert.ok(output.includes(`Story ${storyId} advanced to DONE`), `DONE success expected, got:\n${output}`);
    assert.equal(new StoryStore(mainWorktreePath).readStory(storyId).phase, 'DONE', 'story must be DONE on registered main worktree');
    assert.equal(git(mainWorktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'registered main worktree must remain on main');
    assert.equal(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), 'root-side-branch', 'primary worktree branch must not be switched');
    assert.equal(existsSync(worktreePath), false, 'story worktree directory must be removed');
    assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '', 'story branch must be deleted');
    console.log('  ✓ DONE main worktree preflight smoke: PASS — separate registered main worktree');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function markStoryBranchAsPartialDone(worktreePath: string, storyId: string): void {
  const store = new StoryStore(worktreePath);
  const story = store.readStory(storyId);
  story.phase = 'DONE';
  story.worktree = undefined;
  story.endedAt = story.endedAt || '2026-06-04T10:30:00.000Z';
  store.writeStory(storyId, story);
  git(worktreePath, ['add', store.storyDirRel()]);
  git(worktreePath, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Lattice Smoke', 'commit', '-m', 'partial done state']);
}

/**
 * done_recover smoke: PASS — main branch registered elsewhere.
 *
 * Partial-DONE recovery must use the registered worktree that owns branch main,
 * even when the repository root used to invoke done_recover is on another branch.
 */
function assertDoneRecoverUsesSeparateRegisteredMainWorktree(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-recover-main-holder-'));
  try {
    const storyId = 'B-recover-main-holder';
    const { worktreePath } = buildDoneReadyStoryWithLinkedWorktree(root, storyId);
    const mainWorktreePath = join(root, '.linked-worktrees', 'main');

    markStoryBranchAsPartialDone(worktreePath, storyId);
    git(root, ['checkout', '-b', 'root-side-branch']);
    git(root, ['worktree', 'add', mainWorktreePath, 'main']);

    const output = runLatticeFromCwd(root, 'done_recover', { storyId });
    assert.ok(output.includes(`partial-DONE recovered: ${storyId}`), `done_recover success expected, got:\n${output}`);
    assert.equal(new StoryStore(mainWorktreePath).readStory(storyId).phase, 'DONE', 'recovered story must be DONE on registered main worktree');
    assert.equal(git(mainWorktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'registered main worktree must remain on main');
    assert.equal(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), 'root-side-branch', 'primary worktree branch must not be switched by done_recover');
    assert.equal(existsSync(worktreePath), false, 'story worktree directory must be removed by done_recover');
    assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '', 'story branch must be deleted by done_recover');
    console.log('  ✓ done_recover smoke: PASS — separate registered main worktree');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * phase remains TEST after failed preflight — main on wrong branch.
 *
 * When the main worktree is on a branch other than "main", DONE must be
 * rejected BEFORE writing phase=DONE; the story stays TEST, the worktree
 * survives, and the error message names the actual main worktree path.
 */
function assertDoneRejectsWhenMainOnWrongBranch(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-preflight-wrong-branch-'));
  try {
    const storyId = 'B-preflight-wrong-branch';
    const { worktreePath } = buildDoneReadyStoryWithLinkedWorktree(root, storyId);

    // Switch the main repo to a non-main branch AFTER the story worktree is linked.
    // Git allows this because the worktree holds the story branch, not main.
    git(root, ['checkout', '-b', 'some-other-branch']);

    const output = runLatticeFromCwdExpectFail(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
    assert.match(output, /Cannot enter DONE/, 'preflight failure must say "Cannot enter DONE"');
    assert.match(output, /some-other-branch/, 'error must name the offending branch');
    assert.match(output, new RegExp(resolve(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'error must name the actual main worktree path');
    assert.match(output, /git checkout main/, 'error must suggest git checkout main');
    assert.match(output, /phase was not changed/, 'error must confirm phase was not changed');

    // phase=DONE must NEVER be written — story stays TEST in both stores.
    assert.equal(new StoryStore(worktreePath).readStory(storyId).phase, 'TEST', 'wrong-branch preflight must leave worktree story TEST');
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'TEST', 'wrong-branch preflight must leave main story TEST');

    // Worktree and branch intact — nothing was cleaned up.
    assert.equal(existsSync(worktreePath), true, 'worktree directory must survive a preflight failure');
    assert.notEqual(git(root, ['branch', '--list', `story/${storyId}`]), '', 'story branch must survive a preflight failure');
    console.log('  ✓ phase remains TEST after failed preflight (main on wrong branch)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * phase remains TEST after failed preflight — main worktree dirty.
 *
 * When the main worktree has uncommitted changes, DONE must be rejected
 * BEFORE writing phase=DONE; the story stays TEST and the error message
 * names the actual main worktree path and provides cd guidance.
 */
function assertDoneRejectsWhenMainIsDirty(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-preflight-dirty-main-'));
  try {
    const storyId = 'B-preflight-dirty-main';
    const { worktreePath } = buildDoneReadyStoryWithLinkedWorktree(root, storyId);

    // Dirty the main checkout with a staged tracked modification AFTER worktree
    // creation. Must be a tracked-file change (not untracked) — untracked files
    // in the main repo are skipped by the preflight (runtime artifacts like
    // .lattice/locks/ would otherwise trigger a false positive).
    writeFileSync(join(root, 'README.md'), 'dirty main content that must block DONE\n');
    git(root, ['add', 'README.md']);
    // Verify main is actually dirty (tracked changes).
    assert.notEqual(
      git(root, ['status', '--porcelain', '--untracked-files=no']).trim(),
      '',
      'pre-condition: main must have staged tracked changes',
    );

    const output = runLatticeFromCwdExpectFail(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
    assert.match(output, /Cannot enter DONE/, 'dirty main preflight failure must say "Cannot enter DONE"');
    assert.match(output, /uncommitted changes to tracked files/, 'error must mention uncommitted changes to tracked files');
    assert.match(output, new RegExp(resolve(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'error must name the actual main worktree path');
    assert.match(output, /phase was not changed/, 'error must confirm phase was not changed');

    // phase=DONE must NEVER be written.
    assert.equal(new StoryStore(worktreePath).readStory(storyId).phase, 'TEST', 'dirty main preflight must leave worktree story TEST');
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'TEST', 'dirty main preflight must leave main story TEST');

    // Worktree intact.
    assert.equal(existsSync(worktreePath), true, 'worktree directory must survive a dirty-main preflight failure');
    assert.notEqual(git(root, ['branch', '--list', `story/${storyId}`]), '', 'story branch must survive a dirty-main preflight failure');
    console.log('  ✓ phase remains TEST after failed preflight (main worktree dirty)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertCompletedDoneEvidenceFreshnessUsesRecordedSnapshot(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-evidence-snapshot-'));
  try {
    const storyId = 'B-done-evidence-snapshot';
    const { worktreePath } = buildDoneReadyStoryWithLinkedWorktree(root, storyId);

    const output = runLatticeFromCwd(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
    assert.ok(output.includes(`Story ${storyId} advanced to DONE`), `DONE success expected, got:\n${output}`);

    write(root, 'packages/main/src/unrelated-after-done.ts', 'export const unrelatedAfterDone = true;\n');
    git(root, ['add', 'packages/main/src/unrelated-after-done.ts']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Lattice Smoke', 'commit', '-m', 'unrelated material after done']);

    const store = new StoryStore(root);
    const story = store.readStory(storyId);
    const evidence = store.readTestEvidence(storyId);
    assert.equal(story.phase, 'DONE', 'pre-condition: story must already be DONE');
    assert.ok(evidence?.headHash, 'pre-condition: test evidence must record headHash');
    assert.ok(evidence.materialHash, 'pre-condition: test evidence must record materialHash');
    assert.notEqual(
      currentMaterialHash(root),
      evidence.materialHash,
      'pre-condition: later material commit must differ from recorded evidence materialHash',
    );

    const row = evidenceFreshnessRow(store, root, storyId);
    assert.equal(row.status, 'pass', `DONE evidence snapshot must remain fresh after later material commit: ${row.detail}`);
    assert.match(row.detail ?? '', /recorded evidence snapshot/, 'row detail must explain historical snapshot validation');

    store.writeTestEvidence(storyId, { ...evidence, headHash: 'missing-evidence-head' });
    const missingHeadRow = evidenceFreshnessRow(store, root, storyId);
    assert.equal(missingHeadRow.status, 'fail', 'DONE evidence freshness must fail closed when recorded head is unavailable');
    assert.match(missingHeadRow.detail ?? '', /cannot be inspected/, 'missing-head failure must explain snapshot inspection failure');

    store.writeTestEvidence(storyId, { ...evidence, materialHash: '0'.repeat(64) });
    const mismatchRow = evidenceFreshnessRow(store, root, storyId);
    assert.equal(mismatchRow.status, 'fail', 'DONE evidence freshness must fail closed when recorded materialHash mismatches');
    assert.match(mismatchRow.detail ?? '', /does not match material tree/, 'mismatch failure must explain snapshot hash mismatch');

    console.log('  ✓ DONE evidence freshness: PASS — completed story uses recorded snapshot after later material commit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertActiveTestEvidenceFreshnessStillUsesCurrentMaterialHash(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-active-evidence-stale-'));
  try {
    const storyId = 'B-active-evidence-stale';
    const { worktreePath } = buildDoneReadyStoryWithLinkedWorktree(root, storyId);
    const store = new StoryStore(worktreePath);
    const evidence = store.readTestEvidence(storyId);
    assert.ok(evidence?.materialHash, 'pre-condition: test evidence must record materialHash');

    write(worktreePath, 'packages/main/src/unrelated-active.ts', 'export const unrelatedActive = true;\n');
    git(worktreePath, ['add', 'packages/main/src/unrelated-active.ts']);
    git(worktreePath, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Lattice Smoke', 'commit', '-m', 'unrelated material during test']);
    assert.equal(store.readStory(storyId).phase, 'TEST', 'pre-condition: story must remain active TEST');
    assert.notEqual(
      currentMaterialHash(worktreePath),
      evidence.materialHash,
      'pre-condition: later material commit must differ from recorded evidence materialHash',
    );

    const row = evidenceFreshnessRow(store, worktreePath, storyId);
    assert.equal(row.status, 'fail', 'active TEST evidence must still go stale after later material commit');
    assert.match(row.detail ?? '', /current entity file state/, 'active TEST row must still compare against current material state');
    console.log('  ✓ active TEST evidence freshness: PASS — later material commit still fails freshness');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertDoneClosureIsReadOnlyAndNonAuthority(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-closure-readonly-'));
  try {
    const storyId = 'B-done-closure-readonly';
    const { worktreePath } = buildTestPassedStoryMissingClosureArtifacts(root, storyId);
    const processEventsPath = join(worktreePath, '.lattice', 'story', 'actives', storyId, 'process-events.jsonl');

    // This allowed story-metadata dirt used to be the risky path: the DONE
    // oracle's default dirty gate writer can append process-events for
    // non-blocking dirty categories. done_closure must project the same oracle
    // rows with an explicit no-write audit option.
    write(worktreePath, `.lattice/story/actives/${storyId}/readonly-dirty.json`, '{}\n');
    const beforeStatus = gitStatus(worktreePath);
    const beforeProcessEvents = readIfExists(processEventsPath);

    const raw = runLatticeFromCwd(worktreePath, 'done_closure', { storyId, json: true });
    const result = JSON.parse(raw) as {
      schemaVersion: string;
      readOnly: boolean;
      canAttemptDone: boolean;
      blockers: Array<{ id: string; status: string }>;
      localNonAuthorityAudit: { status: string };
      authorityServerPath: { receiptVerified: boolean; mayClaimAuthorityDone: boolean; receiptRefs: string[] };
    };
    const byId = new Map(result.blockers.map((row) => [row.id, row]));

    assert.equal(result.schemaVersion, 'lattice.done_closure.v1');
    assert.equal(result.readOnly, true);
    assert.equal(result.canAttemptDone, false, 'TEST PASS is not DONE-ready while closure rows still block');
    assert.equal(byId.get('test-evidence')?.status, 'pass');
    assert.equal(byId.get('delivery-check')?.status, 'fail', 'missing delivery-check must remain a DONE blocker');
    assert.equal(byId.get('story-summary')?.status, 'fail', 'missing summary must remain a DONE blocker');
    assert.equal(result.localNonAuthorityAudit.status, 'blocked');
    assert.equal(result.authorityServerPath.receiptVerified, false);
    assert.equal(result.authorityServerPath.mayClaimAuthorityDone, false);
    assert.deepEqual(result.authorityServerPath.receiptRefs, []);
    assert.equal(JSON.stringify(result).includes('"authorityDone":true'), false);
    assert.equal(JSON.stringify(result).includes('"productionDone":true'), false);
    assert.equal(JSON.stringify(result).includes('"fullAuthorityDone":true'), false);

    assert.equal(readIfExists(processEventsPath), beforeProcessEvents, 'done_closure must not append process-events');
    assert.equal(gitStatus(worktreePath), beforeStatus, 'done_closure must leave git status byte-identical');
    console.log('  ✓ done_closure smoke: PASS — read-only projection and non-Authority defaults');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertDoneClosureAuthorityEnforceWithoutReceiptBlocksReadiness(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-closure-authority-missing-'));
  try {
    const storyId = 'B-done-closure-authority-missing';
    const { worktreePath } = buildDoneReadyStoryWithLinkedWorktree(root, storyId);
    const processEventsPath = join(worktreePath, '.lattice', 'story', 'actives', storyId, 'process-events.jsonl');
    const beforeStatus = gitStatus(worktreePath);
    const beforeProcessEvents = readIfExists(processEventsPath);

    const raw = runLatticeFromCwd(worktreePath, 'done_closure', { storyId, json: true }, {
      LATTICE_AUTHORITY_MODE: 'enforce',
    });
    const result = JSON.parse(raw) as {
      readOnly: boolean;
      canAttemptDone: boolean;
      blockers: Array<{ id: string; status: string; blocking: boolean }>;
      localNonAuthorityAudit: { status: string };
      authorityServerPath: {
        required: boolean;
        receiptVerified: boolean;
        mayClaimAuthorityDone: boolean;
        receiptRefs: string[];
      };
    };

    assert.equal(result.readOnly, true);
    assert.equal(
      result.blockers.filter((row) => row.blocking && row.status === 'fail').length,
      0,
      'pre-condition: local DONE oracle rows must be clear',
    );
    assert.equal(result.localNonAuthorityAudit.status, 'passed');
    assert.equal(result.authorityServerPath.required, true);
    assert.equal(result.authorityServerPath.receiptVerified, false);
    assert.equal(result.authorityServerPath.mayClaimAuthorityDone, false);
    assert.deepEqual(result.authorityServerPath.receiptRefs, []);
    assert.equal(result.canAttemptDone, false, 'Authority enforce without verified DONE receipt blocks attempt readiness');
    assert.equal(readIfExists(processEventsPath), beforeProcessEvents, 'done_closure must not append process-events');
    assert.equal(gitStatus(worktreePath), beforeStatus, 'done_closure must leave git status byte-identical');
    console.log('  ✓ done_closure authority enforce: missing receipt blocks canAttemptDone');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertDoneClosureAuthorityEnforceEligibleReceiptReportsVerifiedReadOnly(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-closure-authority-verified-'));
  try {
    const storyId = 'B-done-closure-authority-verified';
    const { worktreePath } = buildDoneReadyStoryWithLinkedWorktree(root, storyId);
    const store = new StoryStore(worktreePath);
    const ref = authorityDoneRefFor(worktreePath, storyId);
    store.writeAuthorityReceiptRefs(storyId, upsertAuthorityGateReceiptRef(undefined, ref, ref.verifiedAt!));

    const processEventsPath = join(worktreePath, '.lattice', 'story', 'actives', storyId, 'process-events.jsonl');
    const beforeStatus = gitStatus(worktreePath);
    const beforeProcessEvents = readIfExists(processEventsPath);

    const raw = runLatticeFromCwd(worktreePath, 'done_closure', { storyId, json: true }, {
      LATTICE_AUTHORITY_MODE: 'enforce',
    });
    const result = JSON.parse(raw) as {
      readOnly: boolean;
      canAttemptDone: boolean;
      blockers: Array<{ id: string; status: string; blocking: boolean }>;
      localNonAuthorityAudit: { status: string };
      authorityServerPath: {
        required: boolean;
        receiptVerified: boolean;
        mayClaimAuthorityDone: boolean;
        receiptRefs: string[];
      };
    };

    assert.equal(result.readOnly, true);
    assert.equal(
      result.blockers.filter((row) => row.blocking && row.status === 'fail').length,
      0,
      'pre-condition: local DONE oracle rows must be clear',
    );
    assert.equal(result.localNonAuthorityAudit.status, 'passed');
    assert.equal(result.authorityServerPath.required, true);
    assert.equal(
      result.authorityServerPath.receiptVerified,
      true,
      'eligible production gate_decision ref is reported as verified',
    );
    assert.deepEqual(result.authorityServerPath.receiptRefs, ['AR-DONE-CLOSURE']);
    assert.equal(result.authorityServerPath.mayClaimAuthorityDone, false, 'read-only projection must not claim Authority DONE');
    assert.equal(result.canAttemptDone, true, 'eligible Authority receipt clears the Authority readiness blocker');
    assert.equal(readIfExists(processEventsPath), beforeProcessEvents, 'done_closure must not append process-events');
    assert.equal(gitStatus(worktreePath), beforeStatus, 'done_closure must leave git status byte-identical');
    console.log('  ✓ done_closure authority enforce: eligible receipt is verified without writes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

assertDoneSucceedsWhenMainIsCleanAndOnMain();
assertDoneSucceedsWhenMainBranchOwnedBySeparateWorktree();
assertDoneRecoverUsesSeparateRegisteredMainWorktree();
assertDoneRejectsWhenMainOnWrongBranch();
assertDoneRejectsWhenMainIsDirty();
assertCompletedDoneEvidenceFreshnessUsesRecordedSnapshot();
assertActiveTestEvidenceFreshnessStillUsesCurrentMaterialHash();
assertDoneClosureIsReadOnlyAndNonAuthority();
assertDoneClosureAuthorityEnforceWithoutReceiptBlocksReadiness();
assertDoneClosureAuthorityEnforceEligibleReceiptReportsVerifiedReadOnly();

console.log('✓ done-preflight-smoke passed');
