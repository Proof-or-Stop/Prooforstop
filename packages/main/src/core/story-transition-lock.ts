import { hostname } from 'os';
import { acquireMkdirLock, type AcquiredMkdirLock, type MkdirLockOptions } from './mkdir-lock.js';
import type { StoryStore } from './store.js';

/**
 * B-d877 CHK-002: per-story transition lock.
 *
 * `runStoryTransition` reads the story then persists the new phase + review
 * round NON-atomically, and the owner lease rejects only FOREIGN sessions — so
 * two concurrent SAME-owner transitions can both act on the same pre-transition
 * state and double-mint review rounds / double-append phase_transition events.
 *
 * Holding this lock across read → gate → persist for NON-DONE transitions
 * serializes same-owner concurrency: the second attempt blocks until the first
 * commits, then re-reads the committed state (and its guard correctly refuses a
 * second advance from the already-advanced phase).
 *
 * This REUSES the shared atomic mkdir-lock primitive (core/mkdir-lock.ts) — the
 * exact mechanism `withChecklistLock` / `story_create` use — instead of
 * hand-rolling a lock. `mkdir` of a non-existent directory is atomic on
 * POSIX/Win32, so exactly one caller wins across SEPARATE PROCESSES; this
 * serializes concurrent `lattice story_advance` CLI invocations, not merely
 * in-process callers.
 *
 * DONE transitions must NOT take this lock: they already hold the unified main
 * write lock (`acquireDoneMainMergeLock`) across the same span, so the
 * orchestrator only acquires this for `args.phase !== 'DONE'` (no double-lock).
 */

/** Lock-directory filename under a story's metadata dir. */
export const STORY_TRANSITION_LOCK_FILE = 'transition.lock';

/**
 * Stale threshold generously exceeds any legitimate non-DONE transition
 * (including a slow REVIEW→TEST validate gate) so a live holder is never
 * reclaimed mid-transition, while a genuinely crashed holder is still reclaimed
 * before the deadline. Deadline is kept strictly above stale (mkdir-lock
 * invariant) so a waiter polls past the stale threshold and can reclaim a dead
 * holder before giving up.
 */
const STORY_TRANSITION_STALE_MS = 120_000;
const STORY_TRANSITION_DEADLINE_MS = 180_000;

export interface StoryTransitionLockOptions {
  /** Override the acquire deadline (ms). Defaults to STORY_TRANSITION_DEADLINE_MS. */
  deadlineMs?: number;
  /** Override the stale-reclaim threshold (ms). Defaults to STORY_TRANSITION_STALE_MS. */
  staleMs?: number;
}

/** Resolve the per-story transition lock directory path. */
export function storyTransitionLockDir(store: StoryStore, storyId: string): string {
  return store.storyFilePath(storyId, STORY_TRANSITION_LOCK_FILE);
}

/**
 * Acquire the per-story transition lock. Returns an { lockDir, release } handle;
 * the caller MUST release it in a `finally` so a throwing critical section
 * cannot leak the lock (no deadlock for the next transition).
 */
export function acquireStoryTransitionLock(
  store: StoryStore,
  storyId: string,
  options: StoryTransitionLockOptions = {},
): AcquiredMkdirLock {
  const lockDir = storyTransitionLockDir(store, storyId);
  const opts: MkdirLockOptions = {
    deadlineMs: options.deadlineMs ?? STORY_TRANSITION_DEADLINE_MS,
    staleMs: options.staleMs ?? STORY_TRANSITION_STALE_MS,
    label: `story transition (${storyId})`,
    holderInfo: {
      pid: process.pid,
      hostname: hostname(),
      command: `story transition for ${storyId}`,
      acquiredAt: new Date().toISOString(),
    },
  };
  return acquireMkdirLock(lockDir, opts);
}
