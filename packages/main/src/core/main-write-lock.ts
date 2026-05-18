/**
 * B-f60c CHK-001: unified main write lock.
 *
 * session-ownership-and-write-leases.md "Main Write Lock Rules" 1-3,6 require a
 * single global mkdir-style lock that serializes every shared write to main /
 * B-META metadata. This module is the canonical primitive for that lock:
 *
 *   - canonical lock path: `.koala/locks/main-write.lock/` (resolved against the
 *     main repo root, so a story worktree and the main checkout contend on the
 *     SAME directory).
 *   - atomic acquire via `core/mkdir-lock.ts` (`mkdirSync` of a non-existent
 *     dir is atomic — exactly one caller wins the race).
 *   - mtime-based stale reclaim, sized to the DONE critical section (120s).
 *   - acquisition failure is BLOCKING — `failFastIfHeld` makes a live lock
 *     throw immediately instead of silently polling/optimistically proceeding
 *     (Rule 6: "Koala must not proceed optimistically").
 *
 * This generalizes the former DONE-only `done-effects.ts` `acquireDoneMainMergeLock`
 * (`.koala/runtime/done-main-merge.lock`). The old path is retired; there is no
 * back-compat alias — no runtime cleanup / doctor code depended on the old path
 * (`.koala/runtime/` is a registry-managed volatile prefix, swept by glob, not
 * by the literal `done-main-merge.lock` name).
 */

import { join } from 'path';
import { acquireMkdirLock, type AcquiredMkdirLock } from './mkdir-lock.js';

/**
 * Canonical main write lock directory, relative to the main repo root.
 * Registered in `core/runtime-artifact-registry.ts` under `runtime-locks` so
 * doctor / stray-file scans treat it as managed volatile runtime state.
 */
export const MAIN_WRITE_LOCK_REL = '.koala/locks/main-write.lock';

/**
 * Age (ms) past which a held main write lock is treated as stale and reclaimed.
 *
 * Sized to the DONE critical section (pre-merge gate → merge → worktree
 * cleanup → branch delete), which is the longest holder. 120s is the value the
 * former DONE-specific lock used; no legitimate holder lives anywhere near that
 * long, so a lock older than 120s is presumed to belong to a crashed process.
 */
export const MAIN_WRITE_LOCK_STALE_MS = 120000;

/**
 * Resolve the canonical main write lock directory for `mainRepoRoot`.
 *
 * `mainRepoRoot` MUST be the main repository root (not a story worktree path):
 * callers running inside a story worktree are expected to resolve the main repo
 * root first (e.g. via `detectDoneStoryWorktreeContext().mainRepoRoot`) so all
 * sessions contend on one directory.
 */
export function mainWriteLockPath(mainRepoRoot: string): string {
  return join(mainRepoRoot, MAIN_WRITE_LOCK_REL);
}

/** Options for `acquireMainWriteLock`. */
export interface MainWriteLockOptions {
  /**
   * Human-readable label for the operation holding the lock (e.g.
   * `DONE main merge`, `gap_log`). Used in the held / timeout error message.
   * Default `main write`.
   */
  label?: string;
  /**
   * Operator-facing message shown when the lock is already held by a live
   * holder. Defaults to a generic "held by another Koala operation" message.
   */
  heldMessage?: string;
  /**
   * Stale reclaim threshold (ms). Defaults to `MAIN_WRITE_LOCK_STALE_MS`
   * (120s). Overridable only for tests; production callers use the default.
   */
  staleMs?: number;
}

/**
 * Acquire the unified main write lock.
 *
 * Atomic mkdir acquire at `.koala/locks/main-write.lock/`. A live (non-stale)
 * lock fails fast (`failFastIfHeld`) with a blocking error — the caller MUST
 * NOT proceed optimistically. A stale lock (mtime older than `staleMs`) is
 * force-reclaimed first. The returned handle's `release()` removes the lock
 * dir; callers MUST release in a `finally` so a throwing critical section
 * cannot leak the lock.
 */
export function acquireMainWriteLock(
  mainRepoRoot: string,
  options: MainWriteLockOptions = {},
): AcquiredMkdirLock {
  // Runtime re-validation of the constraint Zod cannot express here: the lock
  // root must be a non-empty path. Mirrors the "Handler 编码约定" rule that
  // every consumer re-checks load-bearing invariants instead of trusting an
  // upstream schema.
  const root = String(mainRepoRoot ?? '').trim();
  if (!root) {
    throw new Error('acquireMainWriteLock: mainRepoRoot is required');
  }

  const label = options.label?.trim() || 'main write';
  const staleMs = options.staleMs ?? MAIN_WRITE_LOCK_STALE_MS;
  const lockDir = mainWriteLockPath(root);

  return acquireMkdirLock(lockDir, {
    label,
    staleMs,
    failFastIfHeld: true,
    heldMessage:
      options.heldMessage ??
      `${label} is blocked: the main write lock is held by another Koala operation. ` +
        `Retry after the active operation finishes.`,
  });
}

/**
 * Acquire the main write lock, run `fn`, then release it (release always runs,
 * even when `fn` throws).
 */
export function withMainWriteLock<T>(
  mainRepoRoot: string,
  fn: () => T,
  options: MainWriteLockOptions = {},
): T {
  const lock = acquireMainWriteLock(mainRepoRoot, options);
  try {
    return fn();
  } finally {
    lock.release();
  }
}
