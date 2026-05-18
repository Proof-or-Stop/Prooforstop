import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * B-6812 CHK-001: shared mkdir-based advisory lock primitive.
 *
 * Extracted from checklist.ts `withChecklistLock` so story_create can reuse the
 * exact same atomic-lock mechanism. `mkdir` of a non-existent directory is
 * atomic on POSIX/Win32 filesystems — exactly one caller wins the race; the
 * losers retry until they either acquire it or hit the deadline.
 *
 * Semantics:
 *  - `mkdirSync(lockDir)` is the atomic acquire. EEXIST means another holder.
 *  - While waiting, if the lock dir's mtime is older than `staleMs`, the holder
 *    is presumed dead/crashed → force-reclaim by removing the dir.
 *  - If acquisition does not succeed before `deadlineMs`, throw a clear error.
 *  - `finally` always releases the lock so a throwing `fn` cannot leak it.
 */

/**
 * Holder metadata recorded inside an acquired lock directory.
 *
 * B-f60c CHK-004: the lock dir used to be a bare directory carrying no
 * information about who held it, so a contention error could only state "held
 * by another operation". Writing a `holder.json` inside the dir on acquire lets
 * a blocked caller surface the live holder's pid / hostname / running command /
 * heartbeat age — the operator-facing "main lock contention" UX the
 * session-ownership doc's Error UX section requires.
 *
 * NOTE: this is process metadata, NOT a session identity. The doc's Error UX
 * example shows a `session abc123` token, but `sessionId` is an owner-lease
 * concept implemented by a SEPARATE story; this lock only records what it can
 * mechanically observe (pid / hostname / command / acquire time). No sessionId
 * is fabricated.
 */
export interface MkdirLockHolderInfo {
  /** PID of the process that acquired the lock. */
  pid: number;
  /** Hostname of the machine that acquired the lock. */
  hostname: string;
  /** Human-readable command / operation label (e.g. `story_advance DONE for B-6974`). */
  command: string;
  /** ISO timestamp of the moment the lock was acquired. */
  acquiredAt: string;
}

/** Filename of the holder-metadata file written inside an acquired lock dir. */
export const MKDIR_LOCK_HOLDER_FILE = 'holder.json';

export interface MkdirLockOptions {
  /**
   * Total time budget (ms) to acquire the lock before throwing. Default 30000.
   *
   * MUST be larger than `staleMs`: a waiter that gives up before a held lock
   * crosses the stale threshold can never reach the stale-reclaim branch, so a
   * crashed holder's lock would deadlock every subsequent caller. With
   * deadline (30s) > stale (10s) a waiter is still polling when the lock turns
   * stale and reclaims it.
   */
  deadlineMs?: number;
  /** Age (ms) past which a held lock is treated as stale and reclaimed. Default 10000. */
  staleMs?: number;
  /** Poll interval (ms) between acquisition attempts. Default 50. */
  pollMs?: number;
  /** Human-readable label used in the timeout error message. Default 'mkdir'. */
  label?: string;
  /**
   * When true, a non-stale existing lock fails immediately instead of polling.
   * Stale locks are still reclaimed first. This is useful for high-level
   * lifecycle locks where waiting would hide contention from the operator.
   */
  failFastIfHeld?: boolean;
  /** Optional user-facing message used when failFastIfHeld sees a live lock. */
  heldMessage?: string;
  /**
   * Holder metadata to record inside the lock dir on a successful acquire.
   *
   * When provided, `holder.json` is written into the lock dir so a later
   * blocked caller can read who holds it. Omitting it keeps the lock a bare
   * directory (back-compatible — `readMkdirLockHolder` just returns null).
   */
  holderInfo?: MkdirLockHolderInfo;
  /**
   * Optional hook invoked when `failFastIfHeld` sees a LIVE lock, BEFORE the
   * held error is thrown. Receives the holder metadata read from the live
   * lock's `holder.json` (null if absent / unreadable) and the live lock's age
   * in ms (mtime-derived; falls back to 0 if the dir cannot be stat-ed). Lets a
   * high-level caller build a richer, holder-aware contention message than the
   * static `heldMessage`.
   */
  onContentionHeld?: (holder: MkdirLockHolderInfo | null, holderAgeMs: number) => string;
}

/**
 * Read the holder metadata of an acquired lock dir.
 *
 * Returns null when the lock dir has no `holder.json` (e.g. a lock acquired by
 * older code, or a stale leftover) or when the file is missing / malformed.
 * Callers must treat a null result as "holder unknown" and degrade gracefully —
 * the lock itself is still valid; only the descriptive metadata is absent.
 */
export function readMkdirLockHolder(lockDir: string): MkdirLockHolderInfo | null {
  try {
    const raw = readFileSync(join(lockDir, MKDIR_LOCK_HOLDER_FILE), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    // Runtime re-validation: every field must be present with the right shape.
    // A partially-written holder.json (writer crashed mid-write) degrades to
    // "holder unknown" rather than producing a half-populated message.
    const pid = typeof obj.pid === 'number' ? obj.pid : NaN;
    const hostname = typeof obj.hostname === 'string' ? obj.hostname : '';
    const command = typeof obj.command === 'string' ? obj.command : '';
    const acquiredAt = typeof obj.acquiredAt === 'string' ? obj.acquiredAt : '';
    if (!Number.isFinite(pid) || !hostname || !command || !acquiredAt) return null;
    return { pid, hostname, command, acquiredAt };
  } catch {
    /* PROBE: no holder.json / unreadable / malformed — holder is unknown. */
    return null;
  }
}

/**
 * Default acquire deadline. Kept strictly above DEFAULT_STALE_MS so the
 * stale-reclaim path is reachable for every caller using defaults: a waiter
 * polls past the 10s stale threshold and reclaims a crashed holder's lock
 * before its own 30s deadline expires. story_create / checklist_update both
 * complete in well under 1s, so no legitimate holder ever lives long enough to
 * be reclaimed.
 */
const DEFAULT_DEADLINE_MS = 30000;
const DEFAULT_STALE_MS = 10000;
const DEFAULT_POLL_MS = 50;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface AcquiredMkdirLock {
  lockDir: string;
  release(): void;
}

/**
 * Acquire `lockDir` via atomic mkdir.
 *
 * The parent directory of `lockDir` is created (recursive) if missing — callers
 * resolving a lock path inside a not-yet-created story dir do not need to
 * pre-create it themselves.
 */
export function acquireMkdirLock(lockDir: string, options: MkdirLockOptions = {}): AcquiredMkdirLock {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const label = options.label ?? 'mkdir';

  // Ensure the lock's parent exists so mkdir(lockDir) fails only on EEXIST,
  // never on ENOENT. mkdir(recursive) on an existing dir is a no-op.
  mkdirSync(dirname(lockDir), { recursive: true });

  const deadline = Date.now() + deadlineMs;
  while (true) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (e: any) {
      // Lock dir already exists (EEXIST) — another holder, or a stale leftover.
      let sawLiveLock = false;
      let liveLockAgeMs = 0;
      try {
        const ageMs = Date.now() - statSync(lockDir).mtimeMs;
        if (ageMs > staleMs) rmSync(lockDir, { recursive: true, force: true });
        else {
          sawLiveLock = true;
          liveLockAgeMs = ageMs;
        }
      } catch {
        /* PROBE: lock dir vanished between mkdir attempt and stat — next loop retries */
      }
      if (sawLiveLock && options.failFastIfHeld) {
        // Read the LIVE holder's metadata so the contention error can name the
        // pid / hostname / running command / heartbeat age. A holder-aware
        // message via `onContentionHeld` takes precedence; otherwise the
        // static `heldMessage` (or a generic default) is used.
        const holder = readMkdirLockHolder(lockDir);
        const message = options.onContentionHeld
          ? options.onContentionHeld(holder, liveLockAgeMs)
          : options.heldMessage ?? `${label} lock is held; retry after the active operation finishes`;
        throw new Error(message);
      }
      if (Date.now() > deadline) {
        throw new Error(`${label} lock timeout after ${deadlineMs}ms (${e?.message || e})`);
      }
      sleepSync(pollMs);
    }
  }

  // Record holder metadata inside the freshly-acquired lock dir so a later
  // blocked caller can describe who holds it. Best-effort: a write failure
  // (read-only fs, etc.) must not fail the acquire — the lock is already held.
  if (options.holderInfo) {
    try {
      writeFileSync(
        join(lockDir, MKDIR_LOCK_HOLDER_FILE),
        JSON.stringify(options.holderInfo, null, 2) + '\n',
        'utf-8',
      );
    } catch {
      /* PROBE: holder.json is descriptive metadata only — acquire still succeeded. */
    }
  }

  return {
    lockDir,
    release() {
      rmSync(lockDir, { recursive: true, force: true });
    },
  };
}

/**
 * Acquire `lockDir` via atomic mkdir, run `fn`, then release the lock.
 */
export function withMkdirLock<T>(lockDir: string, fn: () => T, options: MkdirLockOptions = {}): T {
  const lock = acquireMkdirLock(lockDir, options);
  try {
    return fn();
  } finally {
    lock.release();
  }
}
