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
// node: built-ins) so bin/bootstrap-runner.js can import them WITHOUT proper-lockfile
// entering its STATIC graph — a module-init import of this file would
// ERR_MODULE_NOT_FOUND in a fresh checkout before the recovery hint can print.
// SCOPE (B-bcae F-049): that is a static-reachability property, not a whole-module
// prohibition. Once dist is known to be present, bootstrap DOES reach this module —
// and therefore proper-lockfile — by DYNAMIC import for reader admission, and an
// unresolvable dependency there is reported through printBootstrapFailure rather than
// crashing (red-1734-bootstrap-depfree.mjs's depfree:4 executes exactly that path).
// This module (build-lock.mjs) is the only one that needs proper-lockfile.
import { BUILD_LOCK_STALE_MS, buildLockTarget, distImportLockTarget } from './build-lock-target.mjs';
// Re-export buildLockTarget for callers that historically imported it from here.
export { buildLockTarget, distImportLockTarget, BUILD_LOCK_STALE_MS };

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

// READER-ADMISSION options (B-bcae F-060). Same stale / update / retry contract as a
// build — sharing one budget is the point (see the IMPORT_WAIT_MAX_MS note in
// bin/bootstrap-runner.js) — but `realpath: false`, so proper-lockfile resolves the
// target with path.resolve instead of fs.realpath and never requires it to EXIST.
// Reader admission therefore needs no pre-created target file: acquiring it creates only
// the `<target>.lock` directory, which release removes, so an ordinary CLI startup leaves
// nothing behind under os.tmpdir(). Both spellings of os.tmpdir() (the /var symlink and
// its /private/var realpath) name the same directory entry, so mkdir-based mutual
// exclusion is unaffected by skipping the realpath resolution.
export const DIST_IMPORT_LOCK_OPTIONS = Object.freeze({ ...BUILD_LOCK_OPTIONS, realpath: false });

// Per-target acquisition policy. buildLockTarget is materialised as a real (empty) file
// because its build-in-progress observers realpath it; distImportLockTarget is not.
const BUILD_TARGET_POLICY = Object.freeze({ kind: 'build' });
const DIST_IMPORT_TARGET_POLICY = Object.freeze({ kind: 'reader-admission' });

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

// ORDERING NOTE, load-bearing. The BUILD acquisition below must remain the FIRST call to
// the lock library's acquire method in this file, and must keep passing the reviewed
// options object by name rather than an inline literal. Two shipped guards read this file
// as text: red-1734-lock-liveness.mjs's edge:2 inspects the FIRST such call for the
// reviewed options and for the absence of an inline `fs:` strategy override, and
// red-bfe8f-ledger-runtime-integrity.mjs pins that call as the evidence that the build
// mutex is the reviewed cross-process primitive. So do not reorder these two functions,
// and do not lift the reader-admission acquisition above this one. (Nothing in this
// comment may spell that call either — a prose mention would be matched instead of the
// code, and both guards would then be inspecting a sentence.)
async function executeBuildLockJob(target, policy, fn) {
  let compromised = null;
  let release;
  if (policy.kind === 'build') {
    // Create-or-open the lock target so proper-lockfile can realpath it, then take the
    // reviewed primitive with the reviewed options, unchanged. Every admitted job still
    // acquires the cross-process lock independently.
    closeSync(openSync(target, 'a'));
    release = await lockfile.lock(target, BUILD_LOCK_OPTIONS);
  } else {
    // READER ADMISSION. proper-lockfile's DEFAULT onCompromised RETHROWS, and it is called
    // from inside an fs callback on the heartbeat timer — off this await chain entirely —
    // so an ECOMPROMISED becomes an uncaughtException that kills the process with a raw
    // stack instead of bin/bootstrap-runner.js's recovery block (B-bcae F-050). Capture it
    // here and decide deterministically below, inside this awaited job. SCOPE, stated
    // rather than implied: this handler covers the target bootstrap acquires — the channel
    // this Story introduced onto the universal startup path. A build that loses
    // buildLockTarget still takes the library default, which for a build script is a loud
    // non-zero exit rather than a swallowed recovery hint; that is pre-existing and
    // deliberately not changed here.
    release = await acquireReaderAdmission(target, {
      ...DIST_IMPORT_LOCK_OPTIONS,
      onCompromised: (error) => { compromised = compromised ?? error; },
    });
  }
  let jobFailed = false;
  try {
    return await fn();
  } catch (error) {
    jobFailed = true;
    throw error;
  } finally {
    try {
      await release();
    } catch (releaseError) {
      // A compromised lock is ALREADY marked released, so release() rejects with ERELEASED.
      // That is a consequence of the compromise, never the actionable cause — and if fn()
      // itself failed, ITS error is what the operator needs. Surface a release failure only
      // when it is neither.
      if (compromised === null && !jobFailed) throw releaseError;
    }
    if (compromised !== null && !jobFailed) {
      // Mutual exclusion was LOST mid-section: another process reclaimed this target as
      // stale, so what fn() observed may straddle a promotion. Fail closed with the real
      // cause rather than returning a result the mutex no longer backs.
      throw compromised;
    }
  }
}

// Contention must WAIT — that is exactly what the retry budget buys — but an ENVIRONMENTAL
// acquisition failure must not burn it. proper-lockfile retries on ANY error its mkdir
// returns, so on a read-only or full os.tmpdir() a reader would sleep out the whole
// ~10 minute budget before reporting an EROFS / ENOSPC / EACCES it already knew about on
// the first attempt. The build path fails fast on such a temp directory when it creates its
// target file; reader admission creates none (B-bcae F-060), so it needs this instead: one
// zero-retry attempt, where ELOCKED means somebody holds it and falls through to the real
// budgeted acquisition, and anything else is raised immediately.
async function acquireReaderAdmission(target, options) {
  try {
    return await lockfile.lock(target, { ...options, retries: 0 });
  } catch (error) {
    if (error && error.code === 'ELOCKED') return lockfile.lock(target, options);
    throw error;
  }
}

async function drainAdmissionQueue(target, queue) {
  if (queue.running) return;
  queue.running = true;
  while (queue.jobs.length > 0) {
    const job = queue.jobs.shift();
    try {
      job.resolve(await executeBuildLockJob(target, job.policy, job.fn));
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

// There is deliberately no reader-admission twin of buildLockAdmissionState (B-bcae F-038).
// The one that existed had no caller anywhere: a symmetry-only export reads as supported
// public surface and is carried and maintained indefinitely while nothing exercises it, and
// nothing here needs the reader-admission queue's in-process depth. What IS needed is
// covered: distImportLockInProgress below answers the cross-process question, and
// buildLockAdmissionTargetCount reports how many targets have a live queue. Reintroduce a
// per-target reader-admission observer only together with a consumer and the smoke coverage
// its build-target sibling already has in finding-ledger-runtime-smoke.ts.
export function buildLockAdmissionTargetCount() {
  return buildLockAdmissionQueues.size;
}

/**
 * Canonical read-only observation of the same proper-lockfile mutex.
 *
 * This answers "is a BUILD running?", so it deliberately reads only buildLockTarget.
 * A bootstrap reader admitted through withDistImportLock holds a different target and
 * must NOT be reported here (B-bcae F-033): the identical predicate is inlined as
 * canonicalBuildLockInProgress in packages/main/src/handlers/finding-ledger.ts, where a
 * false positive refuses finding_runtime_evidence_run with build_in_progress.
 */
export async function buildLockInProgress(repoKey) {
  const target = buildLockTarget(repoKey);
  if (!existsSync(target)) return false;
  return lockfile.check(target, BUILD_LOCK_OPTIONS);
}

/**
 * Read-only observation of the reader-admission target. Never a build claim.
 *
 * No existsSync precondition, unlike buildLockInProgress: reader admission creates no
 * target FILE (B-bcae F-060), so the answer must come from the `<target>.lock` DIRECTORY,
 * which is what check() stats. It reads with the same realpath:false the lock is taken
 * with, so observer and holder resolve the same path.
 */
export async function distImportLockInProgress(repoKey) {
  return lockfile.check(distImportLockTarget(repoKey), DIST_IMPORT_LOCK_OPTIONS);
}

// Acquire one target's mutex, run fn while holding it, and ALWAYS release — on normal
// completion AND on error (executeBuildLockJob's finally), so a failed tsc never leaks
// the lock and deadlocks every subsequent build.
function withLockedTarget(target, policy, fn) {
  return new Promise((resolve, reject) => {
    const queue = admissionQueueFor(target);
    if (queue.jobs.length >= BUILD_LOCK_MAX_IN_PROCESS_WAITERS) {
      const error = new Error(`build lock admission queue is full for ${target}`);
      error.code = 'EBUILDLOCKQUEUEFULL';
      reject(error);
      return;
    }
    queue.jobs.push({ fn, policy, resolve, reject });
    void drainAdmissionQueue(target, queue);
  });
}

// A genuine BUILD. Takes buildLockTarget (so every build-in-progress observer sees it and
// so builders serialize against each other) and then, nested inside it, the reader-admission
// target (so a bootstrap reader cannot import a dist tree this build is about to promote).
// The order is fixed here and nowhere acquires the pair in reverse — see the ordering note
// on distImportLockTarget in build-lock-target.mjs.
export async function withBuildLock(repoKey, fn) {
  return withLockedTarget(
    buildLockTarget(repoKey), BUILD_TARGET_POLICY,
    () => withLockedTarget(distImportLockTarget(repoKey), DIST_IMPORT_TARGET_POLICY, fn),
  );
}

// READER admission (bin/bootstrap-runner.js's initial dist import). Mutually exclusive with
// withBuildLock's critical section, but it takes ONLY the reader-admission target, so it is
// never observed as a build and never contends with a canonical build critical section that
// holds buildLockTarget alone.
export async function withDistImportLock(repoKey, fn) {
  return withLockedTarget(distImportLockTarget(repoKey), DIST_IMPORT_TARGET_POLICY, fn);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
  && process.argv[2] === '--proof-or-stop-check') {
  const repoKey = process.argv[3];
  if (!repoKey) process.exitCode = 64;
  else process.exitCode = await buildLockInProgress(repoKey) ? 75 : 0;
}
