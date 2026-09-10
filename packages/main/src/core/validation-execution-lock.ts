import { VALIDATION_EXECUTION_RUNTIME_REQUIREMENTS, MACHINE_FIXED_PORT_RUNTIME_POLICY } from './runtime-fact-registry.js';
import { withSharedValidationExecutions, type SharedValidationExecutionContext } from './shared-validation-execution.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname, networkInterfaces, userInfo } from 'node:os';
import { createServer } from 'node:net';
import { MACHINE_FIXED_PORT_ARTIFACT } from './runtime-artifact-registry.js';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  acquireMkdirLock,
  type AcquiredMkdirLock,
  type ExistingMkdirLockSnapshot,
  type MkdirLockHolderInfo,
  readMkdirLockHolder,
} from './mkdir-lock.js';
import { canonicalizeEntries, claimsConflict, validateResourceClaims, MAX_JOBS, type ResourceClaim } from './keyed-scheduler.js';
import { withOwnerLeaseHeartbeat, type OwnerLeaseHeartbeatOptions } from './story-owner-lease.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';

export const VALIDATION_EXECUTION_LOCKS_REL = `${PROOF_OR_STOP_DIR}/locks/validation`;
export const VALIDATION_EXECUTION_LOCK_STALE_MS = 120000;
export const VALIDATION_EXECUTION_LOCK_HEARTBEAT_MS = 2000;
export const VALIDATION_EXECUTION_LOCK_HEARTBEAT_FILE = 'heartbeat.json';
export const VALIDATION_CAPACITY_LOCK_REL = `${PROOF_OR_STOP_DIR}/locks/validation-capacity.lock`;
export const VALIDATION_CAPACITY_WAIT_POLL_MS = 100;
export const VALIDATION_CAPACITY_PROGRESS_INTERVAL_MS = 30000;

// A path alone is not an ownership identity. Detached async work retains its
// AsyncLocalStorage snapshot after its original owner releases; if a later
// owner acquires the same path, a path-only reentrancy check would let that
// stale context enter as the new owner. Bind both the process-visible active
// owner and the async context to the acquisition's never-reused lockId.
const activeValidationLockTokens = new Map<string, Set<string>>();
const validationLockOwnerStore = new AsyncLocalStorage<Map<string, string>>();

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
 * root's gitignored `.proof-or-stop/locks/<category>/`, NEVER under the git-tracked
 * story metadata dir (`.proof-or-stop/story/actives/<id>/`).
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
 * the lock (a) live under the ALREADY-gitignored `.proof-or-stop/locks/` prefix, (b)
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
  return join(sharedRoot, PROOF_OR_STOP_DIR, 'locks', category, `${sanitizeLockSegment(id)}-${name}.lock`);
}

function currentContextOwns(lockKey: string): boolean {
  const token = validationLockOwnerStore.getStore()?.get(lockKey);
  return token !== undefined && activeValidationLockTokens.get(lockKey)?.has(token) === true;
}

function extendedOwnerTokens(lockKey: string, acquisitionToken: string): Map<string, string> {
  const current = validationLockOwnerStore.getStore();
  const next = current ? new Map(current) : new Map<string, string>();
  next.set(lockKey, acquisitionToken);
  return next;
}

function clearActiveValidationLockToken(lockKey: string, acquisitionToken: string): void {
  const tokens = activeValidationLockTokens.get(lockKey);
  tokens?.delete(acquisitionToken);
  if (tokens?.size === 0) activeValidationLockTokens.delete(lockKey);
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
function resolveGitCommonLockRoot(root: string): string {
  const projectRoot = String(root ?? '').trim();
  if (!projectRoot) throw new Error('git-common-dir lock identity requires a workspace root');
  const commonDirRaw = execFileSync('git', ['-C', projectRoot, 'rev-parse', '--git-common-dir'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
  }).trim();
  if (!commonDirRaw) throw new Error(`git-common-dir lock identity is empty for ${projectRoot}`);
  const commonDirAbs = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(projectRoot, commonDirRaw);
  const commonDir = realpathSync(commonDirAbs);
  return basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
}

export function resolveSharedLockRoot(root: string): string {
  const projectRoot = String(root ?? '').trim();
  if (!projectRoot) return projectRoot;
  try {
    return resolveGitCommonLockRoot(projectRoot);
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

export function validationCapacityLockPath(workspaceRoot: string, requireGitIdentity = false): string {
  const canonicalWorkspace = String(workspaceRoot ?? '').trim();
  if (!canonicalWorkspace) throw new Error('validationCapacityLockPath: workspaceRoot is required');
  let sharedRoot: string;
  try {
    sharedRoot = resolveGitCommonLockRoot(canonicalWorkspace);
  } catch (error) {
    if (requireGitIdentity) {
      throw new Error(
        `workspace validation capacity cannot resolve git-common-dir identity for ${canonicalWorkspace}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    sharedRoot = canonicalWorkspace;
  }
  return join(sharedRoot, VALIDATION_CAPACITY_LOCK_REL);
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
  return `${prefix} by another Proof-or-Stop process (holder details unavailable), ${heartbeat}. ${retry}`;
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

const activeCapacityDeclarations = new Map<string, CapacityResourceDeclaration | null>();

interface CapacityResourceDeclaration {
  schema: 'validation-capacity-resources.v1';
  maxConcurrent: number;
  resources: ResourceClaim[];
}

export interface ValidationCapacityLockOptions {
  /** Omitted/empty declarations retain exclusive legacy admission. */
  resources?: ResourceClaim[];
  maxConcurrent?: number;
  root: string;
  workspaceRoot: string;
  requireGitIdentity?: boolean;
  command: string;
  storyId?: string;
  staleMs?: number;
  pollMs?: number;
  progressIntervalMs?: number;
  abortSignal?: AbortSignal;
  deadlineAt?: number;
  deadlineError?: () => Error;
  onWaitProgress?: (message: string) => void;
  externalCancellation?: () => string | undefined;
}

export interface OfficialValidationExecutionOptions extends ValidationCapacityLockOptions {
  sharedExecution?: SharedValidationExecutionContext;
  ownerLeaseDir?: string;
  ownerLeaseHeartbeat?: OwnerLeaseHeartbeatOptions;
}

function capacityDeadlineError(options: ValidationCapacityLockOptions): Error {
  return options.deadlineError?.() ?? new Error('workspace validation capacity wait deadline exceeded');
}

function assertCapacityWaitActive(options: ValidationCapacityLockOptions): void {
  const external = options.externalCancellation?.();
  if (external) throw new Error(external);
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

interface ValidationCapacityCandidate {
  path: string;
  name: string;
  holder: MkdirLockHolderInfo | null;
  ageMs: number;
}

function capacityCandidates(
  lockRoot: string,
  suffix: '.choosing' | '.ticket',
): ValidationCapacityCandidate[] {
  let names: string[];
  try {
    names = readdirSync(lockRoot).filter(name => name.endsWith(suffix));
  } catch {
    return [];
  }
  return names.flatMap((name): ValidationCapacityCandidate[] => {
    const path = join(lockRoot, name);
    try {
      return [{
        path,
        name,
        holder: readMkdirLockHolder(path),
        ageMs: Math.max(0, Date.now() - statSync(path).mtimeMs),
      }];
    } catch {
      return [];
    }
  });
}

/**
 * Move one never-reused ticket to a unique quarantine before deleting it.
 * The canonical capacity root is never recursively removed, and a successor
 * always owns another UUID path, so stale-A cleanup cannot delete live-B.
 */
function quarantineValidationCapacityCandidate(candidatePath: string, reason: 'release' | 'stale'): boolean {
  const quarantinePath = `${candidatePath}.${reason}-${process.pid}-${randomUUID()}.quarantine`;
  try {
    renameSync(candidatePath, quarantinePath);
  } catch {
    return false;
  }
  try {
    rmSync(quarantinePath, { recursive: true, force: true });
  } catch {
    // Atomic isolation is the ownership boundary. A quarantine cleanup failure
    // may leak ignored runtime debris, but it cannot leave a live queue ticket.
  }
  return true;
}

function markValidationCapacityTicketReleased(ticketPath: string, holder: MkdirLockHolderInfo): boolean {
  try {
    writeValidationHeartbeat(ticketPath, {
      ...holder,
      lockId: `${holder.lockId ?? 'unknown'}-released-${randomUUID()}`,
    });
    const now = new Date();
    utimesSync(ticketPath, now, now);
    return true;
  } catch {
    return false;
  }
}

async function releaseValidationCapacityTicket(ticketPath: string, holder: MkdirLockHolderInfo): Promise<void> {
  const retryCount = 3;
  for (let attempt = 1; attempt <= retryCount; attempt += 1) {
    if (quarantineValidationCapacityCandidate(ticketPath, 'release')) return;
    if (!existsSync(ticketPath)) return;
    if (attempt < retryCount) {
      await new Promise<void>(resolveRetry => setTimeout(resolveRetry, 20));
    }
  }
  const markedReclaimable = markValidationCapacityTicketReleased(ticketPath, holder);
  if (!existsSync(ticketPath)) return;
  throw new Error(
    `workspace validation capacity release failed after ${retryCount} ownership-safe attempts for ${ticketPath}; ` +
    (markedReclaimable
      ? 'the exact ticket was marked released for mechanical successor recovery'
      : 'the exact ticket remains fail-closed and requires filesystem repair'),
  );
}

function activeCapacityCandidates(
  lockRoot: string,
  suffix: '.choosing' | '.ticket',
  staleMs: number,
): ValidationCapacityCandidate[] {
  const active: ValidationCapacityCandidate[] = [];
  for (const candidate of capacityCandidates(lockRoot, suffix)) {
    const classification = classifyValidationCapacityLock({
      lockDir: candidate.path,
      holder: candidate.holder,
      ageMs: candidate.ageMs,
      staleMs,
      nowMs: Date.now(),
    });
    if (classification !== 'stale') {
      active.push(candidate);
      continue;
    }
    // The ticket path contains a UUID and is never reused. Rename atomically
    // isolates exactly the candidate that was classified; failure means its
    // owner/reclaimer already moved it, so there is nothing for us to delete.
    if (!quarantineValidationCapacityCandidate(candidate.path, 'stale') && existsSync(candidate.path)) {
      // A failed isolation that still exists is not reclaimed. Treat it as
      // active and fail closed; only a successful rename proves this caller
      // owns the exact directory it is about to delete.
      active.push(candidate);
    }
  }
  return active;
}

function capacityDeclaration(options: ValidationCapacityLockOptions): CapacityResourceDeclaration | null {
  const maxConcurrent = options.maxConcurrent ?? 1;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > MAX_JOBS) {
    throw new Error(`validation maxConcurrent must be an integer between 1 and ${MAX_JOBS}`);
  }
  if (options.resources === undefined) return null;
  if (!Array.isArray(options.resources)) throw new Error('validation resources must be an array');
  const resources = canonicalizeEntries([{ name: options.command, resources: options.resources }], options.workspaceRoot)[0]!.resources;
  return resources.length ? { schema: 'validation-capacity-resources.v1', maxConcurrent, resources } : null;
}

function readCapacityDeclaration(path: string): CapacityResourceDeclaration | null {
  try {
    const value = JSON.parse(readFileSync(join(path, 'resources.json'), 'utf8')) as CapacityResourceDeclaration;
    if (value.schema !== 'validation-capacity-resources.v1' || !Number.isSafeInteger(value.maxConcurrent)
      || value.maxConcurrent < 1 || value.maxConcurrent > MAX_JOBS || !Array.isArray(value.resources)
      || value.resources.length === 0) return null;
    validateResourceClaims(value.resources, 'capacity ticket');
    if (value.resources.some(claim => typeof claim.canonicalKey !== 'string' || !claim.canonicalKey)) return null;
    return value;
  } catch { return null; } // Old or malformed tickets remain globally exclusive.
}

function capacityTicketAdmitted(tickets: Array<{ path: string }>, ticketPath: string): boolean {
  const index = tickets.findIndex(ticket => ticket.path === ticketPath);
  if (index < 0) return false;
  if (index === 0) return true;
  const own = readCapacityDeclaration(ticketPath);
  if (!own || index >= own.maxConcurrent) return false;
  // Count every earlier ticket, including blocked ones. Admission never evicts
  // an active owner, and a later arrival cannot pass an earlier conflicting job.
  for (const ticket of tickets.slice(0, index)) {
    const earlier = readCapacityDeclaration(ticket.path);
    if (!earlier || index >= earlier.maxConcurrent || claimsConflict({ name: 'current', resources: own.resources }, { name: 'earlier', resources: earlier.resources })) return false;
  }
  return true;
}

function createValidationCapacityCandidate(path: string, holder: MkdirLockHolderInfo, declaration: CapacityResourceDeclaration | null): void {
  // A `.choosing` name is queue-visible, so never publish it before its
  // identity is complete. A process killed while preparing leaves only an
  // ignored, never-reused private path; the atomic rename is the publication.
  const preparingPath = `${path}.${process.pid}-${randomUUID()}.preparing`;
  mkdirSync(preparingPath);
  try {
    writeFileSync(join(preparingPath, 'holder.json'), JSON.stringify(holder, null, 2) + '\n', 'utf8');
    if (declaration) writeFileSync(join(preparingPath, 'resources.json'), JSON.stringify(declaration) + '\n', 'utf8');
    writeValidationHeartbeat(preparingPath, holder);
    renameSync(preparingPath, path);
  } catch (error) {
    quarantineValidationCapacityCandidate(preparingPath, 'release');
    throw error;
  }
}

/**
 * Acquire one capacity lease per git-common-dir without blocking the event
 * loop. Never-reused UUID tickets make classification identity-stable;
 * contention is retried with an awaited, abortable timer so the active
 * holder's heartbeat remains live.
 */
export async function withWorkspaceValidationCapacity<T>(
  options: ValidationCapacityLockOptions,
  fn: () => Promise<T> | T,
): Promise<T> {
  return withValidationCapacityQueue(options, fn, validationCapacityLockPath(options.workspaceRoot, options.requireGitIdentity === true));
}

/** Same-user machine resources are acquired only by actual command executors. */
export async function withMachineFixedPorts<T>(options: ValidationCapacityLockOptions, fn: () => Promise<T> | T): Promise<T> {
  return withMachineValidationResources(options, fn);
}

export async function withMachineValidationResources<T>(options: ValidationCapacityLockOptions, fn: () => Promise<T> | T): Promise<T> {
  const declared = options.resources !== undefined;
  if (declared && !Array.isArray(options.resources)) throw new Error('machine resources must be an array');
  const normalized = declared ? canonicalizeEntries([{ name: options.command, resources: options.resources! }], options.workspaceRoot)[0]!.resources : [];
  const machineResources = normalized.filter(claim => claim.class === 'fixed-port' || claim.class === 'machine-cpu' || claim.class === 'machine-process');
  const home = userInfo().homedir;
  const lockKey = join(home, PROOF_OR_STOP_DIR, 'locks', MACHINE_FIXED_PORT_ARTIFACT.directoryName);
  mkdirSync(lockKey, { recursive: true, mode: MACHINE_FIXED_PORT_RUNTIME_POLICY.directoryMode });
  const metadata = lstatSync(lockKey);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (process.platform !== 'win32' && (metadata.uid !== userInfo().uid || (metadata.mode & 0o077) !== 0))) throw new Error('machine resource lock root must be a private owned directory');
  // Every classified executor participates in the same queue, even when its
  // explicit machine footprint is empty. A null declaration is globally
  // exclusive, including against tickets written by earlier runtimes.
  const claims = declared ? canonicalizeEntries([{ name: options.command, resources: [
    { class: 'machine-validation', key: MACHINE_FIXED_PORT_RUNTIME_POLICY.barrierKey, access: 'shared' }, ...machineResources,
  ] }], options.workspaceRoot)[0]!.resources : undefined;
  const nested = currentContextOwns(lockKey);
  const held = nested ? activeCapacityDeclarations.get(validationLockOwnerStore.getStore()!.get(lockKey)!) : undefined;
  return withValidationCapacityQueue({ ...options, resources: claims, maxConcurrent: MAX_JOBS,
    deadlineAt: options.deadlineAt ?? Date.now() + MACHINE_FIXED_PORT_RUNTIME_POLICY.queueDeadlineMs }, async () => {
    // A dead queue owner cannot prove its detached child released a socket.
    // Probe exclusive ports before any new heavy child; busy external listeners
    // fail closed too. Shared claims may intentionally consume an existing service.
    for (const claim of (claims ?? []).filter(claim => claim.class === 'fixed-port' && claim.access === 'exclusive')) {
      if (nested && held?.resources.some(prior => prior.canonicalKey === claim.canonicalKey && prior.access === 'exclusive')) continue;
      await probeMachineFixedPort(Number(claim.key));
      assertCapacityWaitActive(options);
    }
    return await fn();
  }, lockKey, true);
}

function machinePortAncestorPids(): Set<number> {
  const text = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 1000, maxBuffer: 8 * 1024 * 1024 });
  const parents = new Map<number, number>();
  for (const line of text.trim().split('\n')) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    if (Number.isSafeInteger(pid) && Number.isSafeInteger(parent)) parents.set(pid!, parent!);
  }
  const ancestors = new Set<number>();
  let parent = parents.get(process.pid);
  while (parent && !ancestors.has(parent)) { ancestors.add(parent); parent = parents.get(parent); }
  return ancestors;
}

async function probeMachineFixedPort(port: number): Promise<void> {
  // On macOS a wildcard socket may coexist with a specific-address listener.
  // Probe concrete local addresses too; a wildcard bind alone proves too little.
  const addresses = new Set(['127.0.0.1', '::1', '0.0.0.0', '::']);
  for (const [name, entries] of Object.entries(networkInterfaces())) for (const entry of entries ?? []) {
    addresses.add(entry.family === 'IPv6' && entry.scopeid ? `${entry.address}%${name}` : entry.address);
  }
  for (const address of addresses) await probeMachineFixedPortAddress(port, address);
}

async function probeMachineFixedPortAddress(port: number, host: string): Promise<void> {
  await new Promise<void>((resolveProbe, rejectProbe) => {
    const server = createServer();
    const timer = setTimeout(() => { server.close(); rejectProbe(new Error(`machine fixed-port ${port} preflight timed out`)); }, MACHINE_FIXED_PORT_RUNTIME_POLICY.probeTimeoutMs);
    server.once('error', error => { clearTimeout(timer); rejectProbe(new Error(`machine fixed-port ${port} unavailable before child launch: ${error.message}`)); });
    server.listen({ port, host, exclusive: true }, () => server.close(error => {
      clearTimeout(timer); if (error) rejectProbe(error); else resolveProbe();
    }));
  });
}

async function withValidationCapacityQueue<T>(options: ValidationCapacityLockOptions, fn: () => Promise<T> | T, lockKey: string, rejectAncestorConflict = false): Promise<T> {
  const command = String(options.command ?? '').trim() || 'validate';
  const storyId = String(options.storyId ?? '').trim();
  const declaration = capacityDeclaration(options);
  if (currentContextOwns(lockKey)) {
    const token = validationLockOwnerStore.getStore()!.get(lockKey)!;
    const held = activeCapacityDeclarations.get(token);
    if (held && (!declaration || declaration.resources.some(claim => !held.resources.some(existing =>
      existing.canonicalKey === claim.canonicalKey && (existing.access === 'exclusive' || claim.access === 'shared'))))) {
      throw new Error('nested validation cannot expand held capacity resources');
    }
    return await fn();
  }

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
  const staleMs = options.staleMs ?? VALIDATION_EXECUTION_LOCK_STALE_MS;
  mkdirSync(lockKey, { recursive: true });
  const choosingPath = join(lockKey, `${holderInfo.lockId}.choosing`);
  let ticketPath = '';
  let ancestors: Set<number> | undefined;
  createValidationCapacityCandidate(choosingPath, holderInfo, declaration);
  try {
    const existingNumbers = capacityCandidates(lockKey, '.ticket')
      .map(candidate => Number(candidate.name.slice(0, candidate.name.indexOf('-'))))
      .filter(Number.isFinite);
    const number = (existingNumbers.length > 0 ? Math.max(...existingNumbers) : 0) + 1;
    ticketPath = join(lockKey, `${String(number).padStart(16, '0')}-${holderInfo.lockId}.ticket`);
    renameSync(choosingPath, ticketPath);

    while (true) {
      assertCapacityWaitActive(options);
      const choosing = activeCapacityCandidates(lockKey, '.choosing', staleMs);
      const tickets = activeCapacityCandidates(lockKey, '.ticket', staleMs)
        .sort((a, b) => a.name.localeCompare(b.name));
      if (choosing.length === 0 && capacityTicketAdmitted(tickets, ticketPath)) break;
      if (rejectAncestorConflict) {
        for (const candidate of tickets.filter(candidate => candidate.path !== ticketPath && candidate.holder?.hostname === hostname())) {
          const prior = readCapacityDeclaration(candidate.path);
          if (prior && declaration && !claimsConflict({ name: command, resources: declaration.resources }, { name: 'prior', resources: prior.resources })) continue;
          if (candidate.holder && candidate.holder.pid !== process.pid) {
            ancestors ??= machinePortAncestorPids();
            if (ancestors.has(candidate.holder.pid)) throw new Error('nested machine resource acquisition conflicts with an ancestor; declare machine resources on their actual leaf command only');
          }
        }
      }
      const now = Date.now();
      if (now - lastProgressAt >= progressIntervalMs) {
        lastProgressAt = now;
        const activeHolder = tickets[0] ?? choosing[0];
        try {
          options.onWaitProgress?.(activeHolder
            ? buildCapacityWaitMessage(options, activeHolder.path)
            : 'waiting for workspace validation capacity: holder transition in progress, heartbeat unavailable');
        } catch {
          /* Progress is descriptive and must not change lock ownership. */
        }
      }
      await waitForCapacityRetry(options, pollMs);
    }
  } catch (error) {
    // Preserve the original abort/deadline/acquisition classification. Cleanup
    // is still ownership-safe and bounded: each published unique path gets the
    // same retry + released-marker treatment as an acquired owner. A cleanup
    // failure is intentionally secondary to the original wait failure.
    for (const candidatePath of [ticketPath, choosingPath]) {
      if (!candidatePath || !existsSync(candidatePath)) continue;
      try {
        await releaseValidationCapacityTicket(candidatePath, holderInfo);
      } catch {
        /* Original wait/acquisition error remains authoritative. */
      }
    }
    throw error;
  }

  const acquisitionToken = holderInfo.lockId!;
  activeValidationLockTokens.set(lockKey, new Set([...(activeValidationLockTokens.get(lockKey) ?? []), acquisitionToken]));
  activeCapacityDeclarations.set(acquisitionToken, declaration);
  const heartbeat = startHeartbeat({ lockDir: ticketPath, release: () => undefined }, holderInfo);
  let callbackFailed = false;
  let callbackError: unknown;
  let callbackResult: T | undefined;
  try {
    assertCapacityWaitActive(options);
    callbackResult = await validationLockOwnerStore.run(
      extendedOwnerTokens(lockKey, acquisitionToken),
      async () => await fn(),
    );
  } catch (error) {
    callbackFailed = true;
    callbackError = error;
  }
  clearInterval(heartbeat);
  clearActiveValidationLockToken(lockKey, acquisitionToken);
  activeCapacityDeclarations.delete(acquisitionToken);
  let releaseError: unknown;
  try {
    await releaseValidationCapacityTicket(ticketPath, holderInfo);
  } catch (error) {
    releaseError = error;
  }
  if (callbackFailed) throw callbackError;
  if (releaseError) throw releaseError;
  return callbackResult as T;
}

/** Fixed acquisition order for official validators: workspace capacity first,
 * then the existing per-story evidence lock when a story id is present. */
export async function withOfficialValidationExecution<T>(
  options: OfficialValidationExecutionOptions,
  fn: () => Promise<T> | T,
): Promise<T> {
  const execute = () => withSharedValidationExecutions(options.sharedExecution, () => withWorkspaceValidationCapacity(options, async () => {
    const storyId = String(options.storyId ?? '').trim();
    if (!storyId) return await fn();
    return await withValidationExecutionLock({
      root: options.root,
      storyId,
      workspaceRoot: options.workspaceRoot,
      command: options.command,
      staleMs: options.staleMs,
    }, fn);
  }));
  return options.ownerLeaseDir
    ? withOwnerLeaseHeartbeat(options.ownerLeaseDir, { command: options.command, cwd: options.workspaceRoot, ...options.ownerLeaseHeartbeat }, execute)
    : execute();
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

  if (currentContextOwns(lockKey)) {
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
  const acquisitionToken = holderInfo.lockId!;
  activeValidationLockTokens.set(lockKey, new Set([...(activeValidationLockTokens.get(lockKey) ?? []), acquisitionToken]));
  const heartbeat = startHeartbeat(lock, holderInfo);
  try {
    return await validationLockOwnerStore.run(
      extendedOwnerTokens(lockKey, acquisitionToken),
      async () => await fn(),
    );
  } finally {
    clearInterval(heartbeat);
    clearActiveValidationLockToken(lockKey, acquisitionToken);
    lock.release();
  }
}


/** Whole official invocations can overlap only when every child declares its
 * resources. The workspace claim also protects metadata and build preparation. */
export function declaredValidationCapacity(
  commands: Array<{ label: string; cwd?: string; resources?: ResourceClaim[] }>, workspaceRoot: string,
): Pick<ValidationCapacityLockOptions, 'resources' | 'maxConcurrent'> {
  if (!commands.length || commands.some(command => !command.resources?.length)) return {};
  const resources: ResourceClaim[] = [{ class: 'fixed-path', key: resolve(workspaceRoot), access: 'exclusive' }];
  for (const command of commands) {
    const cwd = resolve(workspaceRoot, command.cwd ?? '.');
    validateResourceClaims(command.resources!, command.label);
    for (const claim of command.resources!) resources.push({
      class: claim.class, key: claim.class === 'fixed-port' ? claim.key : resolve(cwd, claim.key),
      access: claim.access, ...(claim.ownership ? { ownership: claim.ownership } : {}),
    });
  }
  // Duplicate normalized claims carry no additional permission or capacity.
  // Preserve access, ownership and resolved cwd; validate every input before dedup.
  const distinctResources = [...new Map(resources.map(claim => [JSON.stringify(claim), claim])).values()];
  return { resources: distinctResources, maxConcurrent: VALIDATION_EXECUTION_RUNTIME_REQUIREMENTS.declaredInvocationCapacity };
}
