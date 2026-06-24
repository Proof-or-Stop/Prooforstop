import { AsyncLocalStorage } from 'node:async_hooks';
import { utimesSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  acquireMkdirLock,
  type AcquiredMkdirLock,
  type MkdirLockHolderInfo,
} from './mkdir-lock.js';
import { LATTICE_DIR } from './lattice-paths.js';

export const VALIDATION_EXECUTION_LOCKS_REL = `${LATTICE_DIR}/locks/validation`;
export const VALIDATION_EXECUTION_LOCK_STALE_MS = 120000;
export const VALIDATION_EXECUTION_LOCK_HEARTBEAT_MS = 2000;

const heldValidationLockPaths = new Set<string>();
const validationLockOwnerStore = new AsyncLocalStorage<Set<string>>();

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
  return `${prefix} by another Lattice process (holder details unavailable), ${heartbeat}. ${retry}`;
}

function startHeartbeat(lock: AcquiredMkdirLock): ReturnType<typeof setInterval> {
  const beat = () => {
    try {
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

  const lock = acquireMkdirLock(lockKey, {
    label: 'validation execution',
    staleMs: options.staleMs ?? VALIDATION_EXECUTION_LOCK_STALE_MS,
    failFastIfHeld: true,
    holderInfo: {
      pid: process.pid,
      hostname: hostname(),
      command: `${command} for ${storyId}`,
      acquiredAt: new Date().toISOString(),
    },
    onContentionHeld: (holder, holderAgeMs) => buildValidationLockContentionMessage({
      storyId,
      workspaceRoot,
      command,
      holder,
      holderAgeMs,
    }),
  });
  heldValidationLockPaths.add(lockKey);
  const heartbeat = startHeartbeat(lock);
  try {
    return await validationLockOwnerStore.run(extendedOwnerSet(lockKey), async () => await fn());
  } finally {
    clearInterval(heartbeat);
    heldValidationLockPaths.delete(lockKey);
    lock.release();
  }
}
