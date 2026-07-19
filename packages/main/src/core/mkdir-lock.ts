import { mkdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { hostname } from 'os';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';

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
  /** Optional per-acquire identity token for higher-level liveness checks. */
  lockId?: string;
  /** Optional process start timestamp when the holder can provide it. */
  processStartTimeMs?: number;
}

/** Filename of the holder-metadata file written inside an acquired lock dir. */
export const MKDIR_LOCK_HOLDER_FILE = 'holder.json';

export type ExistingMkdirLockState = 'active' | 'stale' | 'unknown';

export interface ExistingMkdirLockSnapshot {
  lockDir: string;
  holder: MkdirLockHolderInfo | null;
  ageMs: number;
  staleMs: number;
  nowMs: number;
}

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
  /**
   * Optional liveness classifier used by higher-level locks that have richer
   * holder metadata than mtime alone. Return `unknown` to fall back to the
   * default mtime stale check.
   */
  classifyExistingLock?: (snapshot: ExistingMkdirLockSnapshot) => ExistingMkdirLockState;
  /**
   * B-d877 R2 FIX D: require a persisted ownership token. When true, a failure to
   * write `holder.json` at acquire FAILS the acquire (the just-created lock dir is
   * removed and an error is thrown) instead of proceeding in the token-less
   * back-compat mode. Callers whose `release()` MUST be ownership-checked (the
   * per-story transition lock) set this so the lock is never in a state where a
   * late release could unconditionally delete a successor's dir.
   */
  requireHolderToken?: boolean;
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
    const lockId = typeof obj.lockId === 'string' && obj.lockId.trim() ? obj.lockId : undefined;
    const processStartTimeMs = typeof obj.processStartTimeMs === 'number' && Number.isFinite(obj.processStartTimeMs)
      ? obj.processStartTimeMs
      : undefined;
    return {
      pid,
      hostname,
      command,
      acquiredAt,
      ...(lockId ? { lockId } : {}),
      ...(processStartTimeMs !== undefined ? { processStartTimeMs } : {}),
    };
  } catch {
    /* PROBE: no holder.json / unreadable / malformed — holder is unknown. */
    return null;
  }
}

/**
 * B-d877 R4 (codex #2): remove an OWNED, now-empty lock dir NON-recursively.
 *
 * This NEVER recursively force-removes: it uses the non-recursive empty-dir
 * removal (`rmdirSync`), which fails harmlessly (ENOTEMPTY / ENOENT) if the dir
 * is NOT empty (e.g. a successor's `holder.json` is present after a stale-reclaim
 * race) or already gone. A missed removal simply leaves a lock that self-reclaims
 * at `staleMs` — far safer than a recursive force-remove that could delete a
 * successor's LIVE lock dir. Callers must have already removed their own
 * `holder.json` (or confirmed the dir is empty) before calling this.
 */
function removeEmptyLockDirNonRecursive(lockDir: string): void {
  try {
    rmdirSync(lockDir);
  } catch {
    /* PROBE: dir not empty (successor present) or already gone — both harmless.
       We deliberately do NOT escalate to a recursive force-remove here. */
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
      let liveHolder: MkdirLockHolderInfo | null = null;
      try {
        const nowMs = Date.now();
        const ageMs = nowMs - statSync(lockDir).mtimeMs;
        const holder = options.classifyExistingLock || options.failFastIfHeld
          ? readMkdirLockHolder(lockDir)
          : null;
        const classification = options.classifyExistingLock
          ? options.classifyExistingLock({ lockDir, holder, ageMs, staleMs, nowMs })
          : 'unknown';
        if (classification === 'stale' || (classification === 'unknown' && ageMs > staleMs)) {
          rmSync(lockDir, { recursive: true, force: true });
        } else {
          sawLiveLock = true;
          liveLockAgeMs = ageMs;
          liveHolder = holder;
        }
      } catch {
        /* PROBE: lock dir vanished between mkdir attempt and stat — next loop retries */
      }
      if (sawLiveLock && options.failFastIfHeld) {
        // Read the LIVE holder's metadata so the contention error can name the
        // pid / hostname / running command / heartbeat age. A holder-aware
        // message via `onContentionHeld` takes precedence; otherwise the
        // static `heldMessage` (or a generic default) is used.
        const message = options.onContentionHeld
          ? options.onContentionHeld(liveHolder, liveLockAgeMs)
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
  // blocked caller can describe who holds it.
  //
  // B-d877 R2 FIX D: ALWAYS mint a unique per-acquire `lockId` (randomUUID) and
  // persist it in holder.json, then capture it in the release() closure below.
  // This makes release OWNERSHIP-CHECKED for EVERY caller — not just holderInfo
  // callers: if this holder is stale-reclaimed (dir removed by a waiter) and a NEW
  // holder acquires, our later release() must NOT delete the successor's dir.
  //
  // Token provenance:
  //  - holderInfo provided → merge our minted lockId into it.
  //  - no holderInfo → write a MINIMAL but fully-valid holder.json (pid / hostname
  //    / command / acquiredAt / lockId). It MUST carry the four descriptive fields
  //    so readMkdirLockHolder can re-validate and return the token on release; a
  //    token-only file would parse back as null → release would never match → leak.
  //
  // `releaseLockId` is only set AFTER a successful holder.json write. On write
  // failure:
  //  - default (fail-open) → leave it undefined and fall back to the back-compat
  //    UNCONDITIONAL removal so the lock dir can never leak (ownership unprovable).
  //  - requireHolderToken=true (fail-closed) → a token-less state is unacceptable,
  //    so remove the just-created dir and FAIL the acquire.
  const ourLockId = options.holderInfo?.lockId ?? randomUUID();
  const holderToWrite: MkdirLockHolderInfo = options.holderInfo
    ? { ...options.holderInfo, lockId: ourLockId }
    : {
        pid: process.pid,
        hostname: hostname(),
        command: label,
        acquiredAt: new Date().toISOString(),
        lockId: ourLockId,
      };
  let releaseLockId: string | undefined;
  try {
    writeFileSync(
      join(lockDir, MKDIR_LOCK_HOLDER_FILE),
      JSON.stringify(holderToWrite, null, 2) + '\n',
      'utf-8',
    );
    releaseLockId = ourLockId;
  } catch (writeErr: any) {
    if (options.requireHolderToken) {
      // Fail-closed: cannot prove ownership on release, so do not proceed
      // token-less. The dir we JUST created is empty (the holder.json write
      // failed) and no successor can exist yet (mkdir just won the race, age≈0 so
      // no waiter could stale-reclaim), so clean it up with the NON-recursive
      // empty-dir removal — B-d877 R4 (codex #2): never recursive-force-remove an
      // identity-unverified dir. Then fail the acquire.
      removeEmptyLockDirNonRecursive(lockDir);
      throw new Error(
        `${label} lock: failed to persist required ownership token (holder.json): ${writeErr?.message ?? writeErr}`,
      );
    }
    /* PROBE: holder.json is descriptive metadata only — acquire still succeeded;
       release falls back to unconditional removal (back-compat). */
  }

  return {
    lockDir,
    release() {
      // B-d877 R4 (codex #2): release is OWNERSHIP-SAFE and NON-recursive. It
      // NEVER recursively force-removes an identity-unverified directory, so a
      // holder that was suspended (holder.json write failed / OS freeze),
      // stale-reclaimed, and then resumed can never wipe a SUCCESSOR's LIVE lock
      // dir. It removes only what it can prove it owns, and the directory removal
      // is the non-recursive empty-dir remove that fails harmlessly if a
      // successor's holder.json is present (dir not empty).
      if (releaseLockId === undefined) {
        // BACK-COMPAT / fail-open: the holder.json write failed AND the caller did
        // NOT require a token, so we have NO token to prove ownership. Do NOT
        // recursive-force-remove (that could delete a successor's dir). Since
        // FIX D always writes a holder.json on a successful acquire, a holder.json
        // present now belongs to a SUCCESSOR → no-op. Only when NO holder.json is
        // present (our failed write left the dir empty/orphaned) do we remove it,
        // non-recursively. A missed removal merely leaks a lock that self-reclaims
        // at staleMs — far safer than deleting a live successor.
        if (readMkdirLockHolder(lockDir) === null) {
          removeEmptyLockDirNonRecursive(lockDir);
        }
        return;
      }
      // Ownership-checked release: only remove the dir if WE still hold it.
      // A stale-reclaim + new-holder acquire replaces holder.json with a
      // different lockId (or removes it entirely); in either case this release
      // is a no-op so a successor's lock is never deleted.
      const current = readMkdirLockHolder(lockDir);
      if (current?.lockId === releaseLockId) {
        // Unlink OUR holder.json, then remove the now-empty dir NON-recursively.
        // If a successor somehow re-populated the dir between the re-read and here,
        // the non-recursive dir remove fails harmlessly (dir not empty).
        rmSync(join(lockDir, MKDIR_LOCK_HOLDER_FILE), { force: true });
        removeEmptyLockDirNonRecursive(lockDir);
      }
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
