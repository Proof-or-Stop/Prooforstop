import { mkdirSync, rmSync, statSync } from 'fs';
import { dirname } from 'path';

/**
 * B-6812 CHK-001: shared mkdir-based advisory lock primitive.
 *
 * Extracted from checklist.ts `withChecklistLock` so story_create can reuse the
 * exact same atomic-lock mechanism. `mkdir` of a non-existent directory is
 * atomic on POSIX/Win32 filesystems — exactly one caller wins the race; the
 * losers retry until they either acquire it or hit the deadline.
 *
 * Semantics:
 *  - `mkdirSync(lockDir)` is the atomic acquire. EEXIST means another holder.
 *  - While waiting, if the lock dir's mtime is older than `staleMs`, the holder
 *    is presumed dead/crashed → force-reclaim by removing the dir.
 *  - If acquisition does not succeed before `deadlineMs`, throw a clear error.
 *  - `finally` always releases the lock so a throwing `fn` cannot leak it.
 */

export interface MkdirLockOptions {
  /**
   * Total time budget (ms) to acquire the lock before throwing. Default 30000.
   *
   * MUST be larger than `staleMs`: a waiter that gives up before a held lock
   * crosses the stale threshold can never reach the stale-reclaim branch, so a
   * crashed holder's lock would deadlock every subsequent caller. With
   * deadline (30s) > stale (10s) a waiter is still polling when the lock turns
   * stale and reclaims it.
   */
  deadlineMs?: number;
  /** Age (ms) past which a held lock is treated as stale and reclaimed. Default 10000. */
  staleMs?: number;
  /** Poll interval (ms) between acquisition attempts. Default 50. */
  pollMs?: number;
  /** Human-readable label used in the timeout error message. Default 'mkdir'. */
  label?: string;
  /**
   * When true, a non-stale existing lock fails immediately instead of polling.
   * Stale locks are still reclaimed first. This is useful for high-level
   * lifecycle locks where waiting would hide contention from the operator.
   */
  failFastIfHeld?: boolean;
  /** Optional user-facing message used when failFastIfHeld sees a live lock. */
  heldMessage?: string;
}

/**
 * Default acquire deadline. Kept strictly above DEFAULT_STALE_MS so the
 * stale-reclaim path is reachable for every caller using defaults: a waiter
 * polls past the 10s stale threshold and reclaims a crashed holder's lock
 * before its own 30s deadline expires. story_create / checklist_update both
 * complete in well under 1s, so no legitimate holder ever lives long enough to
 * be reclaimed.
 */
const DEFAULT_DEADLINE_MS = 30000;
const DEFAULT_STALE_MS = 10000;
const DEFAULT_POLL_MS = 50;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface AcquiredMkdirLock {
  lockDir: string;
  release(): void;
}

/**
 * Acquire `lockDir` via atomic mkdir.
 *
 * The parent directory of `lockDir` is created (recursive) if missing — callers
 * resolving a lock path inside a not-yet-created story dir do not need to
 * pre-create it themselves.
 */
export function acquireMkdirLock(lockDir: string, options: MkdirLockOptions = {}): AcquiredMkdirLock {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const label = options.label ?? 'mkdir';

  // Ensure the lock's parent exists so mkdir(lockDir) fails only on EEXIST,
  // never on ENOENT. mkdir(recursive) on an existing dir is a no-op.
  mkdirSync(dirname(lockDir), { recursive: true });

  const deadline = Date.now() + deadlineMs;
  while (true) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (e: any) {
      // Lock dir already exists (EEXIST) — another holder, or a stale leftover.
      let sawLiveLock = false;
      try {
        const ageMs = Date.now() - statSync(lockDir).mtimeMs;
        if (ageMs > staleMs) rmSync(lockDir, { recursive: true, force: true });
        else sawLiveLock = true;
      } catch {
        /* PROBE: lock dir vanished between mkdir attempt and stat — next loop retries */
      }
      if (sawLiveLock && options.failFastIfHeld) {
        throw new Error(options.heldMessage ?? `${label} lock is held; retry after the active operation finishes`);
      }
      if (Date.now() > deadline) {
        throw new Error(`${label} lock timeout after ${deadlineMs}ms (${e?.message || e})`);
      }
      sleepSync(pollMs);
    }
  }

  return {
    lockDir,
    release() {
      rmSync(lockDir, { recursive: true, force: true });
    },
  };
}

/**
 * Acquire `lockDir` via atomic mkdir, run `fn`, then release the lock.
 */
export function withMkdirLock<T>(lockDir: string, fn: () => T, options: MkdirLockOptions = {}): T {
  const lock = acquireMkdirLock(lockDir, options);
  try {
    return fn();
  } finally {
    lock.release();
  }
}
