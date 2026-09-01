// Cross-platform crash-safe build mutex (B-1734).
//
// The build has no lock today, which produced two Codex LOCK findings against
// B-fb7b: (1) an mtime-age stale-steal that age-stole a LIVE holder mid-build,
// and (2) a check-then-delete reclaim TOCTOU that let two waiters both enter the
// critical section. proper-lockfile fixes both with a portable primitive:
//
//   - It uses the DEFAULT mkdir strategy (create `<target>.lock` as a directory).
//     mkdir is atomic on every platform and needs no flock/fcntl/native module,
//     so this works identically on Mac, Linux, and Windows. We pass NO `fs` /
//     lockfilePath override, so the strategy is never swapped out.
//   - A LIVE holder keeps `<target>.lock`'s mtime fresh via the `update`
//     heartbeat. The CORRECTNESS INVARIANT is `update < stale / 2`: a live
//     holder always refreshes (every 10s) before the stale threshold (30s)
//     elapses, so a waiter can never age-steal a live long-running build.
//   - A DEAD holder (crashed process) stops refreshing; once `<target>.lock` is
//     older than `stale`, proper-lockfile's race-safe reclaim lets exactly one
//     waiter take it. `retries` makes concurrent builders wait rather than fail.
import { closeSync, existsSync, openSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import lockfile from 'proper-lockfile';
// buildLockTarget + the stale threshold live in a dependency-free module (only
// node: built-ins) so bin/bootstrap-runner.js can import them WITHOUT transitively
// loading proper-lockfile (which would ERR_MODULE_NOT_FOUND in a fresh checkout).
// This module (build-lock.mjs) is the only one that needs proper-lockfile.
import { BUILD_LOCK_STALE_MS, buildLockTarget } from './build-lock-target.mjs';
// Re-export buildLockTarget for callers that historically imported it from here.
export { buildLockTarget, BUILD_LOCK_STALE_MS };

// stale (30s) and update (10s) satisfy update < stale/2 = 15s — the live-holder
// heartbeat invariant. retries make a concurrent builder WAIT for the holder to
// finish instead of failing or age-stealing. This is a REAL exponential backoff:
// minTimeout 200ms, ×factor 2 each attempt, capped at maxTimeout 1s (so the
// per-retry waits are 200, 400, 800, then 1000ms flat), 600 tries ≈ 598,000ms ≈
// 10 minutes total — responsive early yet generous enough that a single slow
// build on a loaded CI runner cannot exhaust the budget and crash the waiter with
// an uncaught ELOCKED (CHK-001: a concurrent builder WAITS, never crashes).
// factor:2 is what makes this a real backoff: the earlier factor:1 collapsed
// minTimeout*1^attempt to a FLAT 200ms for all 120 retries → only 24,000ms total,
// far short of the ~120s the old comment claimed.
export const BUILD_LOCK_OPTIONS = Object.freeze({
  // stale comes from the dep-free single source of truth (build-lock-target.mjs) so
  // the mutex threshold and bin/bootstrap-runner.js's buildInProgress() freshness
  // gate can never drift. Its numeric value is 30000ms (update 10000 < stale/2).
  stale: BUILD_LOCK_STALE_MS,
  update: 10000,
  retries: { retries: 600, minTimeout: 200, maxTimeout: 1000, factor: 2 },
});

// proper-lockfile guarantees mutual exclusion, stale recovery and cross-process
// correctness, but it does not promise arrival order between callers in the
// same JavaScript process. Keep a small admission queue per canonical target so
// in-process callers enter proper-lockfile in call order. Different targets use
// different queues and therefore remain independent.
const buildLockAdmissionQueues = new Map();
export const BUILD_LOCK_MAX_IN_PROCESS_WAITERS = 256;

function admissionQueueFor(target) {
  const current = buildLockAdmissionQueues.get(target);
  if (current) return current;
  const created = { running: false, jobs: [] };
  buildLockAdmissionQueues.set(target, created);
  return created;
}

async function executeBuildLockJob(target, fn) {
  // Create-or-open the lock target so proper-lockfile can realpath it. Every
  // admitted job still acquires the cross-process primitive independently.
  closeSync(openSync(target, 'a'));
  const release = await lockfile.lock(target, BUILD_LOCK_OPTIONS);
  try {
    return await fn();
  } finally {
    await release();
  }
}

async function drainAdmissionQueue(target, queue) {
  if (queue.running) return;
  queue.running = true;
  while (queue.jobs.length > 0) {
    const job = queue.jobs.shift();
    try {
      job.resolve(await executeBuildLockJob(target, job.fn));
    } catch (error) {
      // Reject this caller but continue draining: one failed build must not
      // poison later builds for the same target.
      job.reject(error);
    }
  }
  queue.running = false;
  if (queue.jobs.length === 0 && buildLockAdmissionQueues.get(target) === queue) {
    buildLockAdmissionQueues.delete(target);
  }
}

/** Read-only diagnostics used by build health checks. */
export function buildLockAdmissionState(repoKey) {
  const queue = buildLockAdmissionQueues.get(buildLockTarget(repoKey));
  return queue ? Object.freeze({ running: queue.running, waiting: queue.jobs.length }) : undefined;
}

export function buildLockAdmissionTargetCount() {
  return buildLockAdmissionQueues.size;
}

/** Canonical read-only observation of the same proper-lockfile mutex. */
export async function buildLockInProgress(repoKey) {
  const target = buildLockTarget(repoKey);
  if (!existsSync(target)) return false;
  return lockfile.check(target, BUILD_LOCK_OPTIONS);
}

// Acquire the mutex, run fn while holding it, and ALWAYS release — on normal
// completion AND on error (the finally below), so a failed tsc never leaks the
// lock and deadlocks every subsequent build.
export async function withBuildLock(repoKey, fn) {
  const target = buildLockTarget(repoKey);
  return new Promise((resolve, reject) => {
    const queue = admissionQueueFor(target);
    if (queue.jobs.length >= BUILD_LOCK_MAX_IN_PROCESS_WAITERS) {
      const error = new Error(`build lock admission queue is full for ${target}`);
      error.code = 'EBUILDLOCKQUEUEFULL';
      reject(error);
      return;
    }
    queue.jobs.push({ fn, resolve, reject });
    void drainAdmissionQueue(target, queue);
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
  && process.argv[2] === '--proof-or-stop-check') {
  const repoKey = process.argv[3];
  if (!repoKey) process.exitCode = 64;
  else process.exitCode = await buildLockInProgress(repoKey) ? 75 : 0;
}
