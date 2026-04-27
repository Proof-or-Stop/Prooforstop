#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, lstatSync, readlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isCommandAllowed, resetConfigCache } from '../core/config.js';
import { signFinding } from '../core/finding-verify.js';
import { getGuardFailureReason } from '../core/machine.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, Finding, StoryInfo } from '../core/types.js';
import { repairGlobalKoalaLinkBeforeWorktreeDelete } from '../handlers/worktree.js';

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function makeFinding(storyId: string, agent: string, reviewRound: string, idSuffix: string): Finding {
  const id = `${storyId}:F-${idSuffix}`;
  const createdAt = `2026-04-27T12:00:${idSuffix}.000Z`;
  const desc = `${agent} clean finding`;
  const severity = 'low';
  return {
    id,
    desc,
    severity,
    category: 'happy',
    status: 'resolved',
    agent,
    createdAt,
    reviewRound,
    _hash: signFinding(storyId, id, desc, severity, createdAt, reviewRound),
  };
}

function createReviewStore(root: string): { store: StoryStore; storyId: string; reviewRound: string } {
  write(root, 'koala.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
  }));
  resetConfigCache();

  const store = new StoryStore(root);
  const storyId = 'B-smoke';
  const now = '2026-04-27T12:00:00.000Z';
  const reviewRound = '2026-04-27T12:01:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'flow-stability-smoke',
    title: 'Flow stability smoke',
    description: 'Synthetic story for REVIEW gate smoke coverage.',
    type: 'chore',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    currentReviewRound: reviewRound,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: reviewRound }],
  };
  const checklist: ChecklistData = {
    items: ['001', '002', '003'].map((suffix) => ({
      id: `CHK-${suffix}`,
      title: `Done item ${suffix}`,
      context: 'Synthetic checklist item.',
      status: 'done',
      startTime: now,
      endTime: now,
    })),
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  store.writeUnderstanding(storyId, {
    task: 'Check review gate',
    outcome: 'Review gate reports opt-in reviewers',
    facts: [],
    constraints: [],
    unknowns: [],
    touchpoints: ['packages/main/src/core/machine.ts'],
    timestamp: now,
  });
  store.writeDecision(storyId, {
    principles: ['keep gates explicit', 'reuse reviewer routing', 'avoid fixture state leakage'],
    drivers: ['normal channel smoke coverage'],
    options: [
      { name: 'A: shared reviewer routing', pros: ['matches reviewer_list'], cons: ['requires signed fixtures'] },
      { name: 'B: local copy', pros: ['simple'], cons: ['drifts from reviewer_list'] },
    ],
    chosen: 'A: shared reviewer routing',
    rationale: 'normal channel requires multiple real options in the smoke fixture',
    timestamp: now,
  });
  return { store, storyId, reviewRound };
}

function assertSessionBriefGate(): void {
  for (const phase of ['INIT', 'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE']) {
    assert.equal(isCommandAllowed('session_brief', phase), true, `session_brief should be allowed in ${phase}`);
    assert.equal(
      isCommandAllowed('session_brief', phase, { '*': [], [phase]: [] }),
      true,
      `session_brief should bypass custom phase tools in ${phase}`,
    );
  }

  assert.equal(isCommandAllowed('finding_add', 'DEV'), false, 'mutation command should remain phase-gated');
  assert.equal(
    isCommandAllowed('finding_add', 'DEV', { '*': ['status'], DEV: ['checklist_get'] }),
    false,
    'custom phase tools should still reject unrelated mutation commands',
  );
}

function assertReviewGateUsesOptIn(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-review-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    store.writeFindings(storyId, {
      findings: [
        makeFinding(storyId, 'koala-review-concept', reviewRound, '001'),
        makeFinding(storyId, 'koala-review-quality', reviewRound, '002'),
        makeFinding(storyId, 'koala-review-docs', reviewRound, '003'),
      ],
    });

    const missing = getGuardFailureReason(storyId, store, 'TEST', root);
    assert.match(missing ?? '', /期望 4 个 reviewer（opt-in: concept,quality,test-coverage,channel）/);
    assert.match(missing ?? '', /缺: test-coverage,channel/);
    assert.match(missing ?? '', /koala-review-docs/);
    assert.doesNotMatch(missing ?? '', /全部 5 个 reviewer/);

    store.writeFindings(storyId, {
      findings: [
        makeFinding(storyId, 'koala-review-concept', reviewRound, '004'),
        makeFinding(storyId, 'koala-review-quality', reviewRound, '005'),
        makeFinding(storyId, 'koala-review-test-coverage', reviewRound, '006'),
        makeFinding(storyId, 'koala-review-channel', reviewRound, '007'),
      ],
    });
    const pass = getGuardFailureReason(storyId, store, 'TEST', root);
    assert.equal(pass, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertGlobalLinkRepair(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-link-'));
  try {
    const mainRepo = join(root, 'repo');
    const worktree = join(root, 'repo', '.worktrees', 'B-smoke');
    const worktreePackage = join(worktree, 'packages', 'main');
    const mainPackage = join(mainRepo, 'packages', 'main');
    const globalPackage = join(root, 'global', 'node_modules', '@koala-agent', 'core');
    mkdirSync(worktreePackage, { recursive: true });
    mkdirSync(mainPackage, { recursive: true });
    mkdirSync(dirname(globalPackage), { recursive: true });
    symlinkSync(worktreePackage, globalPackage, process.platform === 'win32' ? 'junction' : 'dir');

    const repaired = repairGlobalKoalaLinkBeforeWorktreeDelete(worktree, mainRepo, { globalPackagePath: globalPackage });
    assert.equal(repaired.action, 'relinked');
    assert.equal(lstatSync(globalPackage).isSymbolicLink(), true);
    assert.equal(resolve(dirname(globalPackage), readlinkSync(globalPackage)), resolve(mainPackage));

    const otherPackage = join(root, 'other', 'packages', 'main');
    const otherGlobalPackage = join(root, 'other-global', 'node_modules', '@koala-agent', 'core');
    mkdirSync(otherPackage, { recursive: true });
    mkdirSync(dirname(otherGlobalPackage), { recursive: true });
    symlinkSync(otherPackage, otherGlobalPackage, process.platform === 'win32' ? 'junction' : 'dir');
    const skipped = repairGlobalKoalaLinkBeforeWorktreeDelete(worktree, mainRepo, { globalPackagePath: otherGlobalPackage });
    assert.equal(skipped.action, 'skipped');
    assert.equal(resolve(dirname(otherGlobalPackage), readlinkSync(otherGlobalPackage)), resolve(otherPackage));

    const normalInstall = join(root, 'normal-global', 'node_modules', '@koala-agent', 'core');
    mkdirSync(normalInstall, { recursive: true });
    const normalSkipped = repairGlobalKoalaLinkBeforeWorktreeDelete(worktree, mainRepo, { globalPackagePath: normalInstall });
    assert.equal(normalSkipped.action, 'skipped');
    assert.equal(existsSync(normalInstall), true);
    assert.equal(lstatSync(normalInstall).isDirectory(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

assertSessionBriefGate();
assertReviewGateUsesOptIn();
assertGlobalLinkRepair();

console.log('✓ flow stability smoke passed');
