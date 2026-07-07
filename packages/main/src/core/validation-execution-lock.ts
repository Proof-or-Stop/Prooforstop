import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  acquireMkdirLock,
  type AcquiredMkdirLock,
  type ExistingMkdirLockSnapshot,
  type MkdirLockHolderInfo,
} from './mkdir-lock.js';
import { LATTICE_DIR } from './lattice-paths.js';

export const VALIDATION_EXECUTION_LOCKS_REL = `${LATTICE_DIR}/locks/validation`;
export const VALIDATION_EXECUTION_LOCK_STALE_MS = 120000;
export const VALIDATION_EXECUTION_LOCK_HEARTBEAT_MS = 2000;
export const VALIDATION_EXECUTION_LOCK_HEARTBEAT_FILE = 'heartbeat.json';

const heldValidationLockPaths = new Set<string>();
const validationLockOwnerStore = new AsyncLocalStorage<Set<string>>();

interface ValidationLockHeartbeatInfo {
  lockId: string;
  pid: number;
  hostname: string;
  processStartTimeMs?: number;
  heartbeatAt: string;
}

function sanitizeLockSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
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

export function validationExecutionLockPath(root: string, storyId: string): string {
  const projectRoot = String(root ?? '').trim();
  const id = String(storyId ?? '').trim();
  if (!projectRoot) throw new Error('validationExecutionLockPath: root is required');
  if (!id) throw new Error('validationExecutionLockPath: storyId is required');
  return join(projectRoot, VALIDATION_EXECUTION_LOCKS_REL, `${sanitizeLockSegment(id)}.lock`);
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
