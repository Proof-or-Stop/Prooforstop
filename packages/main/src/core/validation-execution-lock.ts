import { withInheritedMachineReservation, withMachineReservationController, machineReservationResidualsPresent, inheritedValidationReservationPortAlreadyHeld, currentValidationReservationAbortSignal, deadlineTimer } from './validation-reservation-delegation.js';
import { VALIDATION_EXECUTION_RUNTIME_REQUIREMENTS, MACHINE_FIXED_PORT_RUNTIME_POLICY, VALIDATION_RESERVATION_DELEGATION_RUNTIME_POLICY, VALIDATION_RESOURCE_KEY_RUNTIME_POLICY } from './runtime-fact-registry.js';
import { withSharedValidationExecutions, type SharedValidationExecutionContext } from './shared-validation-execution.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  openSync,
  closeSync,
  fstatSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname, networkInterfaces, userInfo } from 'node:os';
import { createServer } from 'node:net';
import { MACHINE_FIXED_PORT_ARTIFACT, VALIDATION_RESERVATION_DELEGATION_ARTIFACT, WORKSPACE_VALIDATION_COORDINATION_ARTIFACT } from './runtime-artifact-registry.js';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  acquireMkdirLock,
  type AcquiredMkdirLock,
  type ExistingMkdirLockSnapshot,
  type MkdirLockHolderInfo,
  readMkdirLockHolder,
  observedProcessStartTimeMs,
} from './mkdir-lock.js';
import { canonicalizeEntries, claimsConflict, validateResourceClaims, MAX_JOBS, type ResourceClaim } from './keyed-scheduler.js';
import { withOwnerLeaseHeartbeat, type OwnerLeaseHeartbeatOptions } from './story-owner-lease.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';

export const VALIDATION_METADATA_WAIT_MS = VALIDATION_EXECUTION_RUNTIME_REQUIREMENTS.metadataWriteWaitMs;
export const VALIDATION_METADATA_GRACE_MS = VALIDATION_EXECUTION_RUNTIME_REQUIREMENTS.metadataValidationGraceMs;

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

/** Read-only generation fence; never acquires or repairs a lost publication lock. */
export function assertCurrentValidationPublicationOwner(root: string, storyId: string): void {
  const frame = invocationStages.getStore();
  if (frame && (!frame.active || frame.executingPlan || !frame.held || !currentContextOwns(frame.commonKey))) {
    throw new Error('VALIDATION_PUBLICATION_CAPACITY_LOST');
  }
  const key = validationExecutionLockPath(root, storyId);
  const token = validationLockOwnerStore.getStore()?.get(key);
  const holder = readMkdirLockHolder(key);
  if (!currentContextOwns(key) || !token || holder?.lockId !== token || holder.pid !== process.pid) {
    throw new Error('VALIDATION_PUBLICATION_OWNER_LOST');
  }
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

// Date.now and uptime use different clock resolutions. Re-estimating can vary
// by a millisecond and split one invocation into multiple capacity groups.
const validationProcessStartTimeMs = Math.floor(Date.now() - (process.uptime() * 1000));
function currentProcessStartTimeMs(): number {
  return validationProcessStartTimeMs;
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

/** Read-only observation of the same holder classifier and generation-bound
 * async ownership used by acquisition. Story IDs and PIDs alone grant nothing. */
export function observeValidationExecutionLock(
  root: string, storyId: string, nowMs = Date.now(),
): 'free' | 'active' | 'stale' | 'unknown' | 'self-reentry' {
  let lockDir: string;
  try { lockDir = validationExecutionLockPath(root, storyId); } catch { return 'unknown'; }
  let ageMs: number;
  try { ageMs = nowMs - statSync(lockDir).mtimeMs; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'free' : 'unknown'; }
  const holder = readMkdirLockHolder(lockDir);
  const snapshot = { lockDir, holder, ageMs, nowMs, staleMs: VALIDATION_EXECUTION_LOCK_STALE_MS };
  const state = holder?.lockClass === 'metadata-write'
    ? classifyValidationMetadataLock(snapshot) : classifyValidationExecutionLock(snapshot);
  const token = validationLockOwnerStore.getStore()?.get(lockDir);
  if (state === 'active' && currentContextOwns(lockDir) && token && holder?.lockId === token && holder.pid === process.pid) {
    return 'self-reentry';
  }
  return state;
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

// Cache only successful Git identities. Recheck the nearest .git entry, its
// real path and linked-worktree commondir on every lookup; init/retarget/remove
// must never reuse an identity from another repository.
const sharedRootCache = new Map<string, { fingerprint: string; sharedRoot: string }>();
function sharedRootFingerprint(root: string): string {
  let dir = realpathSync(root);
  const parts = [dir];
  while (!existsSync(join(dir, '.git'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('no Git entry');
    dir = parent;
  }
  const entry = join(dir, '.git');
  const stat = statSync(entry);
  parts.push(realpathSync(entry), String(stat.dev), String(stat.ino));
  let gitDir = entry;
  if (stat.isFile()) {
    const contents = readFileSync(entry, 'utf8');
    parts.push(contents);
    const match = /^gitdir: (.+)\s*$/.exec(contents.trim());
    if (!match) throw new Error('invalid Git entry');
    gitDir = resolve(dir, match[1]);
  }
  const commonFile = join(gitDir, 'commondir');
  const common = existsSync(commonFile) ? readFileSync(commonFile, 'utf8').trim() : '.';
  const commonDir = realpathSync(resolve(gitDir, common));
  const commonStat = statSync(commonDir);
  parts.push(common, commonDir, String(commonStat.dev), String(commonStat.ino));
  return JSON.stringify(parts);
}
export function resolveSharedLockRoot(root: string): string {
  const projectRoot = String(root ?? '').trim();
  if (!projectRoot) return projectRoot;
  try {
    if (process.env.GIT_DIR || process.env.GIT_COMMON_DIR || process.env.GIT_WORK_TREE) return resolveGitCommonLockRoot(projectRoot);
    const fingerprint = sharedRootFingerprint(projectRoot);
    const cached = sharedRootCache.get(projectRoot);
    if (cached?.fingerprint === fingerprint) return cached.sharedRoot;
    const sharedRoot = resolveGitCommonLockRoot(projectRoot);
    if (sharedRootCache.size >= 128) sharedRootCache.delete(sharedRootCache.keys().next().value!);
    sharedRootCache.set(projectRoot, { fingerprint, sharedRoot });
    return sharedRoot;
  } catch {
    sharedRootCache.delete(projectRoot);
    try { return resolveGitCommonLockRoot(projectRoot); } catch { return projectRoot; }
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

/** Keep one queue for old and new callers, with all physical writes outside
 * the guarded repository. Never move or replace a populated legacy directory.
 * rmdir is the atomic empty check; if an old writer wins the mkdir race, retry
 * there instead of admitting a second queue. Unknown owners remain blocking.
 */
async function prepareWorkspaceValidationCoordination(options: ValidationCapacityLockOptions, legacyPath: string): Promise<void> {
  const sharedRoot = realpathSync(resolve(legacyPath, '../../..'));
  const namespace = join(realpathSync(userInfo().homedir), PROOF_OR_STOP_DIR, 'locks', WORKSPACE_VALIDATION_COORDINATION_ARTIFACT.directoryName);
  const target = join(namespace, createHash('sha256').update(sharedRoot).digest('hex'));
  const rel = relative(sharedRoot, target);
  if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\')) {
    throw new Error('workspace validation coordination must be outside the protected repository');
  }
  for (const path of [namespace, target]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (process.platform !== 'win32' && (stat.uid !== userInfo().uid || (stat.mode & 0o077) !== 0))) {
      throw new Error('workspace validation coordination requires a private owned directory');
    }
  }
  mkdirSync(dirname(legacyPath), { recursive: true });
  const validAlias = (): boolean => {
    let stat;
    try { stat = lstatSync(legacyPath); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    if (!stat?.isSymbolicLink()) return false;
    if (realpathSync(legacyPath) !== realpathSync(target)) throw new Error('workspace validation coordination alias points at an unowned queue');
    return true;
  };
  if (validAlias()) return;
  const migrationPath = target + WORKSPACE_VALIDATION_COORDINATION_ARTIFACT.migrationLockSuffix;
  let migration: AcquiredMkdirLock | undefined;
  while (!migration) {
    assertCapacityWaitActive(options);
    if (validAlias()) return;
    try {
      migration = acquireMkdirLock(migrationPath, {
        label: 'workspace coordination migration', deadlineMs: 1, pollMs: 1,
        failFastIfHeld: true, heldMessage: 'WORKSPACE_COORDINATION_MIGRATION_BUSY',
        classifyExistingLock: classifyValidationCapacityLock, requireHolderToken: true,
        holderInfo: { lockId: randomUUID(), pid: process.pid, hostname: hostname(),
          command: 'workspace coordination migration', acquiredAt: new Date().toISOString(), processStartTimeMs: currentProcessStartTimeMs() },
      });
    } catch (error: any) {
      if (!existsSync(migrationPath) || (!error.message.includes('WORKSPACE_COORDINATION_MIGRATION_BUSY')
        && !error.message.startsWith('workspace coordination migration lock timeout'))) throw error;
      await waitForCapacityRetry(options, Math.max(10, options.pollMs ?? VALIDATION_CAPACITY_WAIT_POLL_MS));
    }
  }
  try {
  const pruneEmptyQueue = (path: string): string[] => {
    const blocked: string[] = [];
    // Queue-visible tickets preserve their existing live-owner wait semantics.
    activeCapacityCandidates(path, '.choosing', options.staleMs ?? VALIDATION_EXECUTION_LOCK_STALE_MS);
    activeCapacityCandidates(path, '.ticket', options.staleMs ?? VALIDATION_EXECUTION_LOCK_STALE_MS);
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      let stat;
      try { stat = lstatSync(child); } catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
      if (/\.(preparing|quarantine)$/.test(name) && stat.isDirectory() && !stat.isSymbolicLink()) {
        const holder = readMkdirLockHolder(child);
        // Unpublished or quarantined state is removable only with local owner
        // death, never merely age, a mismatched heartbeat, or an unknown owner.
        if (holder?.hostname === hostname() && !pidAppearsAlive(holder.pid)
          && classifyValidationCapacityLock({lockDir:child,holder,ageMs:0,staleMs:VALIDATION_EXECUTION_LOCK_STALE_MS,nowMs:Date.now()}) === 'stale') {
          quarantineValidationCapacityCandidate(child, 'stale');
          if (!existsSync(child)) continue;
        }
        blocked.push(child);
      } else if (name === 'workspaces' && stat.isDirectory() && !stat.isSymbolicLink()) {
        for (const workspace of readdirSync(child)) {
          const queue = join(child, workspace);
          let queueStat;
          try { queueStat = lstatSync(queue); } catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
          if (!/^[a-f0-9]{64}$/.test(workspace) || !queueStat.isDirectory() || queueStat.isSymbolicLink()) { blocked.push(queue); continue; }
          blocked.push(...pruneEmptyQueue(queue));
          try { rmdirSync(queue); } catch (error: any) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
        }
        try { rmdirSync(child); } catch (error: any) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
      } else if (!/\.(choosing|ticket)$/.test(name) || !stat.isDirectory() || stat.isSymbolicLink()) blocked.push(child);
    }
    return blocked;
  };
  while (true) {
    assertCapacityWaitActive(options);
    let stat;
    try { stat = lstatSync(legacyPath); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) {
      if (realpathSync(legacyPath) !== realpathSync(target)) throw new Error('workspace validation coordination alias points at an unowned queue');
      return;
    }
    if (stat) {
      if (!stat.isDirectory()) throw new Error('workspace validation coordination legacy path is not a directory');
      const blocked = pruneEmptyQueue(legacyPath);
      if (blocked.length) throw new Error(`WORKSPACE_COORDINATION_MIGRATION_BLOCKED: ${legacyPath}; retained entries: ${blocked.join(', ')}. Inspect their owners and repair abandoned residue before retrying; live or unknown ownership is never removed.`);
      try { rmdirSync(legacyPath); }
      catch (error: any) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
        if (error.code !== 'ENOENT') { await waitForCapacityRetry(options, Math.max(10, options.pollMs ?? VALIDATION_CAPACITY_WAIT_POLL_MS)); continue; }
      }
    }
    try { symlinkSync(target, legacyPath, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    // Verify the winner before the caller can publish any ticket.
  }
  } finally { migration.release(); }
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
  schema: 'validation-capacity-resources.v1' | 'validation-capacity-resources.v2';
  invocationGroup?: string;
  maxConcurrent: number;
  resources: ResourceClaim[];
}

export interface ValidationCapacityLockOptions {
  /** Internal invocation guard: separate from the shared command-capacity queue. */
  workspaceOnly?: boolean;
  /** Internal random invocation identity; groups stages without weakening resource conflicts. */
  invocationGroup?: string;
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
  /**
   * Bounds only the wait for admission. `deadlineAt` still bounds the admitted work and the
   * reservation it holds, so a caller whose own budget should start at admission can queue
   * against this bound without the wait consuming that budget.
   */
  waitDeadlineAt?: number;
  deadlineError?: () => Error;
  onWaitProgress?: (message: string) => void;
  externalCancellation?: () => string | undefined;
}

export interface OfficialValidationExecutionOptions extends ValidationCapacityLockOptions {
  /** Only migrated handlers whose subprocesses cross runValidationCommand may use stages. */
  commandStages?: boolean;
  sharedExecution?: SharedValidationExecutionContext;
  ownerLeaseDir?: string;
  ownerLeaseHeartbeat?: OwnerLeaseHeartbeatOptions;
}

/** The capacity wait's own deadline error, distinguishable from any caller-supplied deadline error by type. */
export class ValidationCapacityWaitDeadlineError extends Error {
  constructor() { super('workspace validation capacity wait deadline exceeded'); this.name = 'ValidationCapacityWaitDeadlineError'; capacityWaitDeadlineErrors.add(this); }
}
const capacityWaitDeadlineErrors = new WeakSet<object>();
/**
 * Identity check for the capacity wait's own deadline error. It reads nothing from the value (no prototype
 * walk, no property access), so a hostile thrown value can neither spoof it nor replace the original error.
 */
export function isValidationCapacityWaitDeadlineError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && capacityWaitDeadlineErrors.has(error);
}

function capacityDeadlineError(options: ValidationCapacityLockOptions): Error {
  // A caller's deadline error describes the caller's own deadline; an expired admission-wait
  // bound alone is reported as the capacity wait deadline it is.
  const callerDeadlineReached = typeof options.deadlineAt === 'number' && Number.isFinite(options.deadlineAt) && Date.now() >= options.deadlineAt;
  const waitOnly = typeof options.waitDeadlineAt === 'number' && !callerDeadlineReached;
  return (waitOnly ? undefined : options.deadlineError?.()) ?? new ValidationCapacityWaitDeadlineError();
}

/** The earlier of the caller's overall deadline and its admission-wait deadline. */
function capacityWaitDeadline(options: ValidationCapacityLockOptions): number | undefined {
  const bound = Math.min(
    typeof options.deadlineAt === 'number' && Number.isFinite(options.deadlineAt) ? options.deadlineAt : Infinity,
    typeof options.waitDeadlineAt === 'number' && Number.isFinite(options.waitDeadlineAt) ? options.waitDeadlineAt : Infinity,
  );
  return bound === Infinity ? undefined : bound;
}

function assertCapacityWaitActive(options: ValidationCapacityLockOptions): void {
  const external = options.externalCancellation?.();
  if (external) throw new Error(external);
  if (options.abortSignal?.aborted) {
    throw options.abortSignal.reason instanceof Error
      ? options.abortSignal.reason
      : new Error('workspace validation capacity wait aborted');
  }
  const waitDeadlineAt = capacityWaitDeadline(options);
  if (waitDeadlineAt !== undefined && Date.now() >= waitDeadlineAt) {
    throw capacityDeadlineError(options);
  }
}

async function waitForCapacityRetry(options: ValidationCapacityLockOptions, delayMs: number): Promise<void> {
  assertCapacityWaitActive(options);
  const waitDeadlineAt = capacityWaitDeadline(options);
  const remainingMs = waitDeadlineAt !== undefined ? Math.max(0, waitDeadlineAt - Date.now()) : delayMs;
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

// Boot identity is kernel-observed, never inferred from wall clock or owner death.
// This witness shares the existing private-owned ticket filesystem trust; it is
// not cryptographic authentication against an attacker rewriting that directory.
function machineBootIdentity(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    const value = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
      encoding: 'utf8', timeout: VALIDATION_RESERVATION_DELEGATION_RUNTIME_POLICY.kernelObservationMs,
      maxBuffer: VALIDATION_RESERVATION_DELEGATION_RUNTIME_POLICY.maxMessageBytes,
    }).trim().toLowerCase();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) ? value : undefined;
  } catch { return undefined; }
}
export function canonicalMachineCapacityRoot(): string {
  return join(userInfo().homedir, PROOF_OR_STOP_DIR, 'locks', MACHINE_FIXED_PORT_ARTIFACT.directoryName);
}
/** Read-only prior-boot proof. Only an already-stale canonical ticket may use it. */
export function machineTicketPreviousBootIsProven(ticket: string, holder: MkdirLockHolderInfo | null): boolean {
  if (dirname(ticket) !== canonicalMachineCapacityRoot() || !holder?.lockId
    || !basename(ticket).endsWith('-' + holder.lockId + '.ticket')
    || holder.hostname !== hostname() || !Number.isSafeInteger(holder.pid) || holder.pid <= 1
    || !Number.isFinite(holder.processStartTimeMs)) return false;
  let fd: number | undefined;
  try {
    const directory = lstatSync(ticket);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== userInfo().uid || (directory.mode & 0o077) !== 0) return false;
    // A currently live or unobservable owner always wins over contradictory metadata.
    try { process.kill(holder.pid, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
    const path = join(ticket, VALIDATION_RESERVATION_DELEGATION_ARTIFACT.bootFile);
    const prior = lstatSync(path);
    if (!prior.isFile() || prior.isSymbolicLink()) return false;
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== userInfo().uid || (stat.mode & 0o077) !== 0
      || stat.size <= 0 || stat.size > VALIDATION_RESERVATION_DELEGATION_RUNTIME_POLICY.maxMessageBytes
      || stat.dev !== prior.dev || stat.ino !== prior.ino) return false;
    const witness = JSON.parse(readFileSync(fd, 'utf8'));
    if (witness.schema !== 'machine-ticket-boot.v1' || witness.platform !== 'darwin'
      || witness.uid !== userInfo().uid || witness.lockId !== holder.lockId || witness.pid !== holder.pid
      || witness.hostname !== holder.hostname || witness.processStartTimeMs !== holder.processStartTimeMs
      || typeof witness.bootId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(witness.bootId)) return false;
    const current = machineBootIdentity();
    return current !== undefined && current !== witness.bootId;
  } catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
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
    if (classification !== 'stale' || lockRoot === canonicalMachineCapacityRoot() && machineReservationResidualsPresent(candidate.path) && !machineTicketPreviousBootIsProven(candidate.path, candidate.holder)) {
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
  return resources.length ? { schema: options.invocationGroup ? 'validation-capacity-resources.v2' : 'validation-capacity-resources.v1', ...(options.invocationGroup ? { invocationGroup: options.invocationGroup } : {}), maxConcurrent, resources } : null;
}

function readCapacityDeclaration(path: string): CapacityResourceDeclaration | null {
  try {
    const value = JSON.parse(readFileSync(join(path, 'resources.json'), 'utf8')) as CapacityResourceDeclaration;
    if (!['validation-capacity-resources.v1', 'validation-capacity-resources.v2'].includes(value.schema) || !Number.isSafeInteger(value.maxConcurrent)
      || value.maxConcurrent < 1 || value.maxConcurrent > MAX_JOBS || !Array.isArray(value.resources)
      || value.resources.length === 0) return null;
    if (value.schema === 'validation-capacity-resources.v2' && !/^[0-9a-f-]{36}$/.test(value.invocationGroup ?? '')) return null;
    if (value.schema === 'validation-capacity-resources.v1' && value.invocationGroup !== undefined) return null;
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
  if (!own) return false;
  const groupKey = (path: string, declaration: CapacityResourceDeclaration): string => {
    const holder = readMkdirLockHolder(path);
    return declaration.invocationGroup && holder?.pid && holder.hostname && holder.processStartTimeMs
      ? `${holder.hostname}:${holder.pid}:${holder.processStartTimeMs}:${declaration.invocationGroup}` : path;
  };
  const groups = new Set([groupKey(ticketPath, own)]);
  let capacity = own.maxConcurrent;
  // Count preceding invocations, including blocked ones. Commands within one
  // invocation keep the scheduler's jobs limit, but never bypass resource conflicts.
  // V1/legacy tickets remain individual slots; old readers treat V2 as exclusive.
  for (const ticket of tickets.slice(0, index)) {
    const earlier = readCapacityDeclaration(ticket.path);
    if (!earlier || claimsConflict({ name: 'current', resources: own.resources }, { name: 'earlier', resources: earlier.resources })) return false;
    groups.add(groupKey(ticket.path, earlier));
    capacity = Math.min(capacity, earlier.maxConcurrent);
  }
  if (groups.size > capacity) return false;
  return true;
}

function createValidationCapacityCandidate(path: string, holder: MkdirLockHolderInfo, declaration: CapacityResourceDeclaration | null): void {
  // A `.choosing` name is queue-visible, so never publish it before its
  // identity is complete. A process killed while preparing leaves only an
  // ignored, never-reused private path; the atomic rename is the publication.
  const preparingPath = `${path}.${process.pid}-${randomUUID()}.preparing`;
  // Only a canonical machine ticket is read by the boot-recovery reader, which requires the
  // private mode; workspace capacity tickets keep the process default.
  mkdirSync(preparingPath, dirname(path) === canonicalMachineCapacityRoot() ? { mode: MACHINE_FIXED_PORT_RUNTIME_POLICY.directoryMode } : undefined);
  try {
    writeFileSync(join(preparingPath, 'holder.json'), JSON.stringify(holder, null, 2) + '\n', 'utf8');
    if (declaration) writeFileSync(join(preparingPath, 'resources.json'), JSON.stringify(declaration) + '\n', 'utf8');
    if (dirname(path) === canonicalMachineCapacityRoot()) {
      const bootId = machineBootIdentity();
      if (bootId !== undefined && holder.lockId && Number.isFinite(holder.processStartTimeMs)) {
        writeFileSync(join(preparingPath, VALIDATION_RESERVATION_DELEGATION_ARTIFACT.bootFile), JSON.stringify({
          schema: 'machine-ticket-boot.v1', platform: 'darwin', bootId, uid: userInfo().uid,
          lockId: holder.lockId, pid: holder.pid, hostname: holder.hostname, processStartTimeMs: holder.processStartTimeMs,
        }) + '\n', { mode: 0o600 });
      }
    }
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
  const sharedKey = validationCapacityLockPath(options.workspaceRoot, options.requireGitIdentity === true);
  await prepareWorkspaceValidationCoordination(options, sharedKey);
  const lockKey = options.workspaceOnly ? join(sharedKey, 'workspaces', createHash('sha256').update(realpathSync(options.workspaceRoot)).digest('hex')) : sharedKey;
  return withValidationCapacityQueue(options, fn, lockKey);
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
  // A separate admission-wait bound applies only to the grant request, never to the granted frame.
  const grantWait = typeof options.waitDeadlineAt === 'number' && Number.isFinite(options.waitDeadlineAt) ? new AbortController() : undefined;
  // Segmented, so a wait bound beyond Node's timer ceiling never fires at once.
  const grantWaitTimer = grantWait ? deadlineTimer(options.waitDeadlineAt!, () => grantWait.abort(new Error('grant wait deadline')), { unref: true }) : undefined;
  let inherited: Awaited<ReturnType<typeof withInheritedMachineReservation<T>>>;
  let entered = false;
  try {
    inherited = await withInheritedMachineReservation(claims ?? null, options.deadlineAt ?? Date.now() + MACHINE_FIXED_PORT_RUNTIME_POLICY.queueDeadlineMs, options.abortSignal, async () => {
      entered = true;
      grantWaitTimer?.cancel();
      for (const claim of (claims ?? []).filter(claim => claim.class === 'fixed-port' && claim.access === 'exclusive')) if(!inheritedValidationReservationPortAlreadyHeld(claim.key)) await probeMachineFixedPort(Number(claim.key));
      currentValidationReservationAbortSignal()?.throwIfAborted();
      assertCapacityWaitActive(options); return await fn();
    }, grantWait?.signal);
  } catch (error) {
    if (!entered && grantWait?.signal.aborted && error === grantWait.signal.reason) throw capacityDeadlineError(options);
    throw error;
  } finally {
    grantWaitTimer?.cancel();
  }
  if (inherited.inherited) return inherited.value;
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

/**
 * Budget for one ancestor probe. A busy machine can take longer than a second to
 * list processes; the probe runs asynchronously so heartbeats keep flowing.
 */
export const MACHINE_ANCESTOR_PROBE_TIMEOUT_MS = 5000;

/**
 * Ancestors of this process, or undefined when `ps` did not answer in time or
 * failed. Unknown ancestry never admits a waiter: the caller only probes while it
 * is still queued behind another ticket, so it keeps waiting and probes again on
 * the next poll, bounded by the queue deadline.
 */
async function machinePortAncestorPids(
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<Set<number> | undefined> {
  if (!(options.timeoutMs > 0) || options.signal?.aborted) return undefined;
  const text = await new Promise<string | undefined>((resolveProbe) => {
    const child = execFile('ps', ['-axo', 'pid=,ppid='], {
      encoding: 'utf8', timeout: options.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout) => { detach(); resolveProbe(error ? undefined : stdout); });
    // Cancellation must not wait for a hung probe: kill the child so the caller's
    // own abort/deadline classification surfaces without the probe's own budget.
    const cancel = (): void => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
    const detach = (): void => { options.signal?.removeEventListener('abort', cancel); };
    if (options.signal) options.signal.addEventListener('abort', cancel, { once: true });
  });
  if (text === undefined) return undefined;
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
    assertCapacityWaitActive(options);
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
            // The probe never outlives the caller's own budget: it gets at most the
            // remaining wait, and an abort kills it. The caller's abort/deadline verdict
            // is re-checked FIRST afterwards, so a conflict detected by a probe that
            // finished past the deadline never replaces that verdict.
            const waitDeadlineAt = capacityWaitDeadline(options);
            const remainingMs = waitDeadlineAt !== undefined ? waitDeadlineAt - Date.now() : Number.POSITIVE_INFINITY;
            ancestors ??= await machinePortAncestorPids({
              timeoutMs: Math.min(MACHINE_ANCESTOR_PROBE_TIMEOUT_MS, remainingMs),
              signal: options.abortSignal,
            });
            assertCapacityWaitActive(options);
            // Unknown ancestry: stay queued and probe again next poll (never admit, never crash).
            if (!ancestors) break;
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
      async () => rejectAncestorConflict ? await withMachineReservationController({ ticket: ticketPath, lockId: acquisitionToken, pid: process.pid, deadlineAt: options.deadlineAt ?? Date.now() + MACHINE_FIXED_PORT_RUNTIME_POLICY.queueDeadlineMs, resources: declaration?.resources ?? null }, () => activeValidationLockTokens.get(lockKey)?.has(acquisitionToken) === true && readMkdirLockHolder(ticketPath)?.lockId === acquisitionToken, fn) : await fn(),
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
    if (rejectAncestorConflict && machineReservationResidualsPresent(ticketPath)) throw new Error('VALIDATION_DELEGATION_CLEANUP_UNPROVEN');
    await releaseValidationCapacityTicket(ticketPath, holderInfo);
  } catch (error) {
    releaseError = error;
  }
  if (callbackFailed) throw callbackError;
  if (releaseError) throw releaseError;
  return callbackResult as T;
}

interface HeldStage {
  tokens: Map<string, string>;
  release: () => Promise<void>;
}

/** Acquire through the existing queue; its existing heartbeat/release owns the ticket. */
async function holdValidationStage(options: ValidationCapacityLockOptions): Promise<HeldStage> {
  let acquired!: (tokens: Map<string, string>) => void;
  let failed!: (error: unknown) => void;
  let release!: () => void;
  const ready = new Promise<Map<string, string>>((resolveReady, rejectReady) => { acquired = resolveReady; failed = rejectReady; });
  const released = new Promise<void>(resolveRelease => { release = resolveRelease; });
  const completion = withWorkspaceValidationCapacity(options, async () => {
    acquired(new Map(validationLockOwnerStore.getStore()));
    await released;
  });
  void completion.catch(failed);
  const tokens = await ready;
  return { tokens, release: async () => { release(); await completion; } };
}

interface InvocationStages {
  options: OfficialValidationExecutionOptions;
  stageOptions: ValidationCapacityLockOptions;
  commonKey: string;
  held?: HeldStage;
  tokens: Map<string, string>;
  executingPlan: boolean;
  active: boolean;
}
const invocationStages = new AsyncLocalStorage<InvocationStages>();

/** Release preparation capacity for a complete plan, then reacquire before publication. */
export async function withValidationPlanStages<T>(fn: () => Promise<T>): Promise<T> {
  const frame = invocationStages.getStore();
  if (!frame || frame.executingPlan) return await fn();
  if (!frame.active || !frame.held) throw new Error('validation invocation stage is no longer owned');
  await frame.held.release();
  frame.held = undefined;
  frame.executingPlan = true;
  let result: T;
  try { result = await fn(); }
  finally { frame.executingPlan = false; }
  // An exceptional plan exit never reacquires capacity or masks its original error.
  // A command FAIL returned as data can still publish FAIL; invocation cancellation cannot.
  assertCapacityWaitActive(frame.stageOptions);
  frame.held = await holdValidationStage(frame.stageOptions);
  const token = frame.held.tokens.get(frame.commonKey);
  if (!token) throw new Error('validation publication capacity identity missing');
  frame.tokens.set(frame.commonKey, token);
  return result;
}

/** Undeclared commands retain the existing repo-global exclusive capacity semantics. */
export async function withValidationCommandStage<T>(
  command: { label: string; cwd?: string; resources?: ResourceClaim[] },
  fn: () => Promise<T>,
  wait?: Pick<ValidationCapacityLockOptions, 'abortSignal' | 'deadlineAt' | 'deadlineError'>,
): Promise<T> {
  const frame = invocationStages.getStore();
  if (!frame) return await fn();
  if (!frame.active) throw new Error('validation invocation stage is no longer owned');
  return await withValidationPlanStages(() => withWorkspaceValidationCapacity({
    ...frame.options, workspaceOnly: false, invocationGroup: frame.stageOptions.invocationGroup,
    abortSignal: wait?.abortSignal && frame.options.abortSignal && wait.abortSignal !== frame.options.abortSignal
      ? AbortSignal.any([wait.abortSignal, frame.options.abortSignal]) : wait?.abortSignal ?? frame.options.abortSignal,
    deadlineAt: wait?.deadlineAt !== undefined && frame.options.deadlineAt !== undefined
      ? Math.min(wait.deadlineAt, frame.options.deadlineAt) : wait?.deadlineAt ?? frame.options.deadlineAt,
    deadlineError: wait?.deadlineError ?? frame.options.deadlineError,
    resources: undefined, maxConcurrent: undefined,
    ...(command.resources?.length ? { resources: normalizedCommandResources(command, frame.options.workspaceRoot), maxConcurrent: VALIDATION_EXECUTION_RUNTIME_REQUIREMENTS.declaredInvocationCapacity } : {}),
  }, fn));
}

/** Owner lease -> worktree guard -> Story lock -> short shared-capacity stages.
 * Existing explicit outer capacity callers retain their original non-upgrade contract. */
export async function withOfficialValidationExecution<T>(
  options: OfficialValidationExecutionOptions,
  fn: () => Promise<T> | T,
): Promise<T> {
  const commonKey = validationCapacityLockPath(options.workspaceRoot, options.requireGitIdentity === true);
  const execute = async (leaseLostSignal?: AbortSignal) => {
    // Preserve caller cancellation while also stopping an obsolete owner from
    // waiting for capacity and entering a callback after failed renewal.
    // Use the base AbortController API supported by the existing Node floor.
    // Remove forwarding listeners after success, refusal, and callback failure.
    const signals = [...new Set([options.abortSignal, leaseLostSignal].filter((value): value is AbortSignal => value !== undefined))];
    const combined = signals.length ? new AbortController() : undefined;
    const subscriptions = signals.map(source => {
      const forward = () => combined!.abort(source.reason);
      if (source.aborted) forward();
      else source.addEventListener('abort', forward, { once: true });
      return { source, forward };
    });
    try {
      const scopedOptions = { ...options, abortSignal: combined?.signal };
      assertCapacityWaitActive(scopedOptions);
      return await withSharedValidationExecutions(options.sharedExecution, async () => {
    const parent = invocationStages.getStore();
    if (parent) {
      if (!parent.active || realpathSync(parent.options.workspaceRoot) !== realpathSync(scopedOptions.workspaceRoot)
          || (parent.options.storyId ?? '') !== (scopedOptions.storyId ?? '')) throw new Error('nested validation cannot change its invocation workspace or Story');
      if (!scopedOptions.commandStages) return await withWorkspaceValidationCapacity(scopedOptions, fn);
      return await fn();
    }
    if (currentContextOwns(commonKey)) {
      if (scopedOptions.storyId && !currentContextOwns(validationExecutionLockPath(scopedOptions.root, scopedOptions.storyId))) {
        throw new Error('VALIDATION_LOCK_ORDER: acquire the Story lock before shared capacity');
      }
      return await withWorkspaceValidationCapacity(scopedOptions, () => scopedOptions.storyId
        ? withValidationExecutionLock({ root: scopedOptions.root, storyId: scopedOptions.storyId, workspaceRoot: scopedOptions.workspaceRoot, command: scopedOptions.command, staleMs: scopedOptions.staleMs }, fn)
        : fn());
    }
    return await withWorkspaceValidationCapacity({ ...scopedOptions, workspaceOnly: true, invocationGroup: undefined, resources: undefined, maxConcurrent: undefined }, async () => {
    const run = async () => {
      if (!scopedOptions.commandStages) return await withWorkspaceValidationCapacity(scopedOptions, fn);
      const stageOptions: ValidationCapacityLockOptions = {
        ...scopedOptions, workspaceOnly: false, invocationGroup: randomUUID(),
        resources: [{ class: 'fixed-path', key: realpathSync(scopedOptions.workspaceRoot), access: 'exclusive' }],
        maxConcurrent: VALIDATION_EXECUTION_RUNTIME_REQUIREMENTS.declaredInvocationCapacity,
      };
      const held = await holdValidationStage(stageOptions);
      const frame: InvocationStages = { options: scopedOptions, stageOptions, commonKey, held, tokens: held.tokens, executingPlan: false, active: true };
      try { return await validationLockOwnerStore.run(frame.tokens, () => invocationStages.run(frame, fn)); }
      finally { frame.active = false; await frame.held?.release(); }
    };
    const storyId = String(scopedOptions.storyId ?? '').trim();
    if (!storyId) return await run();
    return await withValidationExecutionLock({
      root: scopedOptions.root,
      storyId,
      workspaceRoot: scopedOptions.workspaceRoot,
      command: scopedOptions.command,
      staleMs: scopedOptions.staleMs,
    }, run);
    });
      });
    } finally {
      for (const { source, forward } of subscriptions) source.removeEventListener('abort', forward);
    }
  };
  return options.ownerLeaseDir
    ? withOwnerLeaseHeartbeat(options.ownerLeaseDir, { command: options.command, cwd: options.workspaceRoot, ...options.ownerLeaseHeartbeat }, execute)
    : execute();
}

/** Serialize synchronous StoryStore writes against official validation publication.
 * Refusal is explicit and retryable; no caller payload is discarded or auto-committed.
 * Only the live async owner may write inside its validation transaction.
 */
export function classifyValidationMetadataLock(snapshot: ExistingMkdirLockSnapshot): 'active' | 'stale' | 'unknown' {
  const holder = snapshot.holder;
  // Preserve the shared mkdir-lock bounded recovery contract for nascent,
  // corrupt or foreign holders; never age-steal a demonstrably live local PID.
  if (!holder || holder.hostname !== hostname()) return 'unknown';
  if (!pidAppearsAlive(holder.pid)) return 'stale';
  const observedStart = holder.pid === process.pid ? currentProcessStartTimeMs() : observedProcessStartTimeMs(holder.pid);
  if (holder.processStartTimeMs === undefined || observedStart === undefined) return 'unknown';
  if (!sameProcessStart(holder.processStartTimeMs, observedStart)) return 'stale';
  return 'active';
}

/** Recognize coordination refusals across CLI/module boundaries. */
export function isValidationMetadataBusy(error: unknown): boolean {
  return error instanceof Error && error.message.includes('[VALIDATION_METADATA_BUSY]');
}

export function withValidationMetadataWrite<T>(root: string, storyId: string, fn: () => T): T {
  const lockKey = validationExecutionLockPath(root, storyId);
  if (currentContextOwns(lockKey)) return fn();
  const holderInfo: MkdirLockHolderInfo = {
    lockId: randomUUID(), lockClass: 'metadata-write', pid: process.pid, hostname: hostname(),
    command: `metadata write for ${storyId}`, acquiredAt: new Date().toISOString(),
    processStartTimeMs: currentProcessStartTimeMs(),
  };
  const lock = acquireMkdirLock(lockKey, {
    label: '[VALIDATION_METADATA_BUSY] metadata write; retry after the active operation finishes', deadlineMs: VALIDATION_METADATA_WAIT_MS, pollMs: 10,
    staleMs: VALIDATION_EXECUTION_LOCK_STALE_MS, holderInfo, requireHolderToken: true,
    classifyExistingLock: classifyValidationMetadataLock,
    heldMessage: `[VALIDATION_METADATA_BUSY] ${storyId}: validation publication is active; retry this write after validation completes`,
  });
  const token = holderInfo.lockId!;
  activeValidationLockTokens.set(lockKey, new Set([...(activeValidationLockTokens.get(lockKey) ?? []), token]));
  try { return validationLockOwnerStore.run(extendedOwnerTokens(lockKey, token), fn); }
  finally { clearActiveValidationLockToken(lockKey, token); lock.release(); }
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
  holderInfo.lockClass = 'validation';
  const deadline = Date.now() + VALIDATION_METADATA_GRACE_MS;
  let lock: AcquiredMkdirLock;
  for (;;) {
    try {
      lock = acquireMkdirLock(lockKey, {
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
        classifyExistingLock: (snapshot) => snapshot.holder?.lockClass === 'metadata-write'
          ? classifyValidationMetadataLock(snapshot) : classifyValidationExecutionLock(snapshot),
        onContentionHeld: (holder, holderAgeMs) => buildValidationLockContentionMessage({
          storyId,
          workspaceRoot,
          command,
          holder,
          holderAgeMs,
        }),
      });
      break;
    } catch (error) {
      const holder = readMkdirLockHolder(lockKey);
      if (Date.now() >= deadline || (existsSync(lockKey) && holder?.lockClass !== 'metadata-write')) throw error;
      // Yield to same-process writers as well as other processes. Only short
      // metadata operations get grace; a second validator still fails promptly.
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
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


/** Normalize command claims without inserting/removing an invocation workspace claim. */
function normalizedCommandResources(
  command: { label: string; cwd?: string; resources?: ResourceClaim[] }, workspaceRoot: string,
): ResourceClaim[] {
  validateResourceClaims(command.resources!, command.label);
  const cwd = resolve(workspaceRoot, command.cwd ?? '.');
  const resources = command.resources!.map(claim => ({
    class: claim.class, key: VALIDATION_RESOURCE_KEY_RUNTIME_POLICY.literalClasses.some(value => value === claim.class)
      ? claim.key : resolve(cwd, claim.key),
    access: claim.access, ...(claim.ownership ? { ownership: claim.ownership } : {}),
  }));
  return [...new Map(resources.map(claim => [JSON.stringify(claim), claim])).values()];
}

/** Whole official invocations can overlap only when every child declares its
 * resources. The workspace claim also protects metadata and build preparation. */
export function declaredValidationCapacity(
  commands: Array<{ label: string; cwd?: string; resources?: ResourceClaim[] }>, workspaceRoot: string,
): Pick<ValidationCapacityLockOptions, 'resources' | 'maxConcurrent'> {
  if (!commands.length || commands.some(command => !command.resources?.length)) return {};
  const resources: ResourceClaim[] = [{ class: 'fixed-path', key: resolve(workspaceRoot), access: 'exclusive' }];
  for (const command of commands) {
    resources.push(...normalizedCommandResources(command, workspaceRoot));
  }
  // Duplicate normalized claims carry no additional permission or capacity.
  // Preserve access, ownership and resolved cwd; validate every input before dedup.
  const distinctResources = [...new Map(resources.map(claim => [JSON.stringify(claim), claim])).values()];
  return { resources: distinctResources, maxConcurrent: VALIDATION_EXECUTION_RUNTIME_REQUIREMENTS.declaredInvocationCapacity };
}

/** Read-only resolution from the canonical machine queue, never a bootstrap-selected root. */
export function inspectMachineReservationOwner(ticket: string, lockId: string): {pid:number;start:number;resources:ResourceClaim[]|null} | null {
  const root = join(userInfo().homedir, PROOF_OR_STOP_DIR, 'locks', MACHINE_FIXED_PORT_ARTIFACT.directoryName);
  if (dirname(ticket) !== root || !basename(ticket).endsWith('-' + lockId + '.ticket')) return null;
  const candidates = capacityCandidates(root, '.ticket').filter(candidate => classifyValidationCapacityLock({lockDir:candidate.path,holder:candidate.holder,ageMs:candidate.ageMs,staleMs:VALIDATION_EXECUTION_LOCK_STALE_MS,nowMs:Date.now()}) !== 'stale' || machineReservationResidualsPresent(candidate.path) && !machineTicketPreviousBootIsProven(candidate.path, candidate.holder)).sort((a,b)=>a.name.localeCompare(b.name));
  const candidate = candidates.find(row=>row.path===ticket), holder = candidate?.holder;
  if (!holder || holder.lockId !== lockId || holder.hostname !== hostname() || !capacityTicketAdmitted(candidates,ticket)) return null;
  const start=observedProcessStartTimeMs(holder.pid);
  if (start === undefined || holder.processStartTimeMs === undefined || Math.abs(start-holder.processStartTimeMs)>2000) return null;
  return {pid:holder.pid,start,resources:readCapacityDeclaration(ticket)?.resources??null};
}
