#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  enforceReviewerReadOnlyCommandGate,
  enforceStoryOwnerLeaseGate,
  MAIN_TOOLS,
  resolveEffectiveOwnershipClass,
  REVIEWER_READONLY_ENV,
} from '../cli-engine.js';
import { getCommandPolicy } from '../core/command-policy.js';
import { DEFAULT_PHASE_TOOLS, isCommandAllowed, resetConfigCache } from '../core/config.js';
import { buildScopeBoundary } from '../core/scope-anti-expansion.js';
import { StoryStore } from '../core/store.js';
import type { StoryInfo } from '../core/types.js';
import { buildStoryReadinessReport } from '../core/lifecycle-readiness.js';
import { createMainRegistry } from '../registry.js';
import type { HandlerContext } from '../handlers/context.js';
import type { PlanSkeletonReport } from '../handlers/plan-skeleton.js';
import { acquireOwnerLease, ownerLeasePath, resetSessionIdForTest } from '../core/story-owner-lease.js';

const STORY_ID = 'B-plan';
const NOW = '2026-06-20T00:00:00.000Z';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'plan-skeleton-smoke',
      GIT_AUTHOR_EMAIL: 'plan-skeleton-smoke@example.com',
      GIT_COMMITTER_NAME: 'plan-skeleton-smoke',
      GIT_COMMITTER_EMAIL: 'plan-skeleton-smoke@example.com',
    },
  }).trim();
}

function gitStatus(root: string): string {
  return git(root, ['status', '--short']);
}

function writeConfig(root: string): void {
  writeFileSync(
    join(root, 'lattice.config.json'),
    JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'balanced' },
    }, null, 2) + '\n',
    'utf8',
  );
  resetConfigCache();
}

function createFixture(): { root: string; store: StoryStore; ctx: HandlerContext } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-plan-skeleton-'));
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeConfig(root);
  writeFileSync(join(root, 'README.md'), '# plan skeleton smoke\n', 'utf8');
  writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const value = 1;\n', 'utf8');
  git(root, ['init']);
  git(root, ['checkout', '-b', 'main']);
  git(root, ['add', 'README.md', 'lattice.config.json', 'packages/main/src/index.ts']);
  git(root, ['commit', '-m', 'base']);

  const store = new StoryStore(root);
  const story: StoryInfo = {
    storyId: STORY_ID,
    name: 'plan-skeleton-smoke',
    title: 'Implement plan_skeleton',
    description: [
      'Implement lattice plan_skeleton from packages/main/src/handlers/plan-skeleton.ts.',
      'Default output previews a PLAN skeleton.',
      '--write persists only through understanding_set and checklist_add.',
    ].join(' '),
    type: 'feature',
    phase: 'PLAN',
    priority: 'high',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
  };
  store.writeStory(STORY_ID, story);
  store.writeChecklist(STORY_ID, {
    items: [{
      id: 'CHK-001',
      title: 'Existing pending planning item',
      context: 'Synthetic existing item keeps StoryReadinessReport non-empty.',
      status: 'pending',
      startTime: null,
      endTime: null,
      verificationIntent: {
        happy: [{ desc: 'existing intent lacks evidence', type: 'logic', priority: 'must' }],
        edge: [],
        adversarial: [],
      },
    }],
  });
  store.writeScopeBoundary(STORY_ID, buildScopeBoundary({
    storyId: STORY_ID,
    mode: 'feature',
    allowed: ['plan skeleton smoke coverage'],
    excluded: ['out of scope release readiness'],
    confirmedBy: 'plan-skeleton-smoke',
    confirmationNote: 'Synthetic user-confirmed boundary for checklist_add coverage.',
    now: NOW,
  }));
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  return { root, store, ctx };
}

function snapshotDir(root: string, dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  function walk(abs: string): void {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const path = join(abs, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        out[relative(root, path)] = readFileSync(path, 'utf8');
      }
    }
  }
  walk(dir);
  return out;
}

function changedPaths(before: Record<string, string>, after: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => before[key] !== after[key]).sort();
}

function reportCodes(report: PlanSkeletonReport): Set<string> {
  return new Set(report.readinessReport.readiness.map((row) => row.code));
}

function assertReportShape(report: PlanSkeletonReport): void {
  assert.equal(report.storyId, STORY_ID);
  assert.equal(report.phase, 'PLAN');
  assert.equal(report.mode.runCommands, false);
  assert.equal(report.mode.writeEvidence, false);
  assert.equal(report.readinessReport.storyId, STORY_ID);
  assert.equal(report.readinessReport.target, 'REVIEW');
  assert.equal(report.readinessReport.mode.runCommands, false);
  assert.equal(report.readinessReport.mode.writeEvidence, false);
  assert.equal(report.claims.authorityDone, false);
  assert.equal(report.claims.fullAuthorityDone, false);
  assert.equal(report.claims.productionDone, false);
  assert.ok(report.skeleton.understanding.task.includes('Implement plan_skeleton'));
  assert.ok(report.skeleton.understanding.facts.some((fact) => fact.includes('StoryReadinessReport target REVIEW')));
  assert.ok(report.skeleton.checklist.length >= 2);
}

function assertNoAuthorityOrEvidenceArtifacts(store: StoryStore): void {
  for (const artifact of [
    'test-evidence.json',
    'review-runs.json',
    'review-passes.json',
    'findings.json',
    'delivery-check.json',
    'summary.json',
    'done-required-evidence.json',
    'authority-receipt-refs.json',
  ]) {
    assert.equal(existsSync(store.storyFilePath(STORY_ID, artifact)), false, `${artifact} must not be written`);
  }
}

assert.ok(MAIN_TOOLS.some((tool) => tool.name === 'plan_skeleton'), 'MAIN_TOOLS exposes plan_skeleton');
const policy = getCommandPolicy('plan_skeleton');
assert.equal(policy?.ownershipClass, 'readOnly', 'plan_skeleton policy is readOnly');
assert.equal(policy?.destructiveRisk, 'none', 'plan_skeleton policy has no destructive risk');
assert.equal(isCommandAllowed('plan_skeleton', 'INIT', DEFAULT_PHASE_TOOLS), true, 'plan_skeleton is available in INIT');
assert.equal(isCommandAllowed('plan_skeleton', 'PLAN', DEFAULT_PHASE_TOOLS), true, 'plan_skeleton is available in PLAN');
assert.equal(
  resolveEffectiveOwnershipClass('plan_skeleton', { storyId: STORY_ID }, STORY_ID),
  'readOnly',
  'plan_skeleton preview remains effectively readOnly',
);
assert.equal(
  resolveEffectiveOwnershipClass('plan_skeleton', { storyId: STORY_ID, write: true }, STORY_ID),
  'storyScopedMutating',
  'plan_skeleton --write is effectively storyScopedMutating',
);
assert.equal(
  resolveEffectiveOwnershipClass('plan_skeleton', { storyId: STORY_ID, write: 'true' }, STORY_ID),
  'storyScopedMutating',
  'plan_skeleton --write string truth is still owner-gated before schema-normalized callers',
);

{
  const savedRO = process.env[REVIEWER_READONLY_ENV];
  try {
    process.env[REVIEWER_READONLY_ENV] = '1';
    assert.doesNotThrow(
      () => enforceReviewerReadOnlyCommandGate('plan_skeleton', { storyId: STORY_ID }, null),
      'read-only reviewer mode allows plan_skeleton preview',
    );
    assert.throws(
      () => enforceReviewerReadOnlyCommandGate('plan_skeleton', { storyId: STORY_ID, write: true }, null),
      /plan_skeleton.*storyScopedMutating/,
      'read-only reviewer mode blocks plan_skeleton --write',
    );
  } finally {
    if (savedRO === undefined) delete process.env[REVIEWER_READONLY_ENV];
    else process.env[REVIEWER_READONLY_ENV] = savedRO;
  }
}

{
  const { root, store } = createFixture();
  const savedSession = process.env.LATTICE_SESSION_ID;
  try {
    const storyDir = store.storyDirPath(STORY_ID);
    process.env.LATTICE_SESSION_ID = 'sess-owner';
    resetSessionIdForTest();
    acquireOwnerLease(storyDir, { command: 'checklist_add', cwd: '/tmp/owner-worktree' });
    const leaseBefore = readFileSync(ownerLeasePath(storyDir), 'utf8');
    const checklistBefore = store.readChecklist(STORY_ID);
    const understandingBefore = store.readUnderstanding(STORY_ID);

    process.env.LATTICE_SESSION_ID = 'sess-intruder';
    resetSessionIdForTest();
    assert.doesNotThrow(
      () => enforceStoryOwnerLeaseGate('plan_skeleton', { storyId: STORY_ID }, store, null, root),
      'plan_skeleton preview is not owner-gated on a foreign-owned story',
    );
    assert.throws(
      () => enforceStoryOwnerLeaseGate('plan_skeleton', { storyId: STORY_ID, write: true }, store, null, root),
      /owner-gated/,
      'plan_skeleton --write is owner-gated on a foreign-owned story',
    );
    assert.equal(readFileSync(ownerLeasePath(storyDir), 'utf8'), leaseBefore, 'rejected --write leaves the foreign owner lease untouched');
    assert.deepEqual(store.readChecklist(STORY_ID), checklistBefore, 'rejected owner gate leaves checklist unchanged');
    assert.deepEqual(store.readUnderstanding(STORY_ID), understandingBefore, 'rejected owner gate leaves understanding unchanged');
  } finally {
    if (savedSession === undefined) delete process.env.LATTICE_SESSION_ID;
    else process.env.LATTICE_SESSION_ID = savedSession;
    resetSessionIdForTest();
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const { root, store, ctx } = createFixture();
  try {
    const registry = createMainRegistry(ctx);
    const handler = registry.get('plan_skeleton');
    assert.ok(handler, 'registry exposes plan_skeleton');

    const storyDir = store.storyDirPath(STORY_ID);
    const beforeSnapshot = snapshotDir(root, storyDir);
    const beforeStatus = gitStatus(root);
    const text = handler!({ storyId: STORY_ID, format: 'text' }) as string;
    assert.match(text, /Plan skeleton \(B-plan\)/);
    assert.match(text, /mode: read-only preview/);
    assert.match(text, /readinessReport: target=REVIEW/);
    assert.match(text, /authorityDone: false/);

    const jsonReport = handler!({ storyId: STORY_ID, json: true }) as PlanSkeletonReport;
    assertReportShape(jsonReport);
    assert.equal(jsonReport.write.requested, false);
    assert.equal(jsonReport.write.performed, false);
    assert.ok(reportCodes(jsonReport).has('checklist_items_not_done'), 'consumes checklist readiness row from StoryReadinessReport');
    assert.ok(reportCodes(jsonReport).has('missing_verification_evidence'), 'consumes verification readiness row from StoryReadinessReport');

    const directReport = buildStoryReadinessReport({ storyId: STORY_ID, target: 'REVIEW', store, root });
    assert.deepEqual(
      jsonReport.readinessReport,
      directReport,
      'plan_skeleton embeds the V1 StoryReadinessReport verbatim (full shape: target/status/readiness rows), not just row codes',
    );
    assert.deepEqual(snapshotDir(root, storyDir), beforeSnapshot, 'default plan_skeleton must not mutate story metadata files');
    assert.equal(gitStatus(root), beforeStatus, 'default plan_skeleton must leave git status unchanged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const { root, store, ctx } = createFixture();
  try {
    const handler = createMainRegistry(ctx).get('plan_skeleton');
    assert.ok(handler, 'registry exposes plan_skeleton for write test');

    const storyDir = store.storyDirPath(STORY_ID);
    const beforeSnapshot = snapshotDir(root, storyDir);
    const beforeChecklist = store.readChecklist(STORY_ID);
    const writeReport = handler!({ storyId: STORY_ID, write: true, json: true }) as PlanSkeletonReport;
    assertReportShape(writeReport);
    assert.equal(writeReport.mode.write, true);
    assert.equal(writeReport.write.requested, true);
    assert.equal(writeReport.write.performed, true);
    assert.deepEqual(writeReport.write.commandsUsed.sort(), ['checklist_add', 'understanding_set']);
    assert.equal(writeReport.write.understanding.command, 'understanding_set');
    assert.equal(writeReport.write.understanding.status, 'written');
    assert.equal(writeReport.write.checklist.filter((item) => item.status === 'written').length, 2);
    assert.ok(writeReport.write.checklist.every((item) => item.command === 'checklist_add'));

    const understanding = store.readUnderstanding(STORY_ID);
    assert.equal(understanding?.task, writeReport.skeleton.understanding.task);
    assert.deepEqual(understanding?.unknowns, writeReport.skeleton.understanding.unknowns);

    const afterChecklist = store.readChecklist(STORY_ID);
    assert.equal(afterChecklist.items.length, beforeChecklist.items.length + 2, '--write appends suggested checklist items');
    for (const suggestion of writeReport.skeleton.checklist) {
      const item = afterChecklist.items.find((candidate) => candidate.title === suggestion.title);
      assert.ok(item, `checklist_add wrote ${suggestion.title}`);
      assert.equal(item?.context, suggestion.context);
      assert.equal(item?.status, 'pending');
    }
    assert.ok(
      afterChecklist.auditLog?.some((entry) => entry.action === 'add' && entry.reason === 'plan_skeleton --write generated an initial PLAN skeleton from StoryReadinessReport'),
      'checklist_add PLAN audit log records the delegated add reason',
    );

    const processEventsPath = store.storyFilePath(STORY_ID, 'process-events.jsonl');
    assert.equal(existsSync(processEventsPath), true, 'checklist_add process event is written by the delegated path');
    assert.match(readFileSync(processEventsPath, 'utf8'), /"type":"plan_updated"/);

    assert.equal(store.readStory(STORY_ID).phase, 'PLAN', '--write must not advance phase');
    assertNoAuthorityOrEvidenceArtifacts(store);
    assert.deepEqual(
      changedPaths(beforeSnapshot, snapshotDir(root, storyDir)),
      [
        '.lattice/story/actives/B-plan/checklist.json',
        '.lattice/story/actives/B-plan/process-events.jsonl',
        '.lattice/story/actives/B-plan/understanding.json',
      ],
      '--write changes only planning/checklist metadata produced by existing setters',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const { root, store, ctx } = createFixture();
  try {
    const story = store.readStory(STORY_ID);
    store.writeStory(STORY_ID, { ...story, phase: 'DEV' });
    const handler = createMainRegistry(ctx).get('plan_skeleton');
    assert.ok(handler, 'registry exposes plan_skeleton for frozen-phase write test');

    const storyDir = store.storyDirPath(STORY_ID);
    const beforeSnapshot = snapshotDir(root, storyDir);
    const beforeStatus = gitStatus(root);
    assert.throws(
      () => handler!({ storyId: STORY_ID, write: true, json: true }),
      /only allowed in PLAN/,
      '--write is rejected once the story is past PLAN',
    );
    assert.deepEqual(snapshotDir(root, storyDir), beforeSnapshot, 'rejected frozen-phase --write must not mutate story metadata files');
    assert.equal(gitStatus(root), beforeStatus, 'rejected frozen-phase --write must leave git status unchanged');
    assertNoAuthorityOrEvidenceArtifacts(store);
    assert.equal(store.readStory(STORY_ID).phase, 'DEV', 'rejected frozen-phase --write must not advance or roll back phase');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const { root, store, ctx } = createFixture();
  try {
    store.writeScopeBoundary(STORY_ID, buildScopeBoundary({
      storyId: STORY_ID,
      mode: 'feature',
      allowed: ['plan skeleton smoke coverage'],
      excluded: ['Implement'],
      confirmedBy: 'plan-skeleton-smoke',
      confirmationNote: 'Synthetic excluded keyword forces checklist_add preflight failure.',
      now: NOW,
    }));
    const handler = createMainRegistry(ctx).get('plan_skeleton');
    assert.ok(handler, 'registry exposes plan_skeleton for scope preflight test');

    const storyDir = store.storyDirPath(STORY_ID);
    const beforeSnapshot = snapshotDir(root, storyDir);
    const beforeChecklist = store.readChecklist(STORY_ID);
    const beforeUnderstanding = store.readUnderstanding(STORY_ID);
    assert.throws(
      () => handler!({ storyId: STORY_ID, write: true, json: true }),
      /excluded scope keyword/,
      'scope failure is detected before plan_skeleton --write persists anything',
    );
    assert.deepEqual(store.readChecklist(STORY_ID), beforeChecklist, 'rejected scope preflight leaves checklist unchanged');
    assert.deepEqual(store.readUnderstanding(STORY_ID), beforeUnderstanding, 'rejected scope preflight leaves understanding unchanged');
    assert.deepEqual(snapshotDir(root, storyDir), beforeSnapshot, 'rejected scope preflight leaves story metadata files unchanged');
    assertNoAuthorityOrEvidenceArtifacts(store);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const throwingStore = new Proxy({}, {
    get(_target, prop) {
      throw new Error(`store read should not happen before plan_skeleton rejection: ${String(prop)}`);
    },
  }) as StoryStore;
  const ctx: HandlerContext = { store: throwingStore, root: '/tmp/plan-skeleton-no-read', scanRoot: '/tmp/plan-skeleton-no-read/packages/main' };
  const handler = createMainRegistry(ctx).get('plan_skeleton');
  assert.ok(handler, 'registry exposes plan_skeleton for rejection test');
  assert.throws(
    () => handler!({ storyId: 'B-no-read', runCommands: true, json: true }),
    /No story facts were read/,
    'runCommands=true fails closed before store reads',
  );
  assert.throws(
    () => handler!({ storyId: 'B-no-read', writeEvidence: true, json: true }),
    /No story facts were read/,
    'writeEvidence=true fails closed before store reads',
  );
  assert.throws(
    () => handler!({ storyId: 'B-no-read', authorityDone: true, json: true }),
    /No story facts were read/,
    'authorityDone=true fails closed before store reads',
  );
}

{
  // F-011: a --write must fail closed when the checklist is unreadable, leaving
  // no partial understanding-only write. Fresh fixture so deleting its checklist
  // does not affect other blocks (createFixture seeds STORY_ID='B-plan').
  const { root, store, ctx } = createFixture();
  try {
    const handler = createMainRegistry(ctx).get('plan_skeleton');
    assert.ok(handler, 'registry exposes plan_skeleton for missing-checklist write test');

    // Simulate a missing/corrupt checklist by deleting checklist.json after the
    // fixture seeded a valid one (story remains in write-eligible PLAN phase).
    const checklistPath = store.storyFilePath(STORY_ID, 'checklist.json');
    assert.equal(existsSync(checklistPath), true, 'fixture seeds a checklist before deletion');
    rmSync(checklistPath, { force: true });
    assert.equal(existsSync(checklistPath), false, 'checklist.json is removed to simulate an unreadable checklist');

    const storyDir = store.storyDirPath(STORY_ID);
    const beforeSnapshot = snapshotDir(root, storyDir);
    const beforeUnderstanding = store.readUnderstanding(STORY_ID);
    assert.throws(
      () => handler!({ storyId: STORY_ID, write: true, json: true }),
      /unreadable|refusing to write|partial understanding-only/,
      'plan_skeleton --write fails closed when the checklist cannot be read',
    );

    assert.deepEqual(
      store.readUnderstanding(STORY_ID),
      beforeUnderstanding,
      'fail-closed --write leaves understanding untouched (no partial understanding-only write)',
    );
    assert.deepEqual(
      snapshotDir(root, storyDir),
      beforeSnapshot,
      'fail-closed --write leaves the story metadata dir unchanged (no partial mutation)',
    );
    assertNoAuthorityOrEvidenceArtifacts(store);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

process.stdout.write('plan_skeleton smoke passed\n');
