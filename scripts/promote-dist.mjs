// Crash-safe atomic dist promotion (B-1734 C2). Shared by build-main-with-binding.mjs
// and build-utils-with-binding.mjs so the crash-safety logic is written once and
// cannot drift between the two call sites.
//
// Promote a freshly built `staging` tree into `dist` by two renames: evict the old
// `dist` to `trash`, then move `staging` into place. If the SECOND rename fails
// AFTER the first succeeded, dist would otherwise be left ABSENT (old dist in trash,
// staging orphaned), bricking the CLI until the next build — so we RESTORE the old
// dist from trash before rethrowing.
//
// This module imports ONLY node: built-ins (node:fs / node:path) plus the equally
// dependency-free build-lock-target.mjs, so bin/bootstrap-runner.js can import
// recoverOrphanedPromotion WITHOUT transitively pulling in proper-lockfile (which
// would ERR_MODULE_NOT_FOUND in a fresh checkout).
import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BUILD_LOCK_STALE_MS, buildLockTarget } from './build-lock-target.mjs';

export function promoteDist(dist, staging, trash) {
  // Evict the old dist. ENOENT is the SOLE benign case (a first build has no prior
  // dist to evict); every other error (EACCES, EXDEV, …) surfaces. `evicted` records
  // whether trash now holds the old dist, so the restore path only runs when there is
  // something to restore.
  let evicted = false;
  try {
    renameSync(dist, trash);
    evicted = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    renameSync(staging, dist);
  } catch (error) {
    // staging→dist failed after we evicted the old dist: restore it so dist is never
    // left absent. Best-effort — if the restore itself fails we still rethrow the
    // ORIGINAL error (the more actionable one), never the restore error.
    if (evicted) {
      try {
        renameSync(trash, dist);
      } catch {
        /* best-effort restore */
      }
    }
    throw error;
  }
  rmSync(trash, { recursive: true, force: true });
}

// Bounded self-healing for a promotion that crashed BETWEEN the two renames (B-1734 D3).
//
// promoteDist's in-process catch restores dist only while the builder is still alive. A SIGKILL/host
// crash AFTER `renameSync(dist, trash)` but BEFORE `renameSync(staging, dist)` bypasses that catch and
// leaves dist ABSENT indefinitely (old dist stranded in an orphaned dist.trash-*, recovered by no one).
// Run this at build/bootstrap startup: if dist is absent and a dist.trash-* sibling exists, restore the
// newest one so dist is never absent longer than until the next build/bootstrap. The residual window
// between the mid-promotion crash and this next run is the same versioned-pointer follow-up as the
// C2(b) microsecond gap (a cross-platform immutable-output + atomic-pointer design), NOT closed here.
//
// SAFETY: gated on build-lock freshness. A LIVE build heartbeats <lockTarget>.lock every 10s (kept live
// because tsc now runs as an async child — D2 — so the event loop is free) and legitimately OWNS its
// dist.staging / dist.trash-<pid> mid-promotion; its own promoteDist already restores dist on failure.
// So when the lock is fresh we do NOTHING — recovering another builder's siblings would corrupt its
// in-progress build. Only when NO live build holds the lock (crashed/never-built) do we recover. Every
// fs call is guarded so recovery can never throw the build it is protecting.
export function recoverOrphanedPromotion(packageRoot, repoKey) {
  if (repoKey !== undefined && buildLockFresh(repoKey)) return; // a LIVE build owns these siblings
  const dist = join(packageRoot, 'dist');
  const staging = join(packageRoot, 'dist.staging');
  let entries;
  try {
    entries = readdirSync(packageRoot, { withFileTypes: true });
  } catch {
    return; // packageRoot unreadable — nothing to recover
  }
  const trashDirs = entries.filter(e => e.name.startsWith('dist.trash-')).map(e => join(packageRoot, e.name));
  const distPresent = safe(() => existsSync(dist)) === true;
  if (!distPresent && trashDirs.length > 0) {
    // Killed between promoteDist's two renames: the old dist was evicted to dist.trash-<pid> but
    // staging→dist never ran. Restore the NEWEST orphaned trash so dist is complete again.
    const newest = trashDirs
      .map(p => ({ p, mtime: safe(() => statSync(p).mtimeMs) ?? 0 }))
      .sort((a, b) => b.mtime - a.mtime)[0].p;
    if (safe(() => (renameSync(newest, dist), true))) {
      const i = trashDirs.indexOf(newest);
      if (i >= 0) trashDirs.splice(i, 1); // consumed — don't delete it below
    }
  }
  // Best-effort tidy leftover crash debris (never a live build's — gated on lock freshness above).
  for (const t of trashDirs) safe(() => rmSync(t, { recursive: true, force: true }));
  safe(() => rmSync(staging, { recursive: true, force: true }));
}

// True iff a build lock exists AND is fresh (heartbeated within the stale threshold) — i.e. a build is
// LIVE. Mirrors bin/bootstrap-runner.js's buildInProgress(); both read the dependency-free single source
// of truth (build-lock-target.mjs) so the mutex, the reader, and this recovery gate can never drift.
function buildLockFresh(repoKey) {
  try {
    const st = statSync(`${buildLockTarget(repoKey)}.lock`);
    return Date.now() - st.mtimeMs < BUILD_LOCK_STALE_MS;
  } catch {
    return false; // no lock dir → no live build
  }
}

// Run an fs operation, swallowing any error, so recovery is strictly best-effort and never throws the
// build it protects. Returns the callback's value on success (or undefined on error).
function safe(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
