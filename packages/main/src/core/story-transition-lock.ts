import { hostname } from 'os';
import { join } from 'path';
import {
  acquireMkdirLock,
  type AcquiredMkdirLock,
  type ExistingMkdirLockState,
  type ExistingMkdirLockSnapshot,
  type MkdirLockOptions,
} from './mkdir-lock.js';
import { resolveSharedLockRoot } from './validation-execution-lock.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { readBrandEnv } from './brand-env.js';

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
 * ── CORRECTNESS BOUNDARY (B-d877 R3 FIX D — subsumes F-009) ────────────────────
 * This transition lock is a BEST-EFFORT ADVISORY CONTENTION-REDUCER, NOT the
 * correctness guarantee. Its job is to keep two concurrent transitions from
 * doing redundant gate work in parallel; it does NOT by itself make the
 * phase-persist atomic. The AUTHORITATIVE guarantee against a double-mint is the
 * ATOMIC PERSIST CLAIM in transition-orchestrator.ts (R3 FIX A): right before it
 * writes the new phase, the orchestrator acquires an atomic `mkdir` claim
 * (`.proof-or-stop/locks/transition-cas/<id>.claim`), RE-READS the on-disk phase under
 * that claim, and aborts unless it still equals the expected `oldPhase`. `mkdir`
 * is atomic on POSIX, so exactly one concurrent writer wins the claim; the loser
 * throws immediately. Because that claim — not this advisory lock — gates the
 * write, ANY mis-classification or stale-reclaim of THIS lock (e.g. F-009: the
 * PID-reuse start-time check can only fire for the waiter's OWN pid, since a
 * foreign pid's start time is not portably readable, so a starved foreign holder
 * could in principle be reclaimed and both transitions could proceed here) can
 * ONLY cause redundant gate work — NEVER a double-mint. This lock therefore does
 * not need a heartbeat or a perfectly-sound liveness classifier; the atomic claim
 * subsumes the liveness concern. A false-reclaim wastes a little CPU; it cannot
 * corrupt the phase.
 *
 * ── KNOWN LIMITATION (B-d877 R4, codex #1 residual — deliberately deferred) ────
 * The atomic persist claim itself uses a TIME-BASED stale reclaim (staleMs), so
 * it is NOT an absolute mutex against a holder that is OS-level frozen (e.g.
 * SIGSTOP) for LONGER than staleMs in the middle of the persist: a waiter could
 * then stale-reclaim a still-live holder's claim. Mitigation in place: the
 * persist critical section in the orchestrator (claim acquire → phase re-read →
 * checklist + story write → release) is FULLY SYNCHRONOUS — there is NO `await`
 * between acquire and release — so the JS runtime cannot preempt a live holder
 * mid-section; only an external multi-second OS process freeze could trip a
 * stale-reclaim of a live holder, which is outside the software-concurrency
 * threat model and is recoverable (re-run story_advance). Full fencing-token
 * hardening (a monotonic generation checked at commit, with crash → explicit
 * recovery instead of a time reclaim) is a deliberately-deferred follow-up.
 *
 * LOCK LOCATION — the lock MUST live OUTSIDE the story's committed/scanned
 * metadata dir. An earlier revision rooted it at `<storyDir>/transition.lock/`,
 * i.e. inside `.proof-or-stop/story/actives/<id>/`; the scope gate running in the SAME
 * transition then saw the just-created `transition.lock/holder.json` as an
 * out-of-scope change and hard-failed every non-DONE transition (self-inflicted
 * deadlock). Mirroring `validation-execution-lock.ts` / `main-write-lock.ts`,
 * the lock now roots under `.proof-or-stop/locks/transition/<sanitized-id>.lock`,
 * which is already gitignored (`.gitignore` `.proof-or-stop/locks/`) and registered as
 * managed runtime state (runtime-artifact-registry `runtime-locks`, prefix
 * `.proof-or-stop/locks/`). It is a runtime artifact, never story-owned metadata.
 *
 * This REUSES the shared atomic mkdir-lock primitive (core/mkdir-lock.ts) — the
 * exact mechanism `withValidationExecutionLock` / `story_create` use — instead
 * of hand-rolling a lock. `mkdir` of a non-existent directory is atomic on
 * POSIX/Win32, so exactly one caller wins across SEPARATE PROCESSES; this
 * serializes concurrent `proof-or-stop story_advance` CLI invocations (and, like the
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
export const STORY_TRANSITION_LOCKS_REL = `${PROOF_OR_STOP_DIR}/locks/transition`;

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

/** Best-effort start time of THIS process (ms epoch). Mirrors validation-execution-lock. */
function currentProcessStartTimeMs(): number {
  return Math.floor(Date.now() - (process.uptime() * 1000));
}

/**
 * True when two process start times are "the same" within a tolerance, OR when
 * either is unavailable (an older holder recorded none, or a live foreign pid
 * whose start time we cannot portably read) — in which case we conservatively
 * treat them as matching so a genuinely-live holder is never reclaimed. Mirrors
 * validation-execution-lock's `sameProcessStart`.
 */
function sameProcessStart(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) return true;
  return Math.abs(a - b) <= 2000;
}

/**
 * B-d877 Finding 1(b) + R2 FIX C: liveness classifier for an existing transition
 * lock, hardened against PID REUSE and ambiguous errno.
 *
 * A live-but-CPU-starved holder can outlive the 120s mtime staleMs while merely
 * starved (not dead); the default mtime check would then wrongly reclaim it and
 * BOTH transitions would run (double-mint). This classifier consults the recorded
 * holder pid/hostname/start-time instead of mtime alone:
 *  - different host / no holder / unreadable pid → `unknown` (fall back to mtime);
 *  - same host + pid dead (`process.kill` throws ESRCH) → `stale` (reclaimed);
 *  - same host + `process.kill` throws an errno OTHER than ESRCH/EPERM → `unknown`
 *    (that errno is NOT proof of liveness — defer to mtime rather than blindly
 *    asserting `active`);
 *  - same host + pid alive (kill ok, or EPERM = exists-but-not-signalable) AND —
 *    when it is THIS process's pid and both start times are known — the recorded
 *    `processStartTimeMs` matches the live start time → `active` (never reclaimed);
 *  - same host + THIS pid alive but a DIFFERENT recorded start time → `stale`: the
 *    pid was RECYCLED by a new incarnation, so the original holder is gone.
 */
export function classifyTransitionLockHolder(
  snapshot: ExistingMkdirLockSnapshot,
): ExistingMkdirLockState {
  const holder = snapshot.holder;
  // No readable holder metadata, or a different host: we cannot probe liveness
  // locally, so defer to the mtime staleMs heuristic.
  if (!holder || holder.hostname !== hostname()) return 'unknown';
  if (!Number.isInteger(holder.pid) || holder.pid <= 0) return 'unknown';

  let alive = false;
  try {
    // Signal 0 performs error checking without delivering a signal: success means
    // the process exists and we may signal it → alive (pending the reuse check).
    process.kill(holder.pid, 0);
    alive = true;
  } catch (e: any) {
    // ESRCH = no such process → the holder crashed → reclaim as stale.
    if (e && e.code === 'ESRCH') return 'stale';
    // EPERM = the process EXISTS but we may not signal it → alive.
    if (e && e.code === 'EPERM') {
      alive = true;
    } else {
      // Any OTHER errno is NOT proof of liveness — fall back to the mtime
      // staleMs heuristic instead of blindly asserting `active`.
      return 'unknown';
    }
  }
  if (!alive) return 'unknown';

  // PID-reuse guard: only computable for THIS process's pid (we cannot portably
  // read a foreign pid's start time). When the recorded holder is our own pid but
  // a DIFFERENT start time, the pid was recycled → the original holder is gone.
  if (
    holder.pid === process.pid &&
    !sameProcessStart(holder.processStartTimeMs, currentProcessStartTimeMs())
  ) {
    return 'stale';
  }
  return 'active';
}

export interface StoryTransitionLockOptions {
  /** Override the acquire deadline (ms). Defaults to STORY_TRANSITION_DEADLINE_MS. */
  deadlineMs?: number;
  /** Override the stale-reclaim threshold (ms). Defaults to STORY_TRANSITION_STALE_MS. */
  staleMs?: number;
}

/**
 * Resolve the per-story transition lock directory path under the DURABLE SHARED
 * root's gitignored `.proof-or-stop/locks/transition/`. NOT under the story metadata
 * dir.
 *
 * B-d877 R2 FIX B: anchor at `resolveSharedLockRoot(root)` (git-common-dir based),
 * exactly like the validation execution lock. `root` may be a story WORKTREE that
 * DONE later removes; resolving to the shared main-repo root makes the lock (a)
 * SURVIVE worktree removal and (b) IDENTICAL from every worktree/main root, so
 * cross-worktree / cross-invocation transitions for the same story contend on ONE
 * mutex. FAIL-OPEN: a non-git / unreadable root falls back to the resolved root.
 */
export function storyTransitionLockPath(root: string, storyId: string): string {
  const projectRoot = String(root ?? '').trim();
  const id = String(storyId ?? '').trim();
  if (!projectRoot) throw new Error('storyTransitionLockPath: root is required');
  if (!id) throw new Error('storyTransitionLockPath: storyId is required');
  const sharedRoot = resolveSharedLockRoot(projectRoot);
  return join(sharedRoot, STORY_TRANSITION_LOCKS_REL, `${sanitizeLockSegment(id)}.lock`);
}

/**
 * B-d877 R2 FIX E: canonical transition-lock dirs currently held IN THIS PROCESS.
 *
 * The mkdir lock polls with a SYNCHRONOUS `Atomics.wait`. If a transition holds
 * this lock across an `await` (releasing the event loop) and a SECOND same-process
 * transition for the SAME story tries to acquire, that synchronous poll would
 * block the event loop so the first transition can NEVER run its release → a full
 * acquire-deadline (~180s) deadlock. A same-process re-entrant transition for one
 * story is itself a self-deadlock bug, so `acquireStoryTransitionLock` fails FAST
 * when the canonical lock dir is already in this set (see below).
 */
const heldTransitionLockDirs = new Set<string>();

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
  // B-d877 R3: TEST-ONLY bypass of this ADVISORY contention-reducer. When
  // `PROOF_OR_STOP_TEST_DISABLE_TRANSITION_ADVISORY_LOCK=1`, acquire returns a no-op
  // handle without touching the on-disk lock or the in-process guard. This is SAFE
  // BY CONSTRUCTION: correctness against a double-mint is guaranteed by FIX A's
  // ATOMIC PERSIST CLAIM in transition-orchestrator.ts (see the CORRECTNESS
  // BOUNDARY note above / FIX D), NOT by this lock. Disabling it only removes
  // contention reduction (transitions may do redundant gate work in parallel) —
  // never correctness. transition-integrity-smoke sets it to prove the atomic claim
  // ALONE serializes two genuinely-concurrent persists into exactly one.
  if (readBrandEnv('TEST_DISABLE_TRANSITION_ADVISORY_LOCK') === '1') {
    return { lockDir, release() { /* no-op: advisory lock bypassed for test */ } };
  }
  // B-d877 R2 FIX E: in-process fail-fast guard — never enter the blocking mkdir
  // poll for a lock this very process already holds (that would deadlock the event
  // loop on the synchronous `Atomics.wait`).
  if (heldTransitionLockDirs.has(lockDir)) {
    throw new Error(
      `in-process concurrent transition for ${storyId} would deadlock the event loop ` +
      `on the synchronous lock; transitions must be serialized per process`,
    );
  }
  const opts: MkdirLockOptions = {
    deadlineMs: options.deadlineMs ?? STORY_TRANSITION_DEADLINE_MS,
    staleMs: options.staleMs ?? STORY_TRANSITION_STALE_MS,
    label: `story transition (${storyId})`,
    classifyExistingLock: classifyTransitionLockHolder,
    // B-d877 R2 FIX D: require a persisted ownership token so release() is ALWAYS
    // ownership-checked (never a token-less unconditional removal that could delete
    // a successor's lock after a stale-reclaim). The transition lock is thus never
    // in the token-less state.
    requireHolderToken: true,
    holderInfo: {
      pid: process.pid,
      hostname: hostname(),
      command: `story transition for ${storyId}`,
      acquiredAt: new Date().toISOString(),
      // B-d877 R2 FIX C: record the process start time so the liveness classifier
      // can tell a genuinely-live holder from a REUSED pid.
      processStartTimeMs: currentProcessStartTimeMs(),
    },
  };
  const inner = acquireMkdirLock(lockDir, opts);
  // Register in-process ownership only AFTER a successful acquire, so a failed
  // acquire (timeout / requireHolderToken failure) never leaves a phantom entry
  // that would wrongly trip the in-process guard for the next attempt.
  heldTransitionLockDirs.add(lockDir);
  let released = false;
  return {
    lockDir: inner.lockDir,
    release() {
      if (released) return;
      released = true;
      // Clear the in-process guard FIRST so a subsequent same-process transition
      // can acquire, then release the on-disk (ownership-checked) mkdir lock.
      heldTransitionLockDirs.delete(lockDir);
      inner.release();
    },
  };
}
