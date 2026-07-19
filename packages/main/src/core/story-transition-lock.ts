import { hostname } from 'os';
import { join } from 'path';
import { acquireMkdirLock, type AcquiredMkdirLock, type MkdirLockOptions } from './mkdir-lock.js';
import { LATTICE_DIR } from './lattice-paths.js';

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
 * LOCK LOCATION — the lock MUST live OUTSIDE the story's committed/scanned
 * metadata dir. An earlier revision rooted it at `<storyDir>/transition.lock/`,
 * i.e. inside `.lattice/story/actives/<id>/`; the scope gate running in the SAME
 * transition then saw the just-created `transition.lock/holder.json` as an
 * out-of-scope change and hard-failed every non-DONE transition (self-inflicted
 * deadlock). Mirroring `validation-execution-lock.ts` / `main-write-lock.ts`,
 * the lock now roots under `.lattice/locks/transition/<sanitized-id>.lock`,
 * which is already gitignored (`.gitignore` `.lattice/locks/`) and registered as
 * managed runtime state (runtime-artifact-registry `runtime-locks`, prefix
 * `.lattice/locks/`). It is a runtime artifact, never story-owned metadata.
 *
 * This REUSES the shared atomic mkdir-lock primitive (core/mkdir-lock.ts) — the
 * exact mechanism `withValidationExecutionLock` / `story_create` use — instead
 * of hand-rolling a lock. `mkdir` of a non-existent directory is atomic on
 * POSIX/Win32, so exactly one caller wins across SEPARATE PROCESSES; this
 * serializes concurrent `lattice story_advance` CLI invocations (and, like the
 * validation lock which roots at the same project root, transitions across
 * worktrees of the same story), not merely in-process callers.
 *
 * DONE transitions must NOT take this lock: they already hold the unified main
 * write lock (`acquireDoneMainMergeLock`) across the same span, so the
 * orchestrator only acquires this for `args.phase !== 'DONE'` (no double-lock).
 */

/** Lock-directory root (relative to the project root) for per-story transition locks. */
export const STORY_TRANSITION_LOCKS_REL = `${LATTICE_DIR}/locks/transition`;

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

/** Sanitize a story id into a safe single lock-file segment (mirrors validation-execution-lock). */
function sanitizeLockSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

export interface StoryTransitionLockOptions {
  /** Override the acquire deadline (ms). Defaults to STORY_TRANSITION_DEADLINE_MS. */
  deadlineMs?: number;
  /** Override the stale-reclaim threshold (ms). Defaults to STORY_TRANSITION_STALE_MS. */
  staleMs?: number;
}

/**
 * Resolve the per-story transition lock directory path under the project root's
 * gitignored `.lattice/locks/transition/`. NOT under the story metadata dir.
 */
export function storyTransitionLockPath(root: string, storyId: string): string {
  const projectRoot = String(root ?? '').trim();
  const id = String(storyId ?? '').trim();
  if (!projectRoot) throw new Error('storyTransitionLockPath: root is required');
  if (!id) throw new Error('storyTransitionLockPath: storyId is required');
  return join(projectRoot, STORY_TRANSITION_LOCKS_REL, `${sanitizeLockSegment(id)}.lock`);
}

/**
 * Acquire the per-story transition lock. Returns an { lockDir, release } handle;
 * the caller MUST release it in a `finally` so a throwing critical section
 * cannot leak the lock (no deadlock for the next transition).
 */
export function acquireStoryTransitionLock(
  root: string,
  storyId: string,
  options: StoryTransitionLockOptions = {},
): AcquiredMkdirLock {
  const lockDir = storyTransitionLockPath(root, storyId);
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
