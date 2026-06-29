import { existsSync, statSync } from 'node:fs';

import { buildStoryReadinessReport, type LifecycleReadinessTarget } from '../../lifecycle-readiness.js';
import { resolveLocalAssuranceStories } from '../../local-assurance-story-projection.js';
import { mainWriteLockPath, MAIN_WRITE_LOCK_STALE_MS } from '../../main-write-lock.js';
import { readMkdirLockHolder } from '../../mkdir-lock.js';
import { getSessionId, readOwnerLease, STALE_LEASE_THRESHOLD_MS, isLeaseStale } from '../../story-owner-lease.js';
import type { StoryStore } from '../../store.js';
import type { StoryPhase } from '../../types.js';
import { getRepoRoot } from '../../worktree-runtime.js';
import {
  type LifecycleControlIssue,
  type RuntimeClosureReport,
  type RuntimeClosureRow,
} from '../control-status.js';
import { buildProjectControlStatus, buildStoryControlStatus, isReadOnlyControlPlane } from '../global-control-service.js';
import { LIFECYCLE_CONTROL_MIGRATION_MILESTONES } from '../milestones.js';

export * from '../control-status.js';
export { buildProjectControlStatus, buildStoryControlStatus, isReadOnlyControlPlane, LIFECYCLE_CONTROL_MIGRATION_MILESTONES };

const VALIDATION_LOCK_STALE_MS = 120000;

export interface RuntimeClosureOptions {
  readonly storyIds?: readonly string[];
  readonly activeOnly?: boolean;
  readonly now?: string;
  readonly currentValidationStoryId?: string;
}

export type RuntimeEnforcementMode = 'unavailable' | 'warn' | 'enforce';
export type RuntimeOperation = 'phase-advance' | 'validation-write' | 'main-mirror-read' | 'shared-main-write';
export type RuntimeDirtyState = 'clean' | 'metadata-only' | 'material';

export interface RuntimeEnforcementInput {
  readonly mode: RuntimeEnforcementMode;
  readonly operation: RuntimeOperation;
  readonly currentCwd: string;
  readonly authoritativeCwd: string;
  readonly authority: 'main' | 'worktree' | 'unknown';
  readonly dirtyState?: RuntimeDirtyState;
  readonly validationLock?: RuntimeClosureRow['locks']['validationLock'];
  readonly mainWriteLock?: RuntimeClosureRow['locks']['mainWriteLock'];
}

export interface RuntimeEnforcementDecision {
  readonly mode: RuntimeEnforcementMode;
  readonly operation: RuntimeOperation;
  readonly blocked: boolean;
  readonly reason: 'none' | 'wrong_authoritative_cwd' | 'material_dirty_tree' | 'stale_active_lock' | 'direct_main_mirror_when_worktree_authority' | 'main_write_lock_active';
  readonly dirtyState: RuntimeDirtyState;
  readonly rollback: 'set lifecycleControl.runtimeEnforcement=warn';
  readonly proofAdmissibilityEvaluated: false;
  readonly advisory: readonly LifecycleControlIssue[];
}

function normalizePathForCompare(value: string): string {
  return value.replace(/\/+$/g, '');
}

export function evaluateRuntimeEnforcement(input: RuntimeEnforcementInput): RuntimeEnforcementDecision {
  const advisory: LifecycleControlIssue[] = [];
  const dirtyState = input.dirtyState ?? 'clean';
  let reason: RuntimeEnforcementDecision['reason'] = 'none';
  const current = normalizePathForCompare(input.currentCwd);
  const authoritative = normalizePathForCompare(input.authoritativeCwd);

  if (input.authority === 'worktree' && current !== authoritative) {
    reason = input.operation === 'main-mirror-read'
      ? 'direct_main_mirror_when_worktree_authority'
      : 'wrong_authoritative_cwd';
  } else if (input.operation === 'phase-advance' && dirtyState === 'material') {
    reason = 'material_dirty_tree';
  } else if (input.validationLock === 'active' || input.validationLock === 'stale') {
    reason = 'stale_active_lock';
  } else if (input.operation === 'shared-main-write' && input.mainWriteLock === 'active') {
    reason = 'main_write_lock_active';
  }

  if (dirtyState === 'metadata-only') {
    advisory.push({
      check: 'dirtyState',
      reason: 'metadata-only dirty state detected; runtime guard distinguishes it from material source dirt',
      remediation: 'follow done_prepare/lifecycle_check guidance before phase-sensitive operations',
      source: 'runtime-enforcement',
    });
  }
  if (reason !== 'none') {
    advisory.push({
      check: 'runtimeEnforcement',
      reason,
      remediation: 'set lifecycleControl.runtimeEnforcement=warn to roll back enforcement while diagnosing',
      source: 'runtime-enforcement',
    });
  }

  return {
    mode: input.mode,
    operation: input.operation,
    blocked: input.mode === 'enforce' && reason !== 'none',
    reason,
    dirtyState,
    rollback: 'set lifecycleControl.runtimeEnforcement=warn',
    proofAdmissibilityEvaluated: false,
    advisory,
  };
}

function targetForPhase(phase: StoryPhase): LifecycleReadinessTarget {
  if (phase === 'TEST' || phase === 'DONE') return 'DONE';
  if (phase === 'REVIEW') return 'TEST';
  return 'REVIEW';
}

function lockAgeMs(path: string, nowMs: number): number | null {
  try {
    return nowMs - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function mainWriteLockStatus(root: string, nowMs: number): RuntimeClosureRow['locks']['mainWriteLock'] {
  const path = mainWriteLockPath(getRepoRoot(root));
  if (!existsSync(path)) return 'free';
  const age = lockAgeMs(path, nowMs);
  if (age !== null && age >= MAIN_WRITE_LOCK_STALE_MS) return 'stale';
  return 'active';
}

function validationLockPath(root: string, storyId: string): string {
  const safe = storyId.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
  return `${root}/.lattice/locks/validation/${safe}.lock`;
}

function validationLockStatus(
  root: string,
  storyId: string,
  nowMs: number,
  currentValidationStoryId?: string,
): RuntimeClosureRow['locks']['validationLock'] {
  const path = validationLockPath(root, storyId);
  if (!existsSync(path)) return 'free';
  const age = lockAgeMs(path, nowMs);
  if (age !== null && age >= VALIDATION_LOCK_STALE_MS) return 'stale';
  const holder = readMkdirLockHolder(path);
  if (currentValidationStoryId === storyId || holder?.pid === process.pid) return 'self-reentry';
  return 'active';
}

function ownerLeaseStatus(store: StoryStore, storyId: string, nowMs: number): RuntimeClosureRow['locks']['ownerLease'] {
  const lease = readOwnerLease(store.storyDirPath(storyId));
  if (!lease) return 'missing';
  if (isLeaseStale(lease, nowMs)) return 'stale';
  return lease.sessionId === getSessionId() ? 'owned' : 'foreign-active';
}

function ownerLeaseIssue(status: RuntimeClosureRow['locks']['ownerLease']): LifecycleControlIssue | null {
  if (status === 'foreign-active') {
    return {
      check: 'ownerLease',
      reason: 'another active owner lease holds story-scoped mutation rights',
      remediation: 'coordinate with the owning session or wait for lease expiry before mutating',
      source: 'core/story-owner-lease',
    };
  }
  if (status === 'stale') {
    return {
      check: 'ownerLease',
      reason: `owner lease heartbeat is older than ${Math.floor(STALE_LEASE_THRESHOLD_MS / 60000)} minutes`,
      remediation: 'use the existing takeover flow before story-scoped mutation',
      source: 'core/story-owner-lease',
    };
  }
  return null;
}

function validationLockIssue(status: RuntimeClosureRow['locks']['validationLock']): LifecycleControlIssue | null {
  if (status === 'active') {
    return {
      check: 'validationLock',
      reason: 'validation execution lock is active for this story',
      remediation: 'wait for active validation to finish before running another validation writer',
      source: 'core/validation-execution-lock',
    };
  }
  if (status === 'self-reentry') {
    return {
      check: 'validationLock',
      reason: 'current process/session already owns this validation lock',
      remediation: 'treat as self-reentry rather than a foreign-host conflict',
      source: 'core/validation-execution-lock',
    };
  }
  if (status === 'stale') {
    return {
      check: 'validationLock',
      reason: 'validation execution lock appears stale',
      remediation: 'clear stale lock only after confirming the recorded pid is absent',
      source: 'core/validation-execution-lock',
    };
  }
  return null;
}

function statusFromIssues(blocking: readonly LifecycleControlIssue[], advisory: readonly LifecycleControlIssue[]): RuntimeClosureRow['status'] {
  if (blocking.length > 0) return 'red';
  if (advisory.length > 0) return 'yellow';
  return 'green';
}

function aggregate(rows: readonly RuntimeClosureRow[]): RuntimeClosureReport['aggregate'] {
  if (rows.some((row) => row.status === 'red')) return 'red';
  if (rows.some((row) => row.status === 'yellow' || row.status === 'unknown')) return 'yellow';
  return 'green';
}

export function projectRuntimeClosure(
  store: StoryStore,
  root: string,
  options: RuntimeClosureOptions = {},
): RuntimeClosureReport {
  const now = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const localProjection = resolveLocalAssuranceStories(store, root, {
    activeOnly: options.activeOnly,
    storyIds: options.storyIds ? [...options.storyIds] : undefined,
    now,
  });
  const rows: RuntimeClosureRow[] = localProjection.stories.map((story) => {
    const blockingItems: LifecycleControlIssue[] = [];
    const advisoryItems: LifecycleControlIssue[] = [];
    const mirrorDrift = story.mirrorPhase !== story.activePhase;
    if (mirrorDrift) {
      advisoryItems.push({
        check: 'phaseCoherence',
        reason: `main mirror phase ${story.mirrorPhase} differs from active worktree phase ${story.activePhase}`,
        remediation: `run subsequent story-scoped commands from ${story.activeCwd}`,
        source: 'local_assurance_story_projection',
      });
    }

    let nextSafeAction = story.stateSource === 'worktree' ? `cd ${story.activeCwd}` : undefined;
    try {
      const readiness = buildStoryReadinessReport({
        storyId: story.storyId,
        target: targetForPhase(story.activePhase),
        store,
        root,
        gitCwd: story.activeCwd,
      });
      for (const row of readiness.readiness) {
        const issue: LifecycleControlIssue = {
          check: row.id,
          reason: row.reason,
          remediation: row.nextCommand,
          source: row.source,
        };
        if (row.blocking) blockingItems.push(issue);
        else if (row.status !== 'pass') advisoryItems.push(issue);
      }
      nextSafeAction ??= readiness.next[0]?.command ?? readiness.next[0]?.reason;
    } catch (err) {
      advisoryItems.push({
        check: 'lifecycleReadiness',
        reason: err instanceof Error ? err.message : String(err),
        remediation: 'run lifecycle_check for detailed readiness rows',
        source: 'lifecycle_check',
      });
    }

    const locks: RuntimeClosureRow['locks'] = {
      ownerLease: ownerLeaseStatus(store, story.storyId, Number.isFinite(nowMs) ? nowMs : Date.now()),
      mainWriteLock: mainWriteLockStatus(root, Number.isFinite(nowMs) ? nowMs : Date.now()),
      validationLock: validationLockStatus(root, story.storyId, Number.isFinite(nowMs) ? nowMs : Date.now(), options.currentValidationStoryId),
    };
    const ownerIssue = ownerLeaseIssue(locks.ownerLease);
    if (ownerIssue) advisoryItems.push(ownerIssue);
    const validationIssue = validationLockIssue(locks.validationLock);
    if (validationIssue) {
      if (locks.validationLock === 'active') blockingItems.push(validationIssue);
      else advisoryItems.push(validationIssue);
    }
    if (locks.mainWriteLock === 'active') {
      advisoryItems.push({
        check: 'mainWriteLock',
        reason: 'main write lock is currently active',
        remediation: 'wait for shared main/B-META operation to finish',
        source: 'core/main-write-lock',
      });
    }

    return {
      lane: 'runtime',
      storyId: story.storyId,
      status: statusFromIssues(blockingItems, advisoryItems),
      authority: story.stateSource,
      authoritativeCwd: story.activeCwd,
      phase: story.activePhase,
      mirrorPhase: story.mirrorPhase,
      source: 'runtime-projection',
      nextSafeAction,
      blockingItems,
      advisoryItems,
      locks,
    };
  });

  return {
    schemaVersion: 'lattice.runtime_closure_status.v1',
    readOnly: true,
    generatedAt: now,
    projectRoot: root,
    source: 'runtime-projection',
    stories: rows,
    aggregate: aggregate(rows),
  };
}
