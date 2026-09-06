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
import { chmodSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

export function promoteDist(dist, staging, trash, options = {}) {
  // B-e256: the freshly built staging tree came straight out of tsc, which emits every file 0644;
  // restore the executable bit on package.json `bin` targets ON STAGING, BEFORE the old dist is
  // evicted. A non-ENOENT stat/chmod failure (EACCES, EROFS, I/O error) throws here and aborts the
  // promotion while the previous, working dist is still in place — it is never evicted for a tree
  // whose bin target cannot be made executable. (An absent target / package without `bin` is a no-op.)
  restoreBinExecutableBits(staging, dist, options);
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

// B-e256 (probe rp-mtk46lj8-90q9av): restore the executable bit on package.json `bin` targets.
// RED symptom: after a rebuild that actually re-emits, `proof-or-stop --version` died with
// "permission denied" because packages/main/dist/cli.js was 0644. tsc emits every file 0644,
// and `npm link` / global install chmods the bin target only ONCE at install time — nothing
// in the build pipeline restored the bit after promoteDist swapped in the fresh dist, so the
// global symlink (/opt/homebrew/bin/proof-or-stop -> .../dist/cli.js) broke on every re-emit.
//
// `tree` is the directory whose files are chmodded; `dist` is the path that tree occupies (or
// will occupy) once promoted, and defaults to `tree` itself. promoteDist passes the STAGING tree
// with its final `dist` path so the bits are restored before the old dist is evicted; tests and
// post-hoc repairs call `restoreBinExecutableBits(dist)` on a promoted tree. package.json is read
// from `dirname(dist)` (the package root), each `bin` value is package-relative, and its location
// under `tree` is `join(tree, relative(dist, join(packageRoot, bin)))`. A bin value that resolves
// OUTSIDE dist is not re-emitted by tsc and is skipped.
//
// ORs 0o111 into the mode of each bin target and returns the list of restored bin paths
// (package-relative). Non-fatal ONLY for the benign shapes: a missing/unparseable package.json or
// a package without `bin` returns [] and changes nothing (promoteDist behaviour stays byte-identical
// to before for such packages), and an ABSENT bin target (ENOENT: first build, partial fixture) is
// skipped per target. Every OTHER stat/chmod failure (EACCES, EROFS, EPERM, I/O error) is
// PROPAGATED: silently ignoring it (Codex cross-host finding on B-e256) let a promotion report
// success with a non-executable global bin, and because mode bits are not part of the
// content-bound build binding, later builds took the fast path and never repaired it.
// Only node: built-ins (fresh-checkout footprint rule).
export function restoreBinExecutableBits(tree, dist = tree, options = {}) {
  const packageRoot = dirname(dist);
  const readPackageManifest = options.readPackageManifest ?? ((path) => readFileSync(path, 'utf8'));
  let manifestText;
  try {
    manifestText = readPackageManifest(join(packageRoot, 'package.json'));
  } catch (error) {
    // A genuinely missing manifest preserves the historical no-op contract.
    // Every other read failure observed an unknown manifest state and must stop
    // promotion before the working dist is evicted.
    if (error && error.code === 'ENOENT') return [];
    error.message = `restoreBinExecutableBits: cannot read ${join(packageRoot, 'package.json')}: ${error.message}`;
    throw error;
  }
  let bin;
  try {
    bin = JSON.parse(manifestText).bin ?? {};
  } catch (error) {
    // Syntactically malformed JSON is an explicitly retained compatibility
    // no-op. Read failures are handled separately above and never reach here.
    if (!(error instanceof SyntaxError)) throw error;
    return [];
  }
  // npm accepts both `bin: { name: "path" }` and the `bin: "path"` shorthand; only the paths matter.
  const targets = typeof bin === 'string' ? [bin] : typeof bin === 'object' && bin !== null ? Object.values(bin) : [];
  const restored = [];
  let realTree;
  for (const rel of targets) {
    if (typeof rel !== 'string') continue;
    const underDist = relative(dist, join(packageRoot, rel));
    if (underDist === '' || underDist === '..' || underDist.startsWith(`..${sep}`) || isAbsolute(underDist)) continue; // not inside the promoted tree
    const target = join(tree, underDist);
    try {
      // lstat rejects a symlink at the final path. realpath containment is a
      // separate, necessary check: an intermediate directory component can be
      // a symlink whose final referent still looks like a regular file.
      const targetStat = lstatSync(target);
      if (!targetStat.isFile()) {
        const error = new Error(`bin target is not a regular file`);
        error.code = 'EINVAL';
        throw error;
      }
      realTree ??= realpathSync(tree);
      const realTarget = realpathSync(target);
      const underRealTree = relative(realTree, realTarget);
      if (underRealTree === '' || underRealTree === '..' || underRealTree.startsWith(`..${sep}`) || isAbsolute(underRealTree)) {
        const error = new Error(`bin target resolves outside the promoted tree`);
        error.code = 'EINVAL';
        throw error;
      }
      chmodSync(target, targetStat.mode | 0o111);
      restored.push(rel);
    } catch (error) {
      if (error && error.code === 'ENOENT') continue; // absent bin target: nothing to restore
      error.message = `restoreBinExecutableBits: cannot restore the executable bit on bin target ${rel} at ${target}: ${error.message}`;
      throw error;
    }
  }
  return restored;
}
