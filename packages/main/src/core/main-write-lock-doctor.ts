/**
 * B-f60c CHK-004: doctor stuck-lock check for the unified main write lock.
 *
 * `koala doctor` scans `.koala/locks/main-write.lock/` and reports whether it is
 * currently held, and — critically — whether the held lock is STUCK (mtime
 * older than the lock primitive's own stale-reclaim window) versus a normal
 * ACTIVE holder still inside its critical section.
 *
 * The classification reuses the EXACT stale threshold the lock primitive uses
 * (`MAIN_WRITE_LOCK_STALE_MS`, 120s): a lock younger than that is presumed to
 * belong to a live operation and is NOT reported as stuck, so doctor cannot
 * misreport a normal in-flight DONE / gap_log as a problem. A lock older than
 * that is exactly what the lock primitive would itself force-reclaim on the
 * next acquire, so doctor flags it as stuck leftover state for the operator.
 */

import { existsSync, statSync } from 'fs';
import { resolveMainRepoRoot } from './partial-done-recovery.js';
import {
  MAIN_WRITE_LOCK_STALE_MS,
  formatLockAge,
  mainWriteLockPath,
} from './main-write-lock.js';
import { readMkdirLockHolder, type MkdirLockHolderInfo } from './mkdir-lock.js';

/** Classification of the main write lock's current state. */
export type MainWriteLockState = 'absent' | 'active' | 'stuck';

export interface MainWriteLockScan {
  /** Absolute path of the main write lock dir that was scanned. */
  lockPath: string;
  /** `absent` = not held; `active` = held within the stale window; `stuck` = held past it. */
  state: MainWriteLockState;
  /** Age of the held lock in ms (0 when absent or un-stat-able). */
  ageMs: number;
  /** Human-readable age (`30s` / `8m` / `2h`); empty when absent. */
  ageLabel: string;
  /** Stale threshold (ms) used to classify stuck vs active. */
  staleMs: number;
  /** Holder metadata read from the lock's `holder.json` (null = unknown / absent). */
  holder: MkdirLockHolderInfo | null;
}

/**
 * Scan the main write lock for `root`.
 *
 * `root` may be a story worktree path; the lock always lives at the MAIN repo
 * root, so the main repo root is resolved first (same directory every session
 * contends on).
 *
 * @param staleMs optional stale threshold override (tests only). Production
 *   callers omit it and get `MAIN_WRITE_LOCK_STALE_MS` so doctor's "stuck"
 *   verdict lines up exactly with the lock primitive's own reclaim behavior.
 */
export function scanMainWriteLock(root: string, staleMs?: number): MainWriteLockScan {
  // Runtime re-validation: a non-positive / non-finite threshold would make
  // every held lock classify as stuck (age > 0 always). Mirrors the
  // "Handler coding convention" rule — every consumer re-checks load-bearing invariants
  // instead of trusting the caller. Fall back to the canonical default.
  const threshold =
    typeof staleMs === 'number' && Number.isFinite(staleMs) && staleMs > 0
      ? staleMs
      : MAIN_WRITE_LOCK_STALE_MS;

  const mainRepoRoot = resolveMainRepoRoot(root);
  const lockPath = mainWriteLockPath(mainRepoRoot);

  if (!existsSync(lockPath)) {
    return { lockPath, state: 'absent', ageMs: 0, ageLabel: '', staleMs: threshold, holder: null };
  }

  let ageMs = 0;
  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
    if (ageMs < 0) ageMs = 0;
  } catch {
    // PROBE: lock dir vanished between existsSync and statSync — treat as absent.
    return { lockPath, state: 'absent', ageMs: 0, ageLabel: '', staleMs: threshold, holder: null };
  }

  const holder = readMkdirLockHolder(lockPath);
  // A lock older than the stale window is exactly what the lock primitive would
  // force-reclaim on the next acquire → report it as stuck. A younger lock is a
  // live holder → 'active', NOT misreported.
  const state: MainWriteLockState = ageMs > threshold ? 'stuck' : 'active';
  return { lockPath, state, ageMs, ageLabel: formatLockAge(ageMs), staleMs: threshold, holder };
}

/**
 * Render the main write lock scan as `koala doctor` text-report lines.
 * Returns the lines for the "Main write lock:" section body.
 */
export function renderMainWriteLockScan(scan: MainWriteLockScan): string[] {
  const lines: string[] = [];
  lines.push('Main write lock:');
  if (scan.state === 'absent') {
    lines.push('  ✓ not held — no main write lock present.');
    return lines;
  }

  const holderDesc = scan.holder
    ? `${scan.holder.command} (pid ${scan.holder.pid} on ${scan.holder.hostname})`
    : 'unknown holder (no holder.json — lock from older code or a leftover)';

  if (scan.state === 'active') {
    lines.push(`  ✓ held by ${holderDesc}, heartbeat ${scan.ageLabel} ago.`);
    lines.push(`    within the ${formatLockAge(scan.staleMs)} stale window — treated as an active operation, not stuck.`);
    return lines;
  }

  // state === 'stuck'
  lines.push(`  ⚠ STUCK lock held by ${holderDesc}, heartbeat ${scan.ageLabel} ago.`);
  lines.push(`    older than the ${formatLockAge(scan.staleMs)} stale window — the holder likely crashed.`);
  lines.push(`  → path: ${scan.lockPath}`);
  lines.push('  → the next main write will auto-reclaim it; to clear it now: rm -rf the path above.');
  return lines;
}
