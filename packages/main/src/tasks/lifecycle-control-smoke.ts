#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  DEFAULT_CONTROL_PLANE_CAPABILITIES,
  isReadOnlyControlPlane,
} from '../core/lifecycle-control/index.js';
import { buildGlobalControlStatus } from '../core/lifecycle-control/dashboard/index.js';
import { projectQueueGovernance } from '../core/lifecycle-control/queue/index.js';
import { evaluateRuntimeEnforcement } from '../core/lifecycle-control/runtime/index.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';

const NOW = '2026-06-30T00:00:00.000Z';
const TIER_C_BATCH_ID = 'tier-c-provider-execution-receipt-verification';
const CLOSURE_AUDIT_PATH = 'docs/requirements/decisions/control-plane-proof-capability-closure-audit.md';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'lifecycle-control-smoke',
      GIT_AUTHOR_EMAIL: 'lifecycle-control-smoke@example.com',
      GIT_COMMITTER_NAME: 'lifecycle-control-smoke',
      GIT_COMMITTER_EMAIL: 'lifecycle-control-smoke@example.com',
    },
  }).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, 'utf8');
}

function writeConfig(root: string): void {
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
    lifecycleControl: { runtimeEnforcement: 'warn' },
  }, null, 2) + '\n');
  resetConfigCache();
}

function story(storyId: string, title: string): StoryInfo {
  return {
    storyId,
    name: storyId.toLowerCase(),
    title,
    description: `${title} synthetic lifecycle-control fixture.`,
    type: 'feature',
    phase: 'INIT',
    priority: 'medium',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
  };
}

function checklist(): ChecklistData {
  return {
    items: [{
      id: 'CHK-001',
      title: 'pending fixture work',
      context: 'keeps lifecycle readiness red so queue exceptions cannot grant completion',
      status: 'pending',
      startTime: null,
      endTime: null,
      verificationIntent: {
        happy: [{ desc: 'fixture intent', type: 'logic', priority: 'must' }],
        edge: [],
        adversarial: [],
      },
      verificationEvidence: [],
    }],
  };
}

function createFixture(): { root: string; store: StoryStore } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-lifecycle-control-'));
  writeConfig(root);
  write(root, 'README.md', '# lifecycle control smoke\n');
  write(root, 'packages/main/src/index.ts', 'export const value = true;\n');
  git(root, ['init']);
  git(root, ['checkout', '-b', 'main']);
  git(root, ['add', 'README.md', 'lattice.config.json', 'packages/main/src/index.ts']);
  git(root, ['commit', '-m', 'base']);

  const store = new StoryStore(root);
  for (const fixtureStory of [
    story('B-tier-a', 'Tier-C provider-execution receipt verification (claude) run 111-222-333: add a one-line code comment'),
    story('B-tier-b', 'Tier-C provider-execution receipt verification run 444-555-666: add a one-line code comment'),
    story('B-tier-malformed', 'Tier-C end-to-end provider-execution receipt verification: malformed cleanup case'),
  ]) {
    store.writeStory(fixtureStory.storyId, fixtureStory);
    store.writeChecklist(fixtureStory.storyId, checklist());
  }
  return { root, store };
}

function assertClosureAuditContract(): void {
  const audit = readFileSync(join(process.cwd(), CLOSURE_AUDIT_PATH), 'utf8');
  for (const milestone of ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7']) {
    const matches = audit.match(new RegExp(`\\| ${milestone} \\|`, 'g')) ?? [];
    assert.equal(matches.length, 1, `${CLOSURE_AUDIT_PATH} must list ${milestone} exactly once`);
  }
  for (const checklistId of ['CHK-001', 'CHK-002', 'CHK-003', 'CHK-004', 'CHK-005', 'CHK-006', 'CHK-007']) {
    assert.ok(audit.includes(`| ${checklistId} |`), `${CLOSURE_AUDIT_PATH} must bind ${checklistId}`);
  }
  assert.match(audit, /\| M4 \| CHK-004 \| Append-only admissibility ledger \| retired\/non-goal \|/);
  assert.match(audit, /\| M7 \| CHK-007 \| CommandSpec envelope and project waterline coverage \| missing-to-implement \|/);
  assert.ok(!audit.includes('| M8 |'), `${CLOSURE_AUDIT_PATH} must not expand B-c004 beyond M1-M7`);
}

function assertCapabilityStatuses(): void {
  const caps = DEFAULT_CONTROL_PLANE_CAPABILITIES;
  assert.equal(caps.proofM7Enforcement, false, 'control plane must not claim Proof M7 enforcement');
  assert.equal(caps.queueCleanupEnforcement, false, 'control plane must not claim cleanup enforcement');
  assert.equal(caps.tierCCleanup, false, 'control plane must not claim Tier-C cleanup automation');
  assert.equal(caps.capabilityStatus.proofM7Enforcement, 'partial');
  assert.equal(caps.capabilityStatus.queueCleanupEnforcement, 'implemented');
  assert.equal(caps.capabilityStatus.tierCCleanup, 'unavailable');
  assert.equal(caps.capabilities.find(row => row.id === 'proof-m7-enforcement')?.status, 'partial');
  assert.equal(caps.capabilities.find(row => row.id === 'queue-cleanup-enforcement')?.status, 'implemented');
  assert.equal(caps.capabilities.find(row => row.id === 'tier-c-cleanup')?.status, 'unavailable');
  assert.equal(isReadOnlyControlPlane(caps), true, 'richer statuses must preserve read-only/no-enforcement booleans');
}

function assertTierCQueueGovernance(root: string, store: StoryStore): void {
  const queue = projectQueueGovernance(store, root, { expanded: true, now: NOW });
  const tierRows = queue.rows.filter(row => row.storyId === 'B-tier-a' || row.storyId === 'B-tier-b');
  assert.equal(tierRows.length, 2);
  for (const row of tierRows) {
    assert.equal(row.classification, 'experiment-batch-exception');
    assert.notEqual(row.classification, 'duplicate-candidate');
    assert.equal(row.experimentBatchId, TIER_C_BATCH_ID);
    assert.equal(row.exceptionSource, 'migration-title-prefix');
    assert.equal(row.cleanupPolicy, 'preserve');
    assert.match(row.reason, /lifecycle readiness is unchanged/);
  }
  const malformed = queue.rows.find(row => row.storyId === 'B-tier-malformed');
  assert.equal(malformed?.classification, 'cleanup-required');
  assert.equal(malformed?.cleanupPolicy, 'cleanup-required');
  assert.equal(queue.duplicateClusters.length, 0, 'Tier-C experiment rows must not become duplicate cleanup candidates');
  assert.equal(queue.summary.experimentBatchException, 2);
  assert.equal(queue.summary.duplicateCandidate, 0);
  assert.equal(queue.experimentBatches.length, 1);
  assert.equal(queue.experimentBatches[0]?.experimentBatchId, TIER_C_BATCH_ID);
  assert.deepEqual(queue.experimentBatches[0]?.storyIds, ['B-tier-a', 'B-tier-b']);
}

function assertQueueCleanupGuard(root: string, store: StoryStore): void {
  store.writeStory('B-dup-a', story('B-dup-a', 'Duplicate cleanup guard shared title'));
  store.writeChecklist('B-dup-a', checklist());
  store.writeStory('B-dup-b', story('B-dup-b', 'Duplicate cleanup guard shared title'));
  store.writeChecklist('B-dup-b', checklist());

  const superseded = story('B-superseded', 'Superseded cleanup guard row') as StoryInfo & {
    lifecycleControl: { queue: { supersededBy: string } };
  };
  superseded.lifecycleControl = { queue: { supersededBy: 'B-dup-a' } };
  store.writeStory('B-superseded', superseded);
  store.writeChecklist('B-superseded', checklist());

  const queue = projectQueueGovernance(store, root, { expanded: true, now: NOW });
  const duplicate = queue.rows.find(row => row.storyId === 'B-dup-b');
  assert.equal(duplicate?.classification, 'duplicate-candidate');
  assert.equal(duplicate?.cleanupPolicy, 'review-required');
  assert.match(duplicate?.reason ?? '', /choose canonical\/superseded disposition/);

  const supersededRow = queue.rows.find(row => row.storyId === 'B-superseded');
  assert.equal(supersededRow?.classification, 'superseded');
  assert.equal(supersededRow?.cleanupPolicy, 'cleanup-required');
  assert.match(supersededRow?.reason ?? '', /B-dup-a/);

  const tier = queue.rows.find(row => row.storyId === 'B-tier-a');
  assert.equal(tier?.classification, 'experiment-batch-exception');
  assert.equal(tier?.cleanupPolicy, 'preserve');
  assert.equal(queue.summary.duplicateCandidate, 1);
  assert.equal(queue.summary.superseded, 1);
  assert.ok(queue.cleanupRequired.some(row => row.storyId === 'B-tier-malformed'), 'malformed Tier-C-like row stays visible to cleanup operators');
}

function assertDashboardDoesNotWaiveLifecycle(root: string, store: StoryStore): void {
  const report = buildGlobalControlStatus(store, root, {
    storyIds: ['B-tier-a'],
    expanded: true,
    now: NOW,
  });
  assert.equal(report.project.capabilities.capabilityStatus.proofM7Enforcement, 'partial');
  const row = report.stories.find(candidate => candidate.storyId === 'B-tier-a');
  assert.ok(row, 'global control report includes B-tier-a');
  assert.equal(row?.queue.classification, 'experiment-batch-exception');
  assert.equal(row?.queue.cleanupPolicy, 'preserve');
  assert.equal(row?.readyForNextSafeAction, false, 'queue exception cannot grant lifecycle readiness');
  assert.notEqual(row?.runtime.status, 'green', 'pending checklist keeps runtime/readiness non-green');
}

function assertRuntimeEnforcementDecisions(): void {
  const wrongCwd = evaluateRuntimeEnforcement({
    mode: 'enforce',
    operation: 'phase-advance',
    currentCwd: '/repo/main',
    authoritativeCwd: '/repo/.worktrees/B-life',
    authority: 'worktree',
    dirtyState: 'clean',
    validationLock: 'free',
    mainWriteLock: 'free',
  });
  assert.equal(wrongCwd.blocked, true);
  assert.equal(wrongCwd.reason, 'wrong_authoritative_cwd');
  assert.equal(wrongCwd.rollback, 'set lifecycleControl.runtimeEnforcement=warn');
  assert.equal(wrongCwd.proofAdmissibilityEvaluated, false);

  const directMirror = evaluateRuntimeEnforcement({
    mode: 'enforce',
    operation: 'main-mirror-read',
    currentCwd: '/repo/main',
    authoritativeCwd: '/repo/.worktrees/B-life',
    authority: 'worktree',
    dirtyState: 'clean',
    validationLock: 'free',
    mainWriteLock: 'free',
  });
  assert.equal(directMirror.blocked, true);
  assert.equal(directMirror.reason, 'direct_main_mirror_when_worktree_authority');

  const warnDirty = evaluateRuntimeEnforcement({
    mode: 'warn',
    operation: 'phase-advance',
    currentCwd: '/repo/.worktrees/B-life',
    authoritativeCwd: '/repo/.worktrees/B-life',
    authority: 'worktree',
    dirtyState: 'material',
    validationLock: 'free',
    mainWriteLock: 'free',
  });
  assert.equal(warnDirty.blocked, false);
  assert.equal(warnDirty.reason, 'material_dirty_tree');
  assert.equal(warnDirty.rollback, 'set lifecycleControl.runtimeEnforcement=warn');

  const unavailableWrongCwd = evaluateRuntimeEnforcement({
    mode: 'unavailable',
    operation: 'phase-advance',
    currentCwd: '/repo/main',
    authoritativeCwd: '/repo/.worktrees/B-life',
    authority: 'worktree',
    dirtyState: 'clean',
    validationLock: 'free',
    mainWriteLock: 'free',
  });
  assert.equal(unavailableWrongCwd.blocked, false);
  assert.equal(unavailableWrongCwd.reason, 'wrong_authoritative_cwd');
  assert.equal(unavailableWrongCwd.advisory[0]?.remediation, 'set lifecycleControl.runtimeEnforcement=warn to roll back enforcement while diagnosing');

  const staleLock = evaluateRuntimeEnforcement({
    mode: 'enforce',
    operation: 'phase-advance',
    currentCwd: '/repo/.worktrees/B-life',
    authoritativeCwd: '/repo/.worktrees/B-life',
    authority: 'worktree',
    dirtyState: 'clean',
    validationLock: 'stale',
    mainWriteLock: 'free',
  });
  assert.equal(staleLock.blocked, true);
  assert.equal(staleLock.reason, 'stale_active_lock');
}

assertClosureAuditContract();
assertCapabilityStatuses();
const { root, store } = createFixture();
assertTierCQueueGovernance(root, store);
assertQueueCleanupGuard(root, store);
assertDashboardDoesNotWaiveLifecycle(root, store);
assertRuntimeEnforcementDecisions();

console.log('lifecycle-control-smoke passed');
