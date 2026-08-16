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
// This module imports ONLY node: built-ins, so it adds no third-party dependency to
// its callers' fresh-checkout footprint.
import { renameSync, rmSync } from 'node:fs';

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
  // KNOWN LIMITATION / FOLLOW-UP (B-1734, deferred to a build-concurrency infra story).
  // This in-process catch restores dist only while THIS builder is still alive. A SIGKILL/host crash
  // AFTER `renameSync(dist, trash)` but BEFORE `renameSync(staging, dist)` bypasses the catch entirely
  // and leaves dist ABSENT until the NEXT build rebuilds it from source (the fast-path verify fails on
  // an absent dist → a full rebuild runs). A previous round tried to self-heal this cross-process by
  // restoring the orphaned dist.trash-* at startup, but that check-then-restore ran WITHOUT holding the
  // build lock and could delete a concurrent live builder's dist.staging (a NEW race), so it was
  // reverted. Fully closing the mid-promotion crash window needs the same immutable-versioned-dir +
  // atomic-current-pointer redesign tracked for the C2(b) microsecond gap; it is NOT implemented here.
}
