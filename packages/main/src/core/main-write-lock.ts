/**
 * B-f60c CHK-001: unified main write lock.
 *
 * session-ownership-and-write-leases.md "Main Write Lock Rules" 1-3,6 require a
 * single global mkdir-style lock that serializes every shared write to main /
 * B-META metadata. This module is the canonical primitive for that lock:
 *
 *   - canonical lock path: `.proof-or-stop/locks/main-write.lock/` (resolved against the
 *     main repo root, so a story worktree and the main checkout contend on the
 *     SAME directory).
 *   - atomic acquire via `core/mkdir-lock.ts` (`mkdirSync` of a non-existent
 *     dir is atomic — exactly one caller wins the race).
 *   - mtime-based stale reclaim, sized to the DONE critical section (120s).
 *   - acquisition failure is BLOCKING — `failFastIfHeld` makes a live lock
 *     throw immediately instead of silently polling/optimistically proceeding
 *     (Rule 6: "Proof-or-Stop must not proceed optimistically").
 *
 * This generalizes the former DONE-only `done-effects.ts` `acquireDoneMainMergeLock`.
 * The old runtime lock path is retired; there is no back-compat alias — no
 * runtime cleanup / doctor code depended on the old literal lock name.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { hostname } from 'os';
import { join } from 'path';
import {
  acquireMkdirLock,
  type AcquiredMkdirLock,
  type MkdirLockHolderInfo,
} from './mkdir-lock.js';
import { PROOF_OR_STOP_MAIN_WRITE_LOCK } from './proof-or-stop-paths.js';

/**
 * Canonical main write lock directory, relative to the main repo root.
 * Registered in `core/runtime-artifact-registry.ts` under `runtime-locks` so
 * doctor / stray-file scans treat it as managed volatile runtime state.
 */
export const MAIN_WRITE_LOCK_REL = PROOF_OR_STOP_MAIN_WRITE_LOCK;

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
  const retry = 'Retry after the active operation completes, or run `proof-or-stop doctor` if it appears stuck.';
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
    `${label} is blocked: the main write lock is held by another Proof-or-Stop operation ` +
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
   * holder. Defaults to a generic "held by another Proof-or-Stop operation" message.
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
 * Atomic mkdir acquire at `.proof-or-stop/locks/main-write.lock/`. A stale lock (mtime
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
 * held by THIS process inside a reentrant main-write critical section.
 *
 * The on-disk mkdir lock is a cross-PROCESS mutex. This set is the PROCESS-level
 * bookkeeping: it answers "does some critical section in THIS process currently
 * hold the on-disk lock for this path". It is NOT sufficient on its own to
 * decide reentrancy — see `lockOwnerStore` below. It is kept EXACTLY as before
 * (add on outermost acquire, delete on release) so cross-process behavior and
 * `isMainWriteLockHeldInProcess`'s smoke contract are unchanged.
 *
 * Keyed by the resolved canonical lock path so a story worktree and the main
 * checkout (which resolve to the same `mainWriteLockPath`) share one key.
 */
const heldLockPaths = new Set<string>();

/**
 * B-3d39: async-context-aware ownership registry.
 *
 * `heldLockPaths` alone mis-classifies a CONCURRENT async sibling as a nested
 * reentrant caller. Node is single-threaded for synchronous code, but a
 * critical section held across `await` (the DONE merge holds the lock across
 * `actor.send`) YIELDS the event loop. While it is parked, a concurrent
 * operation for another story (e.g. INIT_CHECK) runs in a SEPARATE async
 * context. Deciding reentrancy purely on `heldLockPaths.has(lockKey)` would let
 * that sibling skip real acquisition and write to main mid-merge — silently
 * dropping the DONE story's merge commit.
 *
 * This `AsyncLocalStorage` carries the set of lockKeys owned by the CURRENT
 * async context. The reentrancy predicate is now "the process holds the lock
 * AND this very async context is the owner" (`currentContextOwns`). Genuine
 * synchronous nesting (DONE → in-process `audit`) runs INSIDE the owning
 * context and inherits the owner set → passes through with no self-deadlock. A
 * concurrent sibling in a different context is NOT an owner → it contends on the
 * on-disk mkdir lock exactly as a separate process would.
 *
 * The on-disk mkdir mutex (acquire / mtime stale reclaim / failFastIfHeld) is
 * untouched; this only refines the in-process pass-through decision.
 */
const lockOwnerStore = new AsyncLocalStorage<Set<string>>();

/**
 * True iff the CURRENT async context owns `lockKey` (i.e. it is the context that
 * performed the outermost acquisition, or a synchronous/await descendant of it).
 * A concurrent sibling context returns false even when `heldLockPaths` has the
 * key, because it never entered the owner's store.
 */
function currentContextOwns(lockKey: string): boolean {
  return lockOwnerStore.getStore()?.has(lockKey) ?? false;
}

/**
 * Build the owner set for an outermost acquisition: the current context's set
 * (if any) extended with `lockKey`, otherwise a fresh single-entry set. A copy
 * is returned so the parent context's set is never mutated in place.
 */
function extendedOwnerSet(lockKey: string): Set<string> {
  const current = lockOwnerStore.getStore();
  const next = current ? new Set(current) : new Set<string>();
  next.add(lockKey);
  return next;
}

/**
 * Reentrant variant of `withMainWriteLock`.
 *
 * - First (outermost) call for a given `mainRepoRoot` acquires the real on-disk
 *   mkdir lock, records the path in `heldLockPaths`, runs `fn` INSIDE the
 *   async-context owner store, then releases the lock and clears the record
 *   (release + clear always run, even on throw). The owner store unwinds
 *   automatically when `lockOwnerStore.run` returns.
 * - A NESTED call for the SAME `mainRepoRoot` from the SAME async context sees
 *   the path in `heldLockPaths` AND that this context owns it, so it runs `fn`
 *   directly WITHOUT re-acquiring — no self-deadlock. Synchronous nesting and
 *   `await` descendants share the owner store, so the in-process serialization
 *   that JS's single thread already guarantees needs no separate mutex.
 * - A CONCURRENT async sibling (a different context whose own work interleaves
 *   while the outer holder is parked at an `await`) is NOT an owner of the key,
 *   so it does NOT pass through — it contends on the on-disk mkdir lock exactly
 *   as a separate process would (wait or fail-fast per `options`).
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

  // Nested same-CONTEXT call: the outer frame already owns the on-disk lock AND
  // this very async context is its owner. A concurrent sibling that merely sees
  // the process-level `heldLockPaths` entry (but never entered the owner store)
  // fails this check and falls through to real acquisition.
  if (heldLockPaths.has(lockKey) && currentContextOwns(lockKey)) {
    return fn();
  }

  const lock = acquireMainWriteLock(root, options);
  heldLockPaths.add(lockKey);
  try {
    // Run the critical section inside the owner store so synchronous nesting and
    // `await` descendants are recognized as owners. `run` restores the previous
    // store when it returns (including on throw), so the context unwinds without
    // explicit cleanup.
    return lockOwnerStore.run(extendedOwnerSet(lockKey), fn);
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
 * threw. If the path is already owned by THIS async context (a reentrant
 * acquire), `release()` is a no-op — the outer frame still owns the real lock.
 *
 * B-3d39 async-context: this is the acquire/release-PAIR form. By itself it does
 * NOT establish the async-context owner store — see the design note below.
 * Reentrancy still requires `currentContextOwns(lockKey)`, so the caller MUST
 * wrap the lock's lifetime (acquire → critical section across `await` → release)
 * in `runWithMainWriteLockContext(fn)`. This acquire then records the resolved
 * lock key into that scope's store. Without the wrap the first acquire is a real
 * (contending) acquisition and a same-context nested acquire would NOT be
 * recognized as reentrant.
 *
 * WHY NOT `enterWith` here: `enterWith` mutates the store for the REMAINDER of
 * the CURRENT async execution, which — when the holder was kicked off
 * synchronously alongside siblings (e.g. `Promise.all([holder(), sibling()])`)
 * — leaks the owner set up into the shared parent context and across to the
 * concurrent sibling. That is precisely the mis-classification B-3d39 fixes, so
 * ownership MUST be scoped with `lockOwnerStore.run` (a bounded callback), which
 * the pair form cannot do internally. Hence `runWithMainWriteLockContext`.
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

  // Already owned by an outer frame in THIS async context — hand back a no-op
  // handle. A concurrent sibling that only sees `heldLockPaths` (but is not the
  // owning context) fails `currentContextOwns` and acquires for real below.
  if (heldLockPaths.has(lockKey) && currentContextOwns(lockKey)) {
    return { lockDir: lockKey, release() { /* outer frame owns the lock */ } };
  }

  const lock = acquireMainWriteLock(root, options);
  heldLockPaths.add(lockKey);
  // Mark the CURRENT context's owner set (established by an enclosing
  // `runWithMainWriteLockContext`) as owning this key, so a same-context nested
  // acquire is recognized as reentrant. If the caller did not establish a
  // context, there is no store to mutate and the cross-process on-disk mutex
  // still fully serializes — only the in-process reentrancy optimization is
  // forfeited (a nested same-context acquire would then contend).
  lockOwnerStore.getStore()?.add(lockKey);
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

/**
 * B-3d39: establish an isolated async-context owner scope, then run `fn` inside
 * it. This is the context establisher for the acquire/release-PAIR form of the
 * main write lock.
 *
 * `acquireMainWriteLockRegistered` returns a handle whose lock is released later
 * (across `await` boundaries), so it cannot wrap the caller's critical section
 * in `lockOwnerStore.run` itself. Callers that hold the lock in pair form (the
 * DONE merge in `transition-orchestrator.ts`) wrap the WHOLE lock lifetime —
 * acquire, the awaited critical section, and release — in this helper.
 *
 * The scope is a COPY of any inherited owner set (so an enclosing context's
 * keys are preserved) but adds NO key of its own: the subsequent
 * `acquireMainWriteLockRegistered` populates the resolved lock key into THIS
 * scope's store when it actually acquires. Establishing the scope here (rather
 * than pre-seeding a key) sidesteps any mismatch between the caller's idea of
 * the lock root and the root the registered acquire resolves internally.
 *
 * The `run` scope bounds ownership to exactly this async subtree: synchronous
 * nesting and `await` descendants inherit it, while a CONCURRENT sibling
 * transition kicked off from the shared parent does NOT (a sibling has its own
 * `run` scope, or none — proven by the B-3d39 interleave smoke). Ownership
 * unwinds automatically when `fn` returns or throws.
 */
export function runWithMainWriteLockContext<T>(fn: () => T): T {
  const current = lockOwnerStore.getStore();
  // Fresh per-subtree store, inheriting any keys the enclosing context owns.
  const scoped = current ? new Set(current) : new Set<string>();
  return lockOwnerStore.run(scoped, fn);
}
