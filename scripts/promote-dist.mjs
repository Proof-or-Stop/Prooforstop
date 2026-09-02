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
import { chmodSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  // B-e256: the freshly promoted dist came straight out of tsc, which emits every file 0644;
  // restore the executable bit on package.json `bin` targets (see restoreBinExecutableBits).
  restoreBinExecutableBits(dist);
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

// B-e256 (probe rp-mtk46lj8-90q9av): restore the executable bit on package.json `bin` targets.
// RED symptom: after a rebuild that actually re-emits, `proof-or-stop --version` died with
// "permission denied" because packages/main/dist/cli.js was 0644. tsc emits every file 0644,
// and `npm link` / global install chmods the bin target only ONCE at install time — nothing
// in the build pipeline restored the bit after promoteDist swapped in the fresh dist, so the
// global symlink (/opt/homebrew/bin/proof-or-stop -> .../dist/cli.js) broke on every re-emit.
//
// Reads `<dirname(dist)>/package.json` and ORs 0o111 into the mode of each `bin` value.
// Returns the list of restored bin paths (package-relative). Deliberately non-fatal: a
// missing/unparseable package.json or a package without `bin` returns [] and changes
// nothing (promoteDist behaviour stays byte-identical to before for such packages), and an
// absent bin target (first build, partial fixture) is skipped per target rather than thrown.
// Mode bits are not part of the content-bound build binding, so the chmod does not
// invalidate the fast-path verify. Only node: built-ins (fresh-checkout footprint rule).
export function restoreBinExecutableBits(dist) {
  const packageRoot = dirname(dist);
  let bin;
  try {
    bin = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).bin ?? {};
  } catch {
    return [];
  }
  // npm accepts both `bin: { name: "path" }` and the `bin: "path"` shorthand; only the paths matter.
  const targets = typeof bin === 'string' ? [bin] : typeof bin === 'object' && bin !== null ? Object.values(bin) : [];
  const restored = [];
  for (const rel of targets) {
    if (typeof rel !== 'string') continue;
    const abs = join(packageRoot, rel);
    try {
      chmodSync(abs, statSync(abs).mode | 0o111);
      restored.push(rel);
    } catch {
      /* absent bin target (ENOENT etc.): nothing to restore */
    }
  }
  return restored;
}
