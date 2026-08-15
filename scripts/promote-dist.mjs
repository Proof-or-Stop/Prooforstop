// Crash-safe atomic dist promotion (B-1734 C2). Shared by build-main-with-binding.mjs
// and build-utils-with-binding.mjs so the crash-safety logic is written once and
// cannot drift between the two call sites.
//
// Promote a freshly built `staging` tree into `dist` by two renames: evict the old
// `dist` to `trash`, then move `staging` into place. If the SECOND rename fails
// AFTER the first succeeded, dist would otherwise be left ABSENT (old dist in trash,
// staging orphaned), bricking the CLI until the next build — so we RESTORE the old
// dist from trash before rethrowing.
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
}
