#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { READ_ONLY_COMMANDS } from '../cli-engine.js';
import { upsertAuthorityGateReceiptRef, type AuthorityGateDecisionReceiptRef } from '../core/authority-gate-receipts.js';
import { getCommandPolicy } from '../core/command-policy.js';
import { resetConfigCache } from '../core/config.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import type {
  AdmissibilityWaterlineReport,
  QueueExceptionSetResult,
  QueueGovernanceReport,
  RuntimeClosureReport,
} from '../core/lifecycle-control/index.js';
import { evaluateRuntimeEnforcement } from '../core/lifecycle-control/runtime/index.js';
import { acquireMainWriteLock } from '../core/main-write-lock.js';
import { getSessionId, ownerLeasePath } from '../core/story-owner-lease.js';
import { StoryStore } from '../core/store.js';
import type { StoryInfo } from '../core/types.js';
import { createMainRegistry } from '../registry.js';
import type { HandlerContext } from '../handlers/context.js';
import type { GlobalControlStatusReport } from '../core/lifecycle-control/dashboard/index.js';

const DRIFT_STORY = 'B-drift';
const TIER_C_STORY = 'B-tierc';
const TIER_C_DURABLE_STORY = 'B-tierc-durable';
const MALFORMED_STORY = 'B-tierc-bad';
const DUP_A = 'B-dup-a';
const DUP_B = 'B-dup-b';
const SUPERSEDED_STORY = 'B-superseded';
const LATTICE_CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const READ_ONLY_STATUS_COMMANDS = [
  'global_control_status',
  'runtime_closure_status',
  'admissibility_waterline',
  'queue_governance_status',
] as const;
const UNSUPPORTED_STATUS_FLAGS = [
  'write',
  'apply',
  'execute',
  'productionDone',
] as const;

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

function runCliExpectFail(cwd: string, command: string, flags: readonly string[]): string {
  try {
    execFileSync(process.execPath, [LATTICE_CLI, command, ...flags], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    assert.notEqual(e.status, 0, `${command} ${flags.join(' ')} exits nonzero`);
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  assert.fail(`${command} ${flags.join(' ')} unexpectedly succeeded`);
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

function writeStory(
  store: StoryStore,
  storyId: string,
  phase: StoryInfo['phase'],
  title: string,
  worktree?: StoryInfo['worktree'],
  extra: Record<string, unknown> = {},
): void {
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
    ...extra,
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

function writeIneligibleAuthorityReceiptRef(root: string, store: StoryStore, storyId: string): void {
  const headHash = currentGitHead(root);
  const materialHash = currentMaterialHash(root, 'HEAD', root);
  assert.ok(headHash, 'smoke repo has a current git HEAD for Authority receipt ref');
  assert.ok(materialHash, 'smoke repo has a current material hash for Authority receipt ref');
  const ref: AuthorityGateDecisionReceiptRef = {
    receiptId: 'receipt-local-test-only',
    receiptKind: 'gate_decision',
    classification: 'server-receipt-local-test',
    authorityKeyId: 'local-test-key',
    authorityPublicKeyDigest: 'local-test-digest',
    decisionId: 'decision-local-test-only',
    stateVersion: 1,
    gateInputDigest: 'gate-input-digest',
    decisionDigest: 'decision-digest',
    decisionVerdict: 'pass',
    storyId,
    targetPhase: 'DONE',
    headHash,
    materialHash,
    policyMode: 'balanced',
    authorityMode: 'enforce',
    producerRunIds: ['producer-run'],
    verifierRunIds: ['verifier-run'],
    evidenceDigests: ['evidence-digest'],
    verifiedAt: '2026-06-28T00:00:00.000Z',
    status: 'active',
  };
  store.writeAuthorityReceiptRefs(storyId, upsertAuthorityGateReceiptRef(undefined, ref, ref.verifiedAt!));
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
  writeStory(store, TIER_C_DURABLE_STORY, 'INIT', 'Tier-C provider-execution receipt verification (claude) durable run', undefined, {
    lifecycleControl: {
      queue: {
        experimentBatchId: 'tier-c-provider-execution-receipt-verification',
        reason: 'Preserve durable Tier-C provider-execution receipt verification trial identity.',
      },
    },
  });
  writeStory(store, MALFORMED_STORY, 'INIT', 'Tier-C provider execution receipt malformed');
  writeStory(store, SUPERSEDED_STORY, 'PLAN', 'Duplicate queue cleanup smoke', undefined, {
    lifecycleControl: { queue: { supersededBy: DUP_A } },
  });
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
  const leaseHeartbeat = new Date().toISOString();
  writeFileSync(ownerLeasePath(wtStore.storyDirPath(DRIFT_STORY)), JSON.stringify({
    sessionId: getSessionId(),
    sessionSource: 'derived-ppid',
    hostname: 'global-lifecycle-control-plane-smoke',
    pid: process.pid + 1000000,
    cwd: worktreeAbs,
    command: 'global-lifecycle-control-plane-smoke',
    acquiredAt: leaseHeartbeat,
    heartbeatAt: leaseHeartbeat,
  }, null, 2) + '\n');
  resetConfigCache();
  return { store: new StoryStore(root), root, scanRoot: join(root, 'packages/main') };
}

function assertStaticRegistration(): void {
  for (const command of READ_ONLY_STATUS_COMMANDS) {
    assert.equal(READ_ONLY_COMMANDS.has(command), true, `${command} must be activity read-only`);
    assert.equal(getCommandPolicy(command)?.ownershipClass, 'readOnly', `${command} must be readOnly`);
  }
  assert.equal(getCommandPolicy('queue_exception_set')?.ownershipClass, 'mainSharedMutating');
  assert.equal(getCommandPolicy('queue_exception_set')?.destructiveRisk, 'metadata-write');
}

function assertUnsupportedStatusFlagsFailClosed(root: string): void {
  const throwingStore = new Proxy({}, {
    get(_target, prop) {
      throw new Error(`store read should not happen before status flag rejection: ${String(prop)}`);
    },
  }) as StoryStore;
  const noReadRegistry = createMainRegistry({ store: throwingStore, root, scanRoot: join(root, 'packages/main') });

  for (const command of READ_ONLY_STATUS_COMMANDS) {
    for (const flag of UNSUPPORTED_STATUS_FLAGS) {
      assert.throws(
        () => noReadRegistry.get(command)!({ [flag]: true, json: true }),
        /refuses unsupported side effects|no story facts were read/,
        `${command} rejects ${flag}=true before store reads`,
      );
      const output = runCliExpectFail(root, command, [`--${flag}=true`, '--json']);
      assert.match(output, new RegExp(flag), `${command} CLI rejection names --${flag}`);
      assert.match(output, /Argument validation failed/, `${command} CLI rejection is validation failure`);
    }
  }
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
    writeIneligibleAuthorityReceiptRef(root, ctx.store, DRIFT_STORY);
    const registry = createMainRegistry(ctx);
    assertUnsupportedStatusFlagsFailClosed(root);
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
    const authorityDecision = waterline.rows.find((row) => row.consumer === 'AUTHORITY_GATE_DECISION');
    assert.ok(authorityDecision);
    assert.notEqual(
      authorityDecision!.status,
      'pass',
      'Authority gate decision waterline must not pass on mere receipt-ref presence when eligibility rejects it',
    );
    assert.ok(
      authorityDecision!.missingClauses.includes('authority_receipt_not_production_classified'),
      'Authority gate decision waterline reports the real receipt eligibility rejection reason',
    );
    assert.equal(authorityDecision!.diagnosticOnly, true);
    assert.equal(authorityDecision!.productionDoneEligible, false);
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
    assert.equal(
      queueCollapsed.rows.find((row) => row.storyId === TIER_C_STORY)?.classification,
      'main-init',
      'title-only Tier-C stories are discovery candidates, not durable experiment exceptions',
    );
    assert.equal(
      queueCollapsed.rows.find((row) => row.storyId === TIER_C_DURABLE_STORY)?.classification,
      'experiment-batch-exception',
      'durable story metadata preserves Tier-C experiment exceptions without title-prefix inference',
    );
    assert.equal(queueCollapsed.rows.find((row) => row.storyId === MALFORMED_STORY)?.classification, 'cleanup-required');
    assert.notEqual(
      queueCollapsed.rows.find((row) => row.storyId === DUP_A)?.classification,
      'duplicate-candidate',
      'a superseded predecessor with the same title must not make its replacement a duplicate candidate',
    );
    assert.equal(queueCollapsed.rows.find((row) => row.storyId === DUP_B)?.classification, 'duplicate-candidate');
    assert.equal(queueCollapsed.rows.find((row) => row.storyId === SUPERSEDED_STORY)?.classification, 'superseded');
    assert.ok(
      queueCollapsed.duplicateClusters.every((cluster) => !cluster.duplicateStoryIds.includes(SUPERSEDED_STORY) && cluster.canonicalStoryId !== SUPERSEDED_STORY),
      'superseded stories do not participate in duplicate cluster canonical selection',
    );
    assert.equal(queueCollapsed.summary.superseded, 1);

    const queueExpanded = registry.get('queue_governance_status')!({ format: 'json', expanded: true }) as QueueGovernanceReport;
    const expandedBatch = queueExpanded.experimentBatches.find((entry) => entry.experimentBatchId === 'tier-c-provider-execution-receipt-verification');
    assert.ok(expandedBatch?.storyIds?.includes(TIER_C_DURABLE_STORY), 'expanded view lists durable Tier-C members');

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
    const queueAfterException = registry.get('queue_governance_status')!({ format: 'json', expanded: true }) as QueueGovernanceReport;
    assert.equal(
      queueAfterException.rows.find((row) => row.storyId === TIER_C_STORY)?.classification,
      'experiment-batch-exception',
      'explicit queue_exception_set preserves title-only Tier-C stories after registry membership exists',
    );
    assert.ok(
      queueAfterException.experimentBatches
        .find((entry) => entry.experimentBatchId === 'tier-c-provider-execution-receipt-verification')
        ?.storyIds?.includes(TIER_C_STORY),
      'expanded view includes explicitly registered Tier-C members',
    );
    const worktreeException = registry.get('queue_exception_set')!({
      format: 'json',
      experimentBatchId: 'worktree-main-root-exception-smoke',
      storyIds: [DRIFT_STORY],
      reason: 'Preserve worktree story from a main-root explicit queue exception.',
      actor: 'global-lifecycle-control-plane-smoke',
    }) as QueueExceptionSetResult;
    assert.equal(worktreeException.written, true);

    const worktreeCtx: HandlerContext = {
      store: new StoryStore(join(root, `.worktrees/${DRIFT_STORY}`)),
      root: join(root, `.worktrees/${DRIFT_STORY}`),
      scanRoot: join(root, `.worktrees/${DRIFT_STORY}`, 'packages/main'),
    };
    const worktreeRegistry = createMainRegistry(worktreeCtx);
    const worktreeGlobal = worktreeRegistry.get('global_control_status')!({ format: 'json', expanded: false }) as GlobalControlStatusReport;
    const worktreeGlobalDrift = worktreeGlobal.stories.find((row) => row.storyId === DRIFT_STORY);
    assert.ok(worktreeGlobalDrift);
    assert.equal(
      worktreeGlobalDrift!.queue.classification,
      'experiment-batch-exception',
      'worktree global status reads explicit queue exceptions from the canonical main root',
    );
    assert.equal(worktreeGlobal.project.staleWorktreeCount, 0);

    const worktreeQueue = worktreeRegistry.get('queue_governance_status')!({ format: 'json' }) as QueueGovernanceReport;
    assert.equal(
      worktreeQueue.rows.find((row) => row.storyId === DRIFT_STORY)?.classification,
      'experiment-batch-exception',
      'worktree queue status sees the main-root explicit queue exception',
    );
    assert.equal(worktreeQueue.summary.staleWorktree, 0);

    const worktreeRuntime = worktreeRegistry.get('runtime_closure_status')!({ format: 'json', storyIds: [DRIFT_STORY] }) as RuntimeClosureReport;
    assert.equal(
      worktreeRuntime.stories[0].locks.ownerLease,
      'owned',
      'runtime closure owner lease follows sessionId ownership even when the recorded pid differs',
    );

    const lock = acquireMainWriteLock(root, { label: 'queue_exception_set smoke holder' });
    try {
      const worktreeRuntimeLocked = worktreeRegistry.get('runtime_closure_status')!({
        format: 'json',
        storyIds: [DRIFT_STORY],
      }) as RuntimeClosureReport;
      assert.equal(
        worktreeRuntimeLocked.stories[0].locks.mainWriteLock,
        'active',
        'worktree runtime closure status sees the canonical main-root main write lock',
      );
      assert.throws(
        () => worktreeRegistry.get('queue_exception_set')!({
          format: 'json',
          experimentBatchId: 'tier-c-provider-execution-receipt-verification',
          storyIds: [MALFORMED_STORY],
          reason: 'Preserve malformed Tier-C receipt trial while lock is held.',
          actor: 'global-lifecycle-control-plane-smoke',
        }),
        /queue_exception_set is blocked: the main write lock is held/,
        'queue_exception_set from a worktree must contend on the canonical main write lock',
      );
    } finally {
      lock.release();
    }
    assert.equal(
      existsSync(join(root, `.worktrees/${DRIFT_STORY}`, '.lattice/lifecycle-control/queue-exceptions.json')),
      false,
      'worktree invocation must not write a worktree-local queue exception registry',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

runSmoke();
console.log('global lifecycle control plane smoke passed');
