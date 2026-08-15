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
import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';

// stale (30s) and update (10s) satisfy update < stale/2 = 15s — the live-holder
// heartbeat invariant. retries make a concurrent builder wait (up to ~120 * 1s)
// for the holder to finish instead of failing or age-stealing.
export const BUILD_LOCK_OPTIONS = Object.freeze({
  stale: 30000,
  update: 10000,
  retries: { retries: 120, minTimeout: 200, maxTimeout: 1000, factor: 1 },
});

// A stable per-repo lock target under os.tmpdir(). proper-lockfile locks the
// sibling `<target>.lock`; we only need the target to exist so realpath resolves.
export function buildLockTarget(repoKey) {
  const digest = createHash('sha256').update(String(repoKey)).digest('hex');
  return join(tmpdir(), `lattice-build-lock-${digest}`);
}

// Acquire the mutex, run fn while holding it, and ALWAYS release — on normal
// completion AND on error (the finally below), so a failed tsc never leaks the
// lock and deadlocks every subsequent build.
export async function withBuildLock(repoKey, fn) {
  const target = buildLockTarget(repoKey);
  try {
    closeSync(openSync(target, 'a'));
  } catch {
    // best-effort target creation; proper-lockfile still guards the real race
  }
  const release = await lockfile.lock(target, BUILD_LOCK_OPTIONS);
  try {
    return await fn();
  } finally {
    await release();
  }
}
