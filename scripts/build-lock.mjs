// Shared build mutex. The packages/main build does `rm -rf dist` + tsc, and the
// packages/utils build's tsc reads packages/main/dist directly (via ../../main/dist/*
// imports). When those overlap across concurrent invocations in one worktree — the root
// `pretest` fires them on every `npm test`, and the review pipeline runs many builds in
// one shared worktree — a main rebuild mid-rmdir/tsc corrupts what a sibling process's
// rm or utils-tsc is touching, surfacing as ENOTEMPTY/EBUSY or TS2307 "Cannot find
// module '../../main/dist/...'". Both builds take this same per-repo lock so they SERIALIZE
// instead of racing (B-fb7b F-011..F-015; the documented shared-worktree concurrency
// hazard). Isolated single-process usage is unaffected. Deterministic per-invocation
// dist purity is preserved: each holder still does a full rm+tsc while it owns the lock.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readOwner(ownerFile) {
  try { return JSON.parse(readFileSync(ownerFile, 'utf8')); } catch { return null; }
}

// A holder is alive iff its PID still exists. process.kill(pid, 0) throws ESRCH for a
// dead process and EPERM for a live process we do not own; only ESRCH ("no such process")
// means the holder is gone and its lock is safe to reclaim.
function holderAlive(owner) {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); return true; }
  catch (err) { return Boolean(err) && err.code === 'EPERM'; }
}

/**
 * Run `fn` while holding an exclusive filesystem lock keyed by `repoKey`. Concurrent
 * callers wait rather than racing. A lock is reclaimed ONLY from a provably-dead holder
 * (its PID no longer exists) — never from a live long-running build — so a build that
 * legitimately exceeds any wall-clock threshold is never overlapped, and the ownership-
 * blind, purely age-based steal that used to recreate the dist corruption this mutex
 * prevents is gone (B-fb7b Codex MAJOR-1). Release is ownership-checked: a holder removes
 * the lock only while its own nonce still owns it, so a holder whose lock was reclaimed
 * after a crash can never delete a successor's lock.
 */
export function withBuildLock(repoKey, fn) {
  const lockDir = join(tmpdir(), `lattice-build-${createHash('sha256').update(repoKey).digest('hex').slice(0, 16)}.lock`);
  const ownerFile = join(lockDir, 'owner.json');
  const myOwner = { pid: process.pid, nonce: randomUUID(), at: Date.now() };
  // Last-resort reclaim for a lock whose owner file was never written (holder crashed in
  // the window between mkdir and the owner write): only when the lock is also clearly old.
  // Both bounds are env-overridable so tests can exercise the wait/reclaim paths quickly.
  const NO_OWNER_STALE_MS = Number(process.env.LATTICE_BUILD_LOCK_NO_OWNER_STALE_MS) || 300_000;
  const WAIT_TIMEOUT_MS = Number(process.env.LATTICE_BUILD_LOCK_WAIT_MS) || 1_800_000;
  const waitStart = Date.now();
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(ownerFile, JSON.stringify(myOwner));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const owner = readOwner(ownerFile);
      let reclaim = false;
      if (owner) {
        reclaim = !holderAlive(owner);
      } else {
        // No readable owner yet — could be a lock mid-creation. Reclaim only if clearly old.
        try { reclaim = Date.now() - statSync(lockDir).mtimeMs > NO_OWNER_STALE_MS; } catch { reclaim = false; }
      }
      if (reclaim) {
        try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* raced with another reclaimer */ }
        continue;
      }
      if (Date.now() - waitStart > WAIT_TIMEOUT_MS) {
        throw new Error(`build-lock: timed out after ${WAIT_TIMEOUT_MS}ms waiting for ${lockDir}`);
      }
      sleepSync(200);
    }
  }
  try { return fn(); }
  finally {
    // Ownership-checked release: never remove a lock we no longer own (it may have been
    // reclaimed as dead and re-acquired by a successor while we ran).
    const owner = readOwner(ownerFile);
    if (owner && owner.nonce === myOwner.nonce) {
      try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* already gone */ }
    }
  }
}

/**
 * True iff `distDir` has build output at least as new as every source input under
 * `sourceInputs` (files or directories, scanned recursively). The idempotent `--ensure`
 * build path uses this so a pretest that finds a current dist skips the rm+rebuild
 * entirely — removing the repeated-rebuild-while-read race in which one `npm test`'s
 * pretest `rm -rf dist` overlaps another invocation's full suite still spawning tasks out
 * of dist (B-fb7b Codex MAJOR-2). A missing marker, an unreadable dist, or any source
 * newer than the marker is treated as stale (fail-closed → rebuild).
 */
export function isDistFresh(distDir, sourceInputs) {
  const marker = join(distDir, 'index.js');
  if (!existsSync(marker)) return false;
  let markerMtime;
  try { markerMtime = statSync(marker).mtimeMs; } catch { return false; }
  let newestSource = 0;
  const visit = (p) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) {
      let entries;
      try { entries = readdirSync(p); } catch { return; }
      for (const e of entries) visit(join(p, e));
    } else if (st.mtimeMs > newestSource) {
      newestSource = st.mtimeMs;
    }
  };
  for (const input of sourceInputs) visit(input);
  return markerMtime >= newestSource;
}
