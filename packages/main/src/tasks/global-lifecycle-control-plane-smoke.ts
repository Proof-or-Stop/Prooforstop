#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { READ_ONLY_COMMANDS } from '../cli-engine.js';
import { getCommandPolicy } from '../core/command-policy.js';
import { resetConfigCache } from '../core/config.js';
import type {
  AdmissibilityWaterlineReport,
  QueueExceptionSetResult,
  QueueGovernanceReport,
  RuntimeClosureReport,
} from '../core/lifecycle-control/index.js';
import { evaluateRuntimeEnforcement } from '../core/lifecycle-control/runtime/index.js';
import { StoryStore } from '../core/store.js';
import type { StoryInfo } from '../core/types.js';
import { createMainRegistry } from '../registry.js';
import type { HandlerContext } from '../handlers/context.js';
import type { GlobalControlStatusReport } from '../core/lifecycle-control/dashboard/index.js';

const DRIFT_STORY = 'B-drift';
const TIER_C_STORY = 'B-tierc';
const MALFORMED_STORY = 'B-tierc-bad';
const DUP_A = 'B-dup-a';
const DUP_B = 'B-dup-b';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'global-lifecycle-control-plane-smoke',
      GIT_AUTHOR_EMAIL: 'smoke@example.test',
      GIT_COMMITTER_NAME: 'global-lifecycle-control-plane-smoke',
      GIT_COMMITTER_EMAIL: 'smoke@example.test',
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
      worktreeDir: '.worktrees',
    }, null, 2) + '\n',
    'utf-8',
  );
}

function writeStory(store: StoryStore, storyId: string, phase: StoryInfo['phase'], title: string, worktree?: StoryInfo['worktree']): void {
  const now = '2026-06-28T00:00:00.000Z';
  store.writeStory(storyId, {
    storyId,
    name: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    title,
    description: `Synthetic ${storyId}`,
    type: 'feature',
    phase,
    priority: 'medium',
    createdAt: now,
    startedAt: phase === 'INIT' ? null : now,
    endedAt: null,
    ...(worktree ? { worktree } : {}),
    events: [{ phase, action: 'advance', timestamp: now }],
  });
  store.writeChecklist(storyId, {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic checklist item',
      context: 'Synthetic context',
      status: phase === 'INIT' || phase === 'INIT_CHECK' ? 'pending' : 'done',
      startTime: null,
      endTime: null,
    }],
  });
}

function seedRepo(root: string): HandlerContext {
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeConfig(root);
  writeFileSync(join(root, '.gitignore'), '.worktrees/\n.lattice/locks/\n.lattice/activity.jsonl\n.lattice/story/actives/**/owner-lease.json\n');
  writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const smoke = true;\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base']);
  resetConfigCache();

  const store = new StoryStore(root);
  writeStory(store, TIER_C_STORY, 'INIT', 'Tier-C provider-execution receipt verification (claude) run 01');
  writeStory(store, MALFORMED_STORY, 'INIT', 'Tier-C provider execution receipt malformed');
  writeStory(store, DUP_A, 'PLAN', 'Duplicate queue cleanup smoke');
  writeStory(store, DUP_B, 'PLAN', 'Duplicate queue cleanup smoke');

  const worktreeRel = `.worktrees/${DRIFT_STORY}`;
  const worktreeAbs = join(root, worktreeRel);
  writeStory(store, DRIFT_STORY, 'INIT_CHECK', 'Worktree authoritative lifecycle control story', {
    path: worktreeRel,
    branch: `story/${DRIFT_STORY}`,
    createdAt: '2026-06-28T00:00:00.000Z',
  });
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed stories']);
  mkdirSync(dirname(worktreeAbs), { recursive: true });
  git(root, ['branch', `story/${DRIFT_STORY}`]);
  git(root, ['worktree', 'add', worktreeAbs, `story/${DRIFT_STORY}`]);
  resetConfigCache();
  const wtStore = new StoryStore(worktreeAbs);
  const story = wtStore.readStory(DRIFT_STORY);
  wtStore.writeStory(DRIFT_STORY, {
    ...story,
    phase: 'DEV',
    events: [...(story.events ?? []), { phase: 'DEV', action: 'advance', timestamp: '2026-06-28T00:10:00.000Z' }],
  });
  resetConfigCache();
  return { store: new StoryStore(root), root, scanRoot: join(root, 'packages/main') };
}

function assertStaticRegistration(): void {
  for (const command of ['global_control_status', 'runtime_closure_status', 'admissibility_waterline', 'queue_governance_status']) {
    assert.equal(READ_ONLY_COMMANDS.has(command), true, `${command} must be activity read-only`);
    assert.equal(getCommandPolicy(command)?.ownershipClass, 'readOnly', `${command} must be readOnly`);
  }
  assert.equal(getCommandPolicy('queue_exception_set')?.ownershipClass, 'mainSharedMutating');
  assert.equal(getCommandPolicy('queue_exception_set')?.destructiveRisk, 'metadata-write');
}

function assertRuntimeEnforcementGuardrails(): void {
  const wrongCwd = evaluateRuntimeEnforcement({
    mode: 'enforce',
    operation: 'phase-advance',
    currentCwd: '/repo',
    authoritativeCwd: '/repo/.worktrees/B-runtime',
    authority: 'worktree',
    dirtyState: 'clean',
  });
  assert.equal(wrongCwd.blocked, true);
  assert.equal(wrongCwd.reason, 'wrong_authoritative_cwd');
  assert.equal(wrongCwd.rollback, 'set lifecycleControl.runtimeEnforcement=warn');
  assert.equal(wrongCwd.proofAdmissibilityEvaluated, false);

  const warnOnly = evaluateRuntimeEnforcement({
    mode: 'warn',
    operation: 'main-mirror-read',
    currentCwd: '/repo',
    authoritativeCwd: '/repo/.worktrees/B-runtime',
    authority: 'worktree',
    dirtyState: 'clean',
  });
  assert.equal(warnOnly.blocked, false);
  assert.equal(warnOnly.reason, 'direct_main_mirror_when_worktree_authority');

  const metadataOnly = evaluateRuntimeEnforcement({
    mode: 'enforce',
    operation: 'phase-advance',
    currentCwd: '/repo/.worktrees/B-runtime',
    authoritativeCwd: '/repo/.worktrees/B-runtime',
    authority: 'worktree',
    dirtyState: 'metadata-only',
  });
  assert.equal(metadataOnly.blocked, false);
  assert.equal(metadataOnly.dirtyState, 'metadata-only');
  assert.ok(metadataOnly.advisory.some((item) => item.check === 'dirtyState'));

  const materialDirty = evaluateRuntimeEnforcement({
    mode: 'enforce',
    operation: 'phase-advance',
    currentCwd: '/repo/.worktrees/B-runtime',
    authoritativeCwd: '/repo/.worktrees/B-runtime',
    authority: 'worktree',
    dirtyState: 'material',
  });
  assert.equal(materialDirty.blocked, true);
  assert.equal(materialDirty.reason, 'material_dirty_tree');
}

function runSmoke(): void {
  assertStaticRegistration();
  assertRuntimeEnforcementGuardrails();
  const root = mkdtempSync(join(tmpdir(), 'lattice-global-control-plane-'));
  try {
    const ctx = seedRepo(root);
    const registry = createMainRegistry(ctx);
    const before = gitStatus(root);

    const global = registry.get('global_control_status')!({ format: 'json', expanded: false }) as GlobalControlStatusReport;
    assert.equal(global.schemaVersion, 'lattice.global_control_status.v1');
    assert.equal(global.readOnly, true);
    const driftGlobal = global.stories.find((row) => row.storyId === DRIFT_STORY);
    assert.ok(driftGlobal);
    assert.match(driftGlobal!.authoritativeCwd ?? '', /\.worktrees\/B-drift$/);
    assert.equal(driftGlobal!.queue.classification, 'active-worktree');

    const runtime = registry.get('runtime_closure_status')!({ format: 'json', storyIds: [DRIFT_STORY] }) as RuntimeClosureReport;
    assert.equal(runtime.schemaVersion, 'lattice.runtime_closure_status.v1');
    const drift = runtime.stories[0];
    assert.equal(drift.authority, 'worktree');
    assert.equal(drift.mirrorPhase, 'INIT_CHECK');
    assert.equal(drift.phase, 'DEV');
    assert.match(drift.authoritativeCwd, /\.worktrees\/B-drift$/);

    mkdirSync(join(root, '.lattice/locks/validation/B-drift.lock'), { recursive: true });
    const runtimeSelfLock = registry.get('runtime_closure_status')!({
      format: 'json',
      storyIds: [DRIFT_STORY],
      currentValidationStoryId: DRIFT_STORY,
    }) as RuntimeClosureReport;
    assert.equal(runtimeSelfLock.stories[0].locks.validationLock, 'self-reentry');
    assert.ok(
      runtimeSelfLock.stories[0].advisoryItems.some((item) => item.check === 'validationLock'),
      'active validation lock for current story is rendered as self-reentry, not a foreign-host conflict',
    );

    const waterline = registry.get('admissibility_waterline')!({ format: 'json', storyId: DRIFT_STORY }) as AdmissibilityWaterlineReport;
    assert.equal(waterline.schemaVersion, 'lattice.admissibility_waterline.v1');
    assert.equal(waterline.diagnosticOnly, true);
    const done = waterline.rows.find((row) => row.consumer === 'DONE');
    assert.ok(done);
    assert.equal(done!.diagnosticOnly, true);
    assert.equal(done!.productionDoneEligible, false);
    assert.ok(done!.missingClauses.length > 0, 'DONE row reports diagnostic weakness instead of satisfying DONE');

    const queueCollapsed = registry.get('queue_governance_status')!({ format: 'json' }) as QueueGovernanceReport;
    assert.equal(queueCollapsed.schemaVersion, 'lattice.queue_governance_status.v1');
    const batch = queueCollapsed.experimentBatches.find((entry) => entry.experimentBatchId === 'tier-c-provider-execution-receipt-verification');
    assert.ok(batch);
    assert.equal(batch!.defaultDashboardMode, 'collapsed');
    assert.equal('storyIds' in batch!, false, 'collapsed view hides member story ids');
    assert.equal(queueCollapsed.rows.find((row) => row.storyId === TIER_C_STORY)?.classification, 'experiment-batch-exception');
    assert.equal(queueCollapsed.rows.find((row) => row.storyId === MALFORMED_STORY)?.classification, 'cleanup-required');
    assert.equal(queueCollapsed.rows.find((row) => row.storyId === DUP_B)?.classification, 'duplicate-candidate');

    const queueExpanded = registry.get('queue_governance_status')!({ format: 'json', expanded: true }) as QueueGovernanceReport;
    const expandedBatch = queueExpanded.experimentBatches.find((entry) => entry.experimentBatchId === 'tier-c-provider-execution-receipt-verification');
    assert.ok(expandedBatch?.storyIds?.includes(TIER_C_STORY), 'expanded view lists Tier-C members');

    assert.equal(gitStatus(root), before, 'read-only control-plane commands must not mutate git status');

    assert.throws(
      () => registry.get('queue_exception_set')!({ experimentBatchId: 'tier-c-provider-execution-receipt-verification', storyIds: [TIER_C_STORY], reason: 'short' }),
      /reason/,
      'queue_exception_set enforces explicit schema guardrails',
    );
    const exception = registry.get('queue_exception_set')!({
      format: 'json',
      experimentBatchId: 'tier-c-provider-execution-receipt-verification',
      storyIds: [TIER_C_STORY],
      reason: 'Preserve Tier-C provider-execution receipt verification trial identity.',
      actor: 'global-lifecycle-control-plane-smoke',
    }) as QueueExceptionSetResult;
    assert.equal(exception.schemaVersion, 'lattice.queue_exception_set.v1');
    assert.equal(exception.written, true);
    assert.equal(exception.policyVersion, 'proofbound.queue_exception.v1');
    assert.equal(exception.class, 'experiment-batch-exception');
    assert.equal(exception.cleanupPolicy, 'preserve');
    assert.ok(exception.storyFilesHash.length > 0);
    assert.ok(existsSync(join(root, '.lattice/lifecycle-control/queue-exceptions.json')));
    const audit = readFileSync(join(root, '.lattice/lifecycle-control/queue-exceptions.audit.jsonl'), 'utf-8');
    assert.match(audit, /queue_exception_set/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

runSmoke();
console.log('global lifecycle control plane smoke passed');
