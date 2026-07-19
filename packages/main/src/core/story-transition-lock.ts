import { hostname } from 'os';
import { join } from 'path';
import {
  acquireMkdirLock,
  type AcquiredMkdirLock,
  type ExistingMkdirLockState,
  type ExistingMkdirLockSnapshot,
  type MkdirLockOptions,
} from './mkdir-lock.js';
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
 * B-d877 Finding 2: ALL phases (including DONE) now UNIFORMLY acquire this
 * per-story transition lock. A DONE and a concurrent SAME-story NON-DONE
 * transition (e.g. a rollback) previously took DIFFERENT locks (DONE serialized
 * only on `acquireDoneMainMergeLock`) and thus did not mutually exclude. The
 * orchestrator now takes this lock for every phase; for DONE it acquires this
 * lock BEFORE `acquireDoneMainMergeLock` (fixed ordering transitionLock →
 * doneMainMergeLock). A NON-DONE transition only ever takes this lock, so the
 * ordering is total and there is no circular wait / deadlock.
 *
 * B-d877 Finding 1(b): the acquire passes a `classifyExistingLock` callback so a
 * live-but-CPU-starved holder is never mis-reclaimed as stale mid-transition. A
 * same-host holder whose recorded pid is still alive is classified `active`
 * (never reclaimed regardless of mtime/starvation); a same-host holder whose pid
 * is dead (kill → ESRCH) is `stale` (reclaimed); anything else (no holder /
 * different host) is `unknown` and falls back to the mtime staleMs check.
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

/**
 * B-d877 Finding 1(b): liveness classifier for an existing transition lock.
 *
 * A live-but-CPU-starved holder can outlive the 120s mtime staleMs while merely
 * starved (not dead); the default mtime check would then wrongly reclaim it and
 * BOTH transitions would run (double-mint). This classifier consults the recorded
 * holder pid/hostname instead of mtime alone:
 *  - same host + pid alive (`process.kill(pid, 0)` does not throw, or throws
 *    EPERM → the process EXISTS but is not signalable by us) → `active`
 *    (NEVER reclaimed, regardless of starvation);
 *  - same host + pid dead (`process.kill` throws ESRCH) → `stale` (reclaimed);
 *  - no holder / different hostname / any other errno → `unknown` (the acquire
 *    falls back to the mtime staleMs check).
 */
export function classifyTransitionLockHolder(
  snapshot: ExistingMkdirLockSnapshot,
): ExistingMkdirLockState {
  const holder = snapshot.holder;
  // No readable holder metadata, or a different host: we cannot probe liveness
  // locally, so defer to the mtime staleMs heuristic.
  if (!holder || holder.hostname !== hostname()) return 'unknown';
  if (!Number.isInteger(holder.pid) || holder.pid <= 0) return 'unknown';
  try {
    // Signal 0 performs error checking without delivering a signal: success means
    // the process exists and we may signal it → the holder is alive.
    process.kill(holder.pid, 0);
    return 'active';
  } catch (e: any) {
    // ESRCH = no such process → the holder crashed → reclaim as stale.
    if (e && e.code === 'ESRCH') return 'stale';
    // EPERM (and any other errno) means the process EXISTS but we may not signal
    // it → treat as ALIVE so a live holder is never reclaimed mid-transition.
    return 'active';
  }
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
    classifyExistingLock: classifyTransitionLockHolder,
    holderInfo: {
      pid: process.pid,
      hostname: hostname(),
      command: `story transition for ${storyId}`,
      acquiredAt: new Date().toISOString(),
    },
  };
  return acquireMkdirLock(lockDir, opts);
}
