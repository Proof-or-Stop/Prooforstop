/**
 * B-f60c CHK-001: unified main write lock.
 *
 * session-ownership-and-write-leases.md "Main Write Lock Rules" 1-3,6 require a
 * single global mkdir-style lock that serializes every shared write to main /
 * B-META metadata. This module is the canonical primitive for that lock:
 *
 *   - canonical lock path: `.lattice/locks/main-write.lock/` (resolved against the
 *     main repo root, so a story worktree and the main checkout contend on the
 *     SAME directory).
 *   - atomic acquire via `core/mkdir-lock.ts` (`mkdirSync` of a non-existent
 *     dir is atomic — exactly one caller wins the race).
 *   - mtime-based stale reclaim, sized to the DONE critical section (120s).
 *   - acquisition failure is BLOCKING — `failFastIfHeld` makes a live lock
 *     throw immediately instead of silently polling/optimistically proceeding
 *     (Rule 6: "Lattice must not proceed optimistically").
 *
 * This generalizes the former DONE-only `done-effects.ts` `acquireDoneMainMergeLock`
 * (`.koala/runtime/done-main-merge.lock`). The old path is retired; there is no
 * back-compat alias — no runtime cleanup / doctor code depended on the old path
 * (`.koala/runtime/` is a registry-managed volatile prefix, swept by glob, not
 * by the literal `done-main-merge.lock` name).
 */

import { hostname } from 'os';
import { join } from 'path';
import {
  acquireMkdirLock,
  type AcquiredMkdirLock,
  type MkdirLockHolderInfo,
} from './mkdir-lock.js';
import { LATTICE_MAIN_WRITE_LOCK } from './lattice-paths.js';

/**
 * Canonical main write lock directory, relative to the main repo root.
 * Registered in `core/runtime-artifact-registry.ts` under `runtime-locks` so
 * doctor / stray-file scans treat it as managed volatile runtime state.
 */
export const MAIN_WRITE_LOCK_REL = LATTICE_MAIN_WRITE_LOCK;

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
 * Default acquire deadline (ms) for `onContention: 'wait'` callers.
 *
 * MUST exceed `MAIN_WRITE_LOCK_STALE_MS`: a waiter that gives up BEFORE a held
 * lock crosses the 120s stale threshold can never reach the stale-reclaim
 * branch, so a crashed holder's lock would deadlock every waiting caller. With
 * a 150s deadline a waiter is still polling when a crashed holder's lock turns
 * stale at 120s and reclaims it. Legitimate `wait`-mode holders (`story_create`
 * / `gap_log`) complete in well under 1s, so this deadline is only ever reached
 * by a genuine crash.
 */
export const MAIN_WRITE_LOCK_WAIT_DEADLINE_MS = 150000;

/**
 * Format a heartbeat age (ms) as a compact human string: `30s`, `8m`, `2h`.
 *
 * The lock has no separate heartbeat ping; the lock dir's mtime IS the
 * heartbeat (it is set at acquire time and not refreshed afterwards), so
 * `ageMs` is "how long ago the lock was acquired". Used by both the contention
 * error message and `doctor`'s stuck-lock report so the two read consistently.
 */
export function formatLockAge(ageMs: number): string {
  const safe = Number.isFinite(ageMs) && ageMs >= 0 ? ageMs : 0;
  const seconds = Math.floor(safe / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

/**
 * Build the operator-facing "main lock contention" error message.
 *
 * Shape follows the session-ownership-and-write-leases.md Error UX example for
 * main lock contention, with one deliberate divergence: the doc example shows a
 * `session abc123` token, but `sessionId` is an owner-lease concept owned by a
 * SEPARATE story. This message only renders what the lock can MECHANICALLY
 * observe — holder pid / hostname / running command / heartbeat (lock) age —
 * and never fabricates a sessionId. The complete session identity is delivered
 * by the follow-up owner-lease story.
 *
 * @param label       label of the BLOCKED operation (the caller being denied).
 * @param holder      holder metadata read from the live lock (null = unknown).
 * @param holderAgeMs age of the held lock (ms); used for the heartbeat line.
 */
export function buildMainWriteLockContentionMessage(
  label: string,
  holder: MkdirLockHolderInfo | null,
  holderAgeMs: number,
): string {
  const heartbeat = `heartbeat ${formatLockAge(holderAgeMs)} ago`;
  const retry = 'Retry after the active operation completes, or run `lattice doctor` if it appears stuck.';
  if (holder) {
    // Holder metadata available — name pid / hostname / running command.
    return (
      `${label} is blocked: the main write lock is held by ` +
      `${holder.command} (pid ${holder.pid} on ${holder.hostname}), ${heartbeat}. ` +
      retry
    );
  }
  // No holder.json — a lock from older code or a stale leftover. Still emit a
  // clear blocking message; only the holder identity is unavailable.
  return (
    `${label} is blocked: the main write lock is held by another Lattice operation ` +
    `(holder details unavailable), ${heartbeat}. ` +
    retry
  );
}

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
   * holder. Defaults to a generic "held by another Lattice operation" message.
   */
  heldMessage?: string;
  /**
   * Stale reclaim threshold (ms). Defaults to `MAIN_WRITE_LOCK_STALE_MS`
   * (120s). Overridable only for tests; production callers use the default.
   */
  staleMs?: number;
  /**
   * Contention behavior when the lock is held by a LIVE (non-stale) holder:
   *
   *  - `'fail-fast'` (default) — throw immediately. Correct for long critical
   *    sections (DONE merge ~120s): a waiter blocking that long is worse than a
   *    clear "retry later" error. This is the Rule-6 "do not proceed
   *    optimistically" behavior — failing IS blocking.
   *  - `'wait'` — poll until the lock frees (or `waitDeadlineMs` elapses, then
   *    throw a timeout). Correct for SHORT critical sections (`story_create`,
   *    `gap_log` — sub-second): concurrent callers should serialize-and-wait so
   *    every invocation still completes instead of erroring out. Waiting does
   *    NOT violate Rule 6 — the caller still never proceeds without the lock.
   */
  onContention?: 'fail-fast' | 'wait';
  /**
   * Acquire deadline (ms) when `onContention: 'wait'`. After this long still
   * waiting → throw a timeout. Ignored for `'fail-fast'`. Default
   * `MAIN_WRITE_LOCK_WAIT_DEADLINE_MS` (150s) — kept above the 120s stale
   * window so a crashed holder's lock is stale-reclaimed, never a deadlock.
   */
  waitDeadlineMs?: number;
}

/**
 * Acquire the unified main write lock.
 *
 * Atomic mkdir acquire at `.lattice/locks/main-write.lock/`. A stale lock (mtime
 * older than `staleMs`) is force-reclaimed first. A live (non-stale) lock is
 * handled per `options.onContention`: `'fail-fast'` (default) throws
 * immediately; `'wait'` polls until the lock frees or `waitDeadlineMs` elapses.
 * The returned handle's `release()` removes the lock dir; callers MUST release
 * in a `finally` so a throwing critical section cannot leak the lock.
 */
export function acquireMainWriteLock(
  mainRepoRoot: string,
  options: MainWriteLockOptions = {},
): AcquiredMkdirLock {
  // Runtime re-validation of the constraint Zod cannot express here: the lock
  // root must be a non-empty path. Mirrors the "Handler coding convention" rule that
  // every consumer re-checks load-bearing invariants instead of trusting an
  // upstream schema.
  const root = String(mainRepoRoot ?? '').trim();
  if (!root) {
    throw new Error('acquireMainWriteLock: mainRepoRoot is required');
  }

  const label = options.label?.trim() || 'main write';
  const staleMs = options.staleMs ?? MAIN_WRITE_LOCK_STALE_MS;
  const lockDir = mainWriteLockPath(root);
  // Default contention mode is fail-fast (long DONE-class critical sections).
  // Runtime guard: an out-of-enum value falls back to 'fail-fast' rather than
  // silently behaving as 'wait' (mirrors the "Handler coding convention" enum re-check).
  const onContention: 'fail-fast' | 'wait' =
    options.onContention === 'wait' ? 'wait' : 'fail-fast';

  return acquireMkdirLock(lockDir, {
    label,
    staleMs,
    failFastIfHeld: onContention === 'fail-fast',
    // For 'wait' mode the acquire deadline MUST stay above `staleMs` so a
    // crashed holder's lock is stale-reclaimed rather than deadlocking every
    // waiter. 'fail-fast' mode never polls, so the deadline is irrelevant there.
    ...(onContention === 'wait'
      ? { deadlineMs: options.waitDeadlineMs ?? MAIN_WRITE_LOCK_WAIT_DEADLINE_MS }
      : {}),
    // Record who holds the lock so a later blocked caller can name the holder.
    // `command` is the operation label of THIS acquirer — a contending caller
    // reads it back from the live lock's holder.json.
    holderInfo: {
      pid: process.pid,
      hostname: hostname(),
      command: label,
      acquiredAt: new Date().toISOString(),
    },
    // On a live-lock fail-fast, build the holder-aware contention message
    // (doc Error UX 'main lock contention'). An explicit `heldMessage` still
    // wins so callers like the DONE flow can keep legacy wording.
    onContentionHeld: (holder, holderAgeMs) =>
      options.heldMessage ??
      buildMainWriteLockContentionMessage(label, holder, holderAgeMs),
  });
}

/**
 * Acquire the main write lock, run `fn`, then release it (release always runs,
 * even when `fn` throws).
 *
 * NOTE: this is the NON-reentrant primitive. A second call against the same
 * `mainRepoRoot` while the lock is still held — even from the same process —
 * fails fast. Shared-write commands that can nest (`audit` triggered from the
 * DONE flow, etc.) MUST use `withReentrantMainWriteLock` instead.
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

/**
 * Process-level set of `mainRepoRoot` paths whose main write lock is currently
 * held by THIS process inside a `withReentrantMainWriteLock` critical section.
 *
 * The on-disk mkdir lock is a cross-PROCESS mutex. Within a single Node process
 * JS is single-threaded, so two critical sections can only interleave by direct
 * function nesting (e.g. the DONE merge holds the lock and then runs `audit`
 * in-process, which also wants the lock). Re-acquiring the same mkdir dir in
 * that case throws `failFastIfHeld` — a self-deadlock. This set lets the
 * OUTERMOST `withReentrantMainWriteLock` own the real on-disk lock while every
 * NESTED same-process call becomes a pass-through that just runs `fn`.
 *
 * Keyed by the resolved canonical lock path so a story worktree and the main
 * checkout (which resolve to the same `mainWriteLockPath`) share one key.
 */
const heldLockPaths = new Set<string>();

/**
 * Reentrant variant of `withMainWriteLock`.
 *
 * - First (outermost) call for a given `mainRepoRoot` acquires the real on-disk
 *   mkdir lock, records the path in `heldLockPaths`, runs `fn`, then releases
 *   the lock and clears the record (release + clear always run, even on throw).
 * - A NESTED call for the SAME `mainRepoRoot` from the same process sees the
 *   path already in `heldLockPaths` and runs `fn` directly WITHOUT re-acquiring
 *   — no self-deadlock. In-process serialization is already guaranteed by JS's
 *   single thread, so the nested section needs no separate mutex.
 * - A call from ANOTHER process still contends on the on-disk mkdir lock and
 *   fails fast if it is held (cross-process mutual exclusion is unchanged).
 *
 * Use this for every shared-main / B-META write entrypoint that could nest
 * (`gap_log`, `audit`, `story_create`, B-META `finding_*`, `done_recover`).
 */
export function withReentrantMainWriteLock<T>(
  mainRepoRoot: string,
  fn: () => T,
  options: MainWriteLockOptions = {},
): T {
  // Re-validate the same invariant `acquireMainWriteLock` enforces so the
  // reentrancy key is never an empty string (which would alias every empty
  // root into one bogus shared key).
  const root = String(mainRepoRoot ?? '').trim();
  if (!root) {
    throw new Error('withReentrantMainWriteLock: mainRepoRoot is required');
  }
  const lockKey = mainWriteLockPath(root);

  // Nested same-process call: the outer frame already owns the on-disk lock.
  if (heldLockPaths.has(lockKey)) {
    return fn();
  }

  const lock = acquireMainWriteLock(root, options);
  heldLockPaths.add(lockKey);
  try {
    return fn();
  } finally {
    heldLockPaths.delete(lockKey);
    lock.release();
  }
}

/**
 * Test-only: report whether THIS process currently holds the reentrant main
 * write lock for `mainRepoRoot`. Used by smoke tests to assert the outermost /
 * nested bookkeeping; not part of the production control flow.
 */
export function isMainWriteLockHeldInProcess(mainRepoRoot: string): boolean {
  const root = String(mainRepoRoot ?? '').trim();
  if (!root) return false;
  return heldLockPaths.has(mainWriteLockPath(root));
}

/**
 * Acquire the main write lock AND register it in the in-process reentrancy
 * registry, so a NESTED `withReentrantMainWriteLock` for the same
 * `mainRepoRoot` (e.g. `audit` triggered in-process by the DONE flow) becomes a
 * pass-through instead of self-deadlocking on the on-disk lock.
 *
 * This is for callers that need the raw `acquire` / `release` shape (an
 * explicit lock object held across an `actor.send` boundary) rather than the
 * `withReentrantMainWriteLock` callback form — the DONE merge critical section
 * in `transition-orchestrator.ts` is the canonical such caller.
 *
 * The returned handle's `release()` clears the registry entry FIRST, then
 * removes the on-disk lock dir. Both run even if the caller's critical section
 * threw. If the path is already registered (a reentrant acquire), `release()`
 * is a no-op — the outer frame still owns the real lock.
 */
export function acquireMainWriteLockRegistered(
  mainRepoRoot: string,
  options: MainWriteLockOptions = {},
): AcquiredMkdirLock {
  const root = String(mainRepoRoot ?? '').trim();
  if (!root) {
    throw new Error('acquireMainWriteLockRegistered: mainRepoRoot is required');
  }
  const lockKey = mainWriteLockPath(root);

  // Already held by an outer frame in this process — hand back a no-op handle.
  if (heldLockPaths.has(lockKey)) {
    return { lockDir: lockKey, release() { /* outer frame owns the lock */ } };
  }

  const lock = acquireMainWriteLock(root, options);
  heldLockPaths.add(lockKey);
  let released = false;
  return {
    lockDir: lock.lockDir,
    release() {
      if (released) return;
      released = true;
      heldLockPaths.delete(lockKey);
      lock.release();
    },
  };
}
