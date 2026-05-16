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
  /** Total time budget (ms) to acquire the lock before throwing. Default 5000. */
  deadlineMs?: number;
  /** Age (ms) past which a held lock is treated as stale and reclaimed. Default 10000. */
  staleMs?: number;
  /** Poll interval (ms) between acquisition attempts. Default 50. */
  pollMs?: number;
  /** Human-readable label used in the timeout error message. Default 'mkdir'. */
  label?: string;
}

const DEFAULT_DEADLINE_MS = 5000;
const DEFAULT_STALE_MS = 10000;
const DEFAULT_POLL_MS = 50;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Acquire `lockDir` via atomic mkdir, run `fn`, then release the lock.
 *
 * The parent directory of `lockDir` is created (recursive) if missing — callers
 * resolving a lock path inside a not-yet-created story dir do not need to
 * pre-create it themselves.
 */
export function withMkdirLock<T>(lockDir: string, fn: () => T, options: MkdirLockOptions = {}): T {
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
      try {
        const ageMs = Date.now() - statSync(lockDir).mtimeMs;
        if (ageMs > staleMs) rmSync(lockDir, { recursive: true, force: true });
      } catch {
        /* PROBE: lock dir vanished between mkdir attempt and stat — next loop retries */
      }
      if (Date.now() > deadline) {
        throw new Error(`${label} lock timeout after ${deadlineMs}ms (${e?.message || e})`);
      }
      sleepSync(pollMs);
    }
  }

  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}
