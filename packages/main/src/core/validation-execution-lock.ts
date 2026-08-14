import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  acquireMkdirLock,
  type AcquiredMkdirLock,
  type ExistingMkdirLockSnapshot,
  type MkdirLockHolderInfo,
  readMkdirLockHolder,
} from './mkdir-lock.js';
import { LATTICE_DIR } from './lattice-paths.js';

export const VALIDATION_EXECUTION_LOCKS_REL = `${LATTICE_DIR}/locks/validation`;
export const VALIDATION_EXECUTION_LOCK_STALE_MS = 120000;
export const VALIDATION_EXECUTION_LOCK_HEARTBEAT_MS = 2000;
export const VALIDATION_EXECUTION_LOCK_HEARTBEAT_FILE = 'heartbeat.json';
export const VALIDATION_CAPACITY_LOCK_REL = `${LATTICE_DIR}/locks/validation-capacity.lock`;
export const VALIDATION_CAPACITY_WAIT_POLL_MS = 100;
export const VALIDATION_CAPACITY_PROGRESS_INTERVAL_MS = 30000;

const heldValidationLockPaths = new Set<string>();
const validationLockOwnerStore = new AsyncLocalStorage<Set<string>>();

interface ValidationLockHeartbeatInfo {
  lockId: string;
  pid: number;
  hostname: string;
  processStartTimeMs?: number;
  heartbeatAt: string;
}

export function sanitizeLockSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

/**
 * B-d877 R3 FIX B: resolve a per-story RUNTIME lock dir under the DURABLE shared
 * root's gitignored `.lattice/locks/<category>/`, NEVER under the git-tracked
 * story metadata dir (`.lattice/story/actives/<id>/`).
 *
 * The universal-lockId change (R2 FIX D) writes a `holder.json` inside EVERY
 * acquired lock dir. When such a lock lived inside the story dir (e.g.
 * `<storyDir>/review-passes.lock/`), a `git add -A` that ran while the lock was
 * held committed that transient `holder.json`; releasing the lock then deleted
 * it, leaving a `D …/review-passes.lock/holder.json` dirty entry that
 * deterministically failed the clean-tree preflight (quorum-submit-smoke).
 *
 * Anchoring at `resolveSharedLockRoot(root)` (git-common-dir based) — exactly
 * like the validation execution lock and the per-story transition lock — makes
 * the lock (a) live under the ALREADY-gitignored `.lattice/locks/` prefix, (b)
 * survive story-worktree removal, and (c) resolve IDENTICALLY from every
 * worktree/main root so cross-worktree callers contend on ONE mutex. The lock
 * file name embeds BOTH the sanitized story id and the logical `<name>` so
 * distinct per-story locks (checklist / review-passes / review-runs /
 * init-check / prompt-envelopes / process-events append) never collide in the
 * shared category dir. FAIL-OPEN: a non-git / unreadable root falls back to
 * `root` verbatim.
 */
export function storyRuntimeLockPath(
  root: string,
  category: string,
  storyId: string,
  name: string,
): string {
  const projectRoot = String(root ?? '').trim();
  const id = String(storyId ?? '').trim();
  if (!projectRoot) throw new Error('storyRuntimeLockPath: root is required');
  if (!id) throw new Error('storyRuntimeLockPath: storyId is required');
  const sharedRoot = resolveSharedLockRoot(projectRoot);
  return join(sharedRoot, LATTICE_DIR, 'locks', category, `${sanitizeLockSegment(id)}-${name}.lock`);
}

function currentContextOwns(lockKey: string): boolean {
  return validationLockOwnerStore.getStore()?.has(lockKey) ?? false;
}

function extendedOwnerSet(lockKey: string): Set<string> {
  const current = validationLockOwnerStore.getStore();
  const next = current ? new Set(current) : new Set<string>();
  next.add(lockKey);
  return next;
}

function currentProcessStartTimeMs(): number {
  return Math.floor(Date.now() - (process.uptime() * 1000));
}

function pidAppearsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

function readValidationLockHeartbeat(lockDir: string): ValidationLockHeartbeatInfo | null {
  try {
    const raw = readFileSync(join(lockDir, VALIDATION_EXECUTION_LOCK_HEARTBEAT_FILE), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    const lockId = typeof obj.lockId === 'string' ? obj.lockId : '';
    const pid = typeof obj.pid === 'number' ? obj.pid : NaN;
    const host = typeof obj.hostname === 'string' ? obj.hostname : '';
    const heartbeatAt = typeof obj.heartbeatAt === 'string' ? obj.heartbeatAt : '';
    const processStartTimeMs = typeof obj.processStartTimeMs === 'number' && Number.isFinite(obj.processStartTimeMs)
      ? obj.processStartTimeMs
      : undefined;
    if (!lockId || !Number.isFinite(pid) || !host || !heartbeatAt) return null;
    return {
      lockId,
      pid,
      hostname: host,
      heartbeatAt,
      ...(processStartTimeMs !== undefined ? { processStartTimeMs } : {}),
    };
  } catch {
    return null;
  }
}

function sameProcessStart(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) return true;
  return Math.abs(a - b) <= 2000;
}

function heartbeatLooksMismatched(holder: MkdirLockHolderInfo, heartbeat: ValidationLockHeartbeatInfo | null): boolean {
  if (!heartbeat) return false;
  if (holder.lockId && heartbeat.lockId !== holder.lockId) return true;
  if (heartbeat.pid !== holder.pid) return true;
  if (heartbeat.hostname !== holder.hostname) return true;
  if (!sameProcessStart(holder.processStartTimeMs, heartbeat.processStartTimeMs)) return true;
  return false;
}

function heartbeatAgeMs(heartbeat: ValidationLockHeartbeatInfo | null, nowMs: number): number | null {
  if (!heartbeat) return null;
  const parsed = Date.parse(heartbeat.heartbeatAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, nowMs - parsed);
}

export function classifyValidationExecutionLock(snapshot: ExistingMkdirLockSnapshot): 'active' | 'stale' | 'unknown' {
  if (snapshot.ageMs > snapshot.staleMs) return 'stale';
  const holder = snapshot.holder;
  if (!holder) return 'unknown';

  const heartbeat = readValidationLockHeartbeat(snapshot.lockDir);
  if (heartbeatLooksMismatched(holder, heartbeat)) return 'stale';
  const beatAge = heartbeatAgeMs(heartbeat, snapshot.nowMs);
  if (beatAge !== null && beatAge > snapshot.staleMs) return 'stale';

  const localHost = hostname();
  if (holder.hostname === localHost && !pidAppearsAlive(holder.pid)) return 'stale';
  if (
    holder.hostname === localHost &&
    holder.pid === process.pid &&
    !sameProcessStart(holder.processStartTimeMs, currentProcessStartTimeMs())
  ) {
    return 'stale';
  }
  return 'active';
}

/**
 * Workspace capacity is stricter than the legacy story-evidence lock. A lease
 * is reclaimable only when local process identity or holder/heartbeat identity
 * mechanically proves that the recorded owner cannot still own it. Age,
 * missing metadata, malformed metadata, and an old heartbeat are never enough.
 */
export function classifyValidationCapacityLock(snapshot: ExistingMkdirLockSnapshot): 'active' | 'stale' {
  const holder = snapshot.holder;
  if (!holder) return 'active';
  const heartbeat = readValidationLockHeartbeat(snapshot.lockDir);
  if (heartbeatLooksMismatched(holder, heartbeat)) return 'stale';
  const localHost = hostname();
  if (holder.hostname === localHost && !pidAppearsAlive(holder.pid)) return 'stale';
  if (
    holder.hostname === localHost &&
    holder.pid === process.pid &&
    !sameProcessStart(holder.processStartTimeMs, currentProcessStartTimeMs())
  ) {
    return 'stale';
  }
  return 'active';
}

/**
 * Resolve the canonical, worktree-independent repository root that anchors
 * story-scoped coordination state (validation locks). Two linked worktrees of
 * the same repository must share ONE lock per story so a validation running in
 * one worktree serializes against a validation in another; keying the lock off
 * each worktree's own physical root (the old behavior) minted DIFFERENT locks
 * and defeated cross-worktree/host serialization.
 *
 * `git rev-parse --git-common-dir` returns the SAME common git dir for the main
 * worktree and every linked worktree (e.g. `<repo>/.git`), so it is the stable
 * shared anchor. On ANY failure (not a git repo, git missing, unusual layout)
 * this falls back to `root` verbatim, keeping plain-repo behavior byte-identical.
 */
export function resolveSharedLockRoot(root: string): string {
  const projectRoot = String(root ?? '').trim();
  if (!projectRoot) return projectRoot;
  try {
    const commonDirRaw = execFileSync('git', ['-C', projectRoot, 'rev-parse', '--git-common-dir'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    if (!commonDirRaw) return projectRoot;
    // `--git-common-dir` is relative to the queried worktree in the main
    // worktree (`.git`) and absolute in linked worktrees; resolve against root.
    const commonDirAbs = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(projectRoot, commonDirRaw);
    const commonDir = realpathSync(commonDirAbs);
    // Normal repos: `<mainRoot>/.git` → the main worktree root, shared by all
    // linked worktrees. Unusual layouts (e.g. a bare repo whose common dir is
    // the repository itself) use the common dir as the shared anchor directly.
    return basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
  } catch {
    return projectRoot;
  }
}

export function validationExecutionLockPath(root: string, storyId: string): string {
  const projectRoot = String(root ?? '').trim();
  const id = String(storyId ?? '').trim();
  if (!projectRoot) throw new Error('validationExecutionLockPath: root is required');
  if (!id) throw new Error('validationExecutionLockPath: storyId is required');
  const sharedRoot = resolveSharedLockRoot(projectRoot);
  return join(sharedRoot, VALIDATION_EXECUTION_LOCKS_REL, `${sanitizeLockSegment(id)}.lock`);
}

export function validationCapacityLockPath(root: string): string {
  const projectRoot = String(root ?? '').trim();
  if (!projectRoot) throw new Error('validationCapacityLockPath: root is required');
  return join(resolveSharedLockRoot(projectRoot), VALIDATION_CAPACITY_LOCK_REL);
}

/**
 * Reclaim a validation lock only when its recorded local holder is provably no
 * longer alive (or the normal heartbeat/age classifier otherwise marks it
 * stale). A live or unknown lock is never removed.
 */
export function reclaimStaleValidationExecutionLock(root: string, storyId: string): boolean {
  const lockPath = validationExecutionLockPath(root, storyId);
  if (!existsSync(lockPath)) return false;
  try {
    const probe = acquireMkdirLock(lockPath, {
      label: 'validation execution stale-lock recovery',
      deadlineMs: 1,
      staleMs: VALIDATION_EXECUTION_LOCK_STALE_MS,
      failFastIfHeld: true,
      classifyExistingLock: classifyValidationExecutionLock,
    });
    probe.release();
    return true;
  } catch {
    return false;
  }
}

function formatLockAge(ageMs: number): string {
  const safe = Number.isFinite(ageMs) && ageMs >= 0 ? ageMs : 0;
  const seconds = Math.floor(safe / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function buildValidationLockContentionMessage(args: {
  storyId: string;
  workspaceRoot: string;
  command: string;
  holder: MkdirLockHolderInfo | null;
  holderAgeMs: number;
}): string {
  const prefix =
    `${args.command} is blocked: validation execution for story ${args.storyId} ` +
    `is already running in ${args.workspaceRoot}`;
  const heartbeat = `heartbeat ${formatLockAge(args.holderAgeMs)} ago`;
  const retry = 'Retry after the active validation finishes; this protects story-scoped validation evidence from concurrent writes.';
  if (args.holder) {
    return (
      `${prefix} by ${args.holder.command} ` +
      `(pid ${args.holder.pid} on ${args.holder.hostname}), ${heartbeat}. ${retry}`
    );
  }
  return `${prefix} by another Proofbound process (holder details unavailable), ${heartbeat}. ${retry}`;
}

function writeValidationHeartbeat(lockDir: string, holder: MkdirLockHolderInfo): void {
  const heartbeat: ValidationLockHeartbeatInfo = {
    lockId: holder.lockId ?? '',
    pid: holder.pid,
    hostname: holder.hostname,
    ...(holder.processStartTimeMs !== undefined ? { processStartTimeMs: holder.processStartTimeMs } : {}),
    heartbeatAt: new Date().toISOString(),
  };
  if (!heartbeat.lockId) return;
  writeFileSync(join(lockDir, VALIDATION_EXECUTION_LOCK_HEARTBEAT_FILE), JSON.stringify(heartbeat, null, 2) + '\n', 'utf8');
}

function startHeartbeat(lock: AcquiredMkdirLock, holder: MkdirLockHolderInfo): ReturnType<typeof setInterval> {
  const beat = () => {
    try {
      writeValidationHeartbeat(lock.lockDir, holder);
      const now = new Date();
      utimesSync(lock.lockDir, now, now);
    } catch {
      /* Descriptive heartbeat only; the held mkdir lock remains authoritative. */
    }
  };
  beat();
  const timer = setInterval(beat, VALIDATION_EXECUTION_LOCK_HEARTBEAT_MS);
  const maybeNodeTimer = timer as ReturnType<typeof setInterval> & { unref?: () => void };
  maybeNodeTimer.unref?.();
  return timer;
}

export interface ValidationExecutionLockOptions {
  root: string;
  storyId: string;
  workspaceRoot: string;
  command: string;
  staleMs?: number;
}

export interface ValidationCapacityLockOptions {
  root: string;
  workspaceRoot: string;
  command: string;
  storyId?: string;
  staleMs?: number;
  pollMs?: number;
  progressIntervalMs?: number;
  abortSignal?: AbortSignal;
  deadlineAt?: number;
  deadlineError?: () => Error;
  onWaitProgress?: (message: string) => void;
}

export interface OfficialValidationExecutionOptions extends ValidationCapacityLockOptions {}

function capacityDeadlineError(options: ValidationCapacityLockOptions): Error {
  return options.deadlineError?.() ?? new Error('workspace validation capacity wait deadline exceeded');
}

function assertCapacityWaitActive(options: ValidationCapacityLockOptions): void {
  if (options.abortSignal?.aborted) {
    throw options.abortSignal.reason instanceof Error
      ? options.abortSignal.reason
      : new Error('workspace validation capacity wait aborted');
  }
  if (typeof options.deadlineAt === 'number' && Number.isFinite(options.deadlineAt) && Date.now() >= options.deadlineAt) {
    throw capacityDeadlineError(options);
  }
}

async function waitForCapacityRetry(options: ValidationCapacityLockOptions, delayMs: number): Promise<void> {
  assertCapacityWaitActive(options);
  const remainingMs = typeof options.deadlineAt === 'number' && Number.isFinite(options.deadlineAt)
    ? Math.max(0, options.deadlineAt - Date.now())
    : delayMs;
  const waitMs = Math.max(1, Math.min(delayMs, remainingMs));
  await new Promise<void>((resolveWait, rejectWait) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.abortSignal?.removeEventListener('abort', onAbort);
      if (error) rejectWait(error);
      else resolveWait();
    };
    const onAbort = () => finish(options.abortSignal?.reason instanceof Error
      ? options.abortSignal.reason
      : new Error('workspace validation capacity wait aborted'));
    const timer = setTimeout(() => finish(), waitMs);
    options.abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (options.abortSignal?.aborted) onAbort();
  });
  assertCapacityWaitActive(options);
}

function buildCapacityWaitMessage(options: ValidationCapacityLockOptions, lockPath: string): string {
  const holder = readMkdirLockHolder(lockPath);
  const heartbeat = readValidationLockHeartbeat(lockPath);
  const beatAge = heartbeatAgeMs(heartbeat, Date.now());
  let lockAge = 0;
  try { lockAge = Math.max(0, Date.now() - statSync(lockPath).mtimeMs); } catch { /* retry race */ }
  const holderText = holder
    ? `${holder.command} (pid ${holder.pid} on ${holder.hostname})`
    : 'unknown holder';
  const heartbeatText = beatAge === null
    ? `heartbeat unavailable; lock age ${formatLockAge(lockAge)}`
    : `heartbeat ${formatLockAge(beatAge)} ago`;
  return `waiting for workspace validation capacity: holder ${holderText}, ${heartbeatText}`;
}

/**
 * Acquire one capacity lease per git-common-dir without blocking the event
 * loop. Each mkdir probe is fail-fast; contention is retried with an awaited,
 * abortable timer so the active holder's heartbeat remains live.
 */
export async function withWorkspaceValidationCapacity<T>(
  options: ValidationCapacityLockOptions,
  fn: () => Promise<T> | T,
): Promise<T> {
  const command = String(options.command ?? '').trim() || 'validate';
  const storyId = String(options.storyId ?? '').trim();
  const lockKey = validationCapacityLockPath(options.root);
  if (heldValidationLockPaths.has(lockKey) && currentContextOwns(lockKey)) return await fn();

  const holderInfo: MkdirLockHolderInfo = {
    lockId: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    command: storyId ? `${command} for ${storyId}` : command,
    acquiredAt: new Date().toISOString(),
    processStartTimeMs: currentProcessStartTimeMs(),
  };
  const pollMs = Math.max(10, options.pollMs ?? VALIDATION_CAPACITY_WAIT_POLL_MS);
  const progressIntervalMs = Math.max(pollMs, options.progressIntervalMs ?? VALIDATION_CAPACITY_PROGRESS_INTERVAL_MS);
  let lastProgressAt = Number.NEGATIVE_INFINITY;
  let lock: AcquiredMkdirLock | null = null;
  while (!lock) {
    assertCapacityWaitActive(options);
    let held = false;
    try {
      lock = acquireMkdirLock(lockKey, {
        label: 'workspace validation capacity',
        deadlineMs: 1,
        staleMs: options.staleMs ?? VALIDATION_EXECUTION_LOCK_STALE_MS,
        failFastIfHeld: true,
        holderInfo,
        requireHolderToken: true,
        ownedAuxFiles: [VALIDATION_EXECUTION_LOCK_HEARTBEAT_FILE],
        classifyExistingLock: classifyValidationCapacityLock,
        onContentionHeld: () => {
          held = true;
          return 'workspace validation capacity is held';
        },
      });
    } catch (error) {
      if (!held) throw error;
      const now = Date.now();
      if (now - lastProgressAt >= progressIntervalMs) {
        lastProgressAt = now;
        try {
          options.onWaitProgress?.(buildCapacityWaitMessage(options, lockKey));
        } catch {
          /* Progress is descriptive and must not change lock ownership. */
        }
      }
      await waitForCapacityRetry(options, pollMs);
    }
  }

  heldValidationLockPaths.add(lockKey);
  const heartbeat = startHeartbeat(lock, holderInfo);
  try {
    assertCapacityWaitActive(options);
    return await validationLockOwnerStore.run(extendedOwnerSet(lockKey), async () => await fn());
  } finally {
    clearInterval(heartbeat);
    heldValidationLockPaths.delete(lockKey);
    lock.release();
  }
}

/** Fixed acquisition order for official validators: workspace capacity first,
 * then the existing per-story evidence lock when a story id is present. */
export async function withOfficialValidationExecution<T>(
  options: OfficialValidationExecutionOptions,
  fn: () => Promise<T> | T,
): Promise<T> {
  return await withWorkspaceValidationCapacity(options, async () => {
    const storyId = String(options.storyId ?? '').trim();
    if (!storyId) return await fn();
    return await withValidationExecutionLock({
      root: options.root,
      storyId,
      workspaceRoot: options.workspaceRoot,
      command: options.command,
      staleMs: options.staleMs,
    }, fn);
  });
}

export async function withValidationExecutionLock<T>(
  options: ValidationExecutionLockOptions,
  fn: () => Promise<T> | T,
): Promise<T> {
  const storyId = String(options.storyId ?? '').trim();
  const command = String(options.command ?? '').trim() || 'validate';
  const workspaceRoot = String(options.workspaceRoot ?? '').trim() || options.root;
  if (!storyId) throw new Error('withValidationExecutionLock: storyId is required');
  const lockKey = validationExecutionLockPath(options.root, storyId);

  if (heldValidationLockPaths.has(lockKey) && currentContextOwns(lockKey)) {
    return await fn();
  }

  const holderInfo: MkdirLockHolderInfo = {
    lockId: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    command: `${command} for ${storyId}`,
    acquiredAt: new Date().toISOString(),
    processStartTimeMs: currentProcessStartTimeMs(),
  };
  const lock = acquireMkdirLock(lockKey, {
    label: 'validation execution',
    staleMs: options.staleMs ?? VALIDATION_EXECUTION_LOCK_STALE_MS,
    failFastIfHeld: true,
    holderInfo,
    // B-d877 R5 FIX 2 (F-016): the heartbeat.json this lock writes INSIDE the lock
    // dir is HOLDER-owned; declare it so the ownership-verified release removes it
    // before the non-recursive dir removal. Otherwise release leaves heartbeat.json
    // behind, rmdirSync fails (dir not empty), and the leaked dir blocks the next
    // validate with a false "already running".
    ownedAuxFiles: [VALIDATION_EXECUTION_LOCK_HEARTBEAT_FILE],
    classifyExistingLock: classifyValidationExecutionLock,
    onContentionHeld: (holder, holderAgeMs) => buildValidationLockContentionMessage({
      storyId,
      workspaceRoot,
      command,
      holder,
      holderAgeMs,
    }),
  });
  heldValidationLockPaths.add(lockKey);
  const heartbeat = startHeartbeat(lock, holderInfo);
  try {
    return await validationLockOwnerStore.run(extendedOwnerSet(lockKey), async () => await fn());
  } finally {
    clearInterval(heartbeat);
    heldValidationLockPaths.delete(lockKey);
    lock.release();
  }
}
