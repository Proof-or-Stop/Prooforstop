import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { hostname } from 'node:os';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  rmdirSync,
} from 'fs';
import { dirname, join } from 'path';
import { readBrandEnv } from './brand-env.js';

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
 *  - While waiting, a same-host holder PID is probed. A live owner is never
 *    reclaimed merely because its critical section exceeds `staleMs`.
 *    Unknown/tokenless/remote holders retain the bounded mtime fallback.
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
  /** Coordination class; command is display text only. */
  lockClass?: 'validation' | 'metadata-write';
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
  /**
   * B-d877 R5 FIX 2 (F-016): filenames INSIDE the lock dir that the HOLDER ITSELF
   * writes (e.g. the validation lock's `heartbeat.json`) and that a verified-owner
   * release MUST also remove before the non-recursive dir removal. Without this the
   * release removes only `holder.json`, `rmdirSync` fails (dir not empty), and the
   * leaked dir blocks the next acquire with a false "already running". These are
   * removed ENOENT-tolerantly ONLY after release proves ownership (FIX 1); an
   * UNDECLARED leftover still leaves the dir-removal a no-op (ENOTEMPTY) so a
   * successor's fresh dir is never force-removed.
   */
  ownedAuxFiles?: string[];
  /** Refresh holder.json mtime from a token-bound helper while synchronous work may exceed staleMs. */
  heartbeatMs?: number;
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
  return readHolderFile(join(lockDir, MKDIR_LOCK_HOLDER_FILE));
}

/**
 * B-d877 R5 FIX 1: parse a holder-metadata file at an ARBITRARY path (not just
 * `<lockDir>/holder.json`). Release() uses this to validate the token of a
 * holder.json it has atomically `renameSync`-ed OUT of the lock dir into a
 * unique sibling `*.release-candidate`, so token-validation-and-removal operate
 * on an entry a concurrent stale-reclaim + successor-acquire can no longer swap.
 */
function readHolderFile(filePath: string): MkdirLockHolderInfo | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
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
      ...((obj.lockClass === 'validation' || obj.lockClass === 'metadata-write') ? { lockClass: obj.lockClass } : {}),
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

export function observedProcessStartTimeMs(pid: number): number | undefined {
  try {
    const value = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1_000,
    }).trim();
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function classifyDefaultHolder(holder: MkdirLockHolderInfo | null): ExistingMkdirLockState {
  if (!holder || holder.hostname !== hostname()) return 'unknown';
  try {
    process.kill(holder.pid, 0);
    if (holder.processStartTimeMs !== undefined) {
      const observedStart = observedProcessStartTimeMs(holder.pid);
      // ps reports whole seconds on supported hosts; tolerate its rounding but
      // reject a reused PID whose process incarnation differs from the token.
      if (observedStart !== undefined) {
        return Math.abs(observedStart - holder.processStartTimeMs) > 2_000 ? 'stale' : 'active';
      }
    }
    // A live PID without a verifiable process-start identity may be a reused
    // PID. Defer to the bounded holder-mtime/heartbeat lease, never lock forever.
    return 'unknown';
  } catch (error: any) {
    return error?.code === 'ESRCH' ? 'stale' : 'active';
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface AcquiredMkdirLock {
  lockDir: string;
  /** Persisted per-acquire token; absent only in the legacy fail-open write-error path. */
  lockId?: string;
  /** True only while holder.json still names this exact acquire token. */
  isCurrent?(): boolean;
  release(): void;
}

export interface MkdirLockFence {
  writerFenceToken: string;
  assertCurrent(): void;
  /** Serialize final assertion+publication against successor token issuance. */
  publishAtomically<T>(publish: () => T): T;
}

function fenceAuthorityLockDir(lockDir: string): string {
  return `${lockDir}.fence-authority`;
}

function acquireFenceAuthority(lockDir: string, deadlineMs = 120_000): AcquiredMkdirLock {
  const localHostname = hostname();
  return acquireMkdirTicketLock(fenceAuthorityLockDir(lockDir), {
    label: 'mkdir fence authority',
    deadlineMs,
    staleMs: 10_000,
    pollMs: 5,
    holderInfo: {
      pid: process.pid,
      hostname: localHostname,
      command: 'mkdir fence authority',
      acquiredAt: new Date().toISOString(),
    },
    classifyExistingLock: ({ holder }) => {
      // Story 3's adapter is same-host local FS. A foreign/unknown host can
      // never be safely reclaimed by an mtime guess, so it remains active.
      if (!holder || holder.hostname !== localHostname) return 'active';
      try {
        process.kill(holder.pid, 0);
        return 'active';
      } catch (error: any) {
        return error?.code === 'ESRCH' ? 'stale' : 'active';
      }
    },
  });
}

/**
 * Capture the token of an already-held mkdir lock and return a stale-writer
 * fence. A caller that cannot prove a persisted token is refused instead of
 * being allowed to publish after a stale-reclaim/successor-acquire race.
 */
export function captureMkdirLockFence(lockDir: string): MkdirLockFence {
  const token = readMkdirLockHolder(lockDir)?.lockId;
  if (!token) {
    throw new Error(`mkdir lock fence unavailable: ${lockDir} has no persisted ownership token`);
  }
  return {
    writerFenceToken: token,
    assertCurrent() {
      const current = readMkdirLockHolder(lockDir)?.lockId;
      if (current !== token) {
        const error = new Error('STALE_FENCE: mkdir lock ownership changed before commit');
        error.name = 'StaleFenceError';
        throw error;
      }
    },
    publishAtomically<T>(publish: () => T): T {
      const authority = acquireFenceAuthority(lockDir);
      try {
        const current = readMkdirLockHolder(lockDir)?.lockId;
        if (current !== token) {
          const error = new Error('STALE_FENCE: mkdir lock ownership changed before commit');
          error.name = 'StaleFenceError';
          throw error;
        }
        return publish();
      } finally {
        authority.release();
      }
    },
  };
}

export interface MkdirTicketLockOptions extends MkdirLockOptions {
  /**
   * Test/diagnostic barrier invoked after a stale unique ticket has been
   * classified but before that exact ticket path is removed.
   */
  onBeforeStaleTicketRemove?: (ticketPath: string) => void;
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
  // B-d877 R5 FIX 2 (F-016): snapshot the caller-declared holder-owned aux files so
  // the ownership-verified release removes them before the non-recursive dir remove.
  const ownedAuxFiles = Array.isArray(options.ownedAuxFiles) ? [...options.ownedAuxFiles] : [];

  // Ensure the lock's parent exists so mkdir(lockDir) fails only on EEXIST,
  // never on ENOENT. mkdir(recursive) on an existing dir is a no-op.
  mkdirSync(dirname(lockDir), { recursive: true });

  const deadline = Date.now() + deadlineMs;
  let issuanceAuthority: AcquiredMkdirLock | undefined;
  while (true) {
    const authority = acquireFenceAuthority(lockDir, Math.max(deadlineMs, 30_000));
    let acquired = false;
    try {
      try {
        mkdirSync(lockDir);
        acquired = true;
        issuanceAuthority = authority;
        break;
      } catch (e: any) {
      // Lock dir already exists (EEXIST) — another holder, or a stale leftover.
      let sawLiveLock = false;
      let liveLockAgeMs = 0;
      let liveHolder: MkdirLockHolderInfo | null = null;
      try {
        const nowMs = Date.now();
        let leaseMtimeMs = statSync(lockDir).mtimeMs;
        try { leaseMtimeMs = Math.max(leaseMtimeMs, statSync(join(lockDir, MKDIR_LOCK_HOLDER_FILE)).mtimeMs); } catch { /* nascent/tokenless lock */ }
        const ageMs = nowMs - leaseMtimeMs;
        const holder = readMkdirLockHolder(lockDir);
        const classification = options.classifyExistingLock
          ? options.classifyExistingLock({ lockDir, holder, ageMs, staleMs, nowMs })
          : classifyDefaultHolder(holder);
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
      }
    } finally {
      if (!acquired) authority.release();
    }
    if (!acquired) {
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
    ? {
        ...options.holderInfo,
        lockId: ourLockId,
        processStartTimeMs: options.holderInfo.processStartTimeMs
          ?? observedProcessStartTimeMs(options.holderInfo.pid)
          ?? (options.holderInfo.pid === process.pid ? Date.now() - process.uptime() * 1_000 : undefined),
      }
    : {
        pid: process.pid,
        hostname: hostname(),
        command: label,
        acquiredAt: new Date().toISOString(),
        lockId: ourLockId,
        processStartTimeMs: observedProcessStartTimeMs(process.pid) ?? Date.now() - process.uptime() * 1_000,
      };
  let releaseLockId: string | undefined;
  let heartbeatProcess: ChildProcess | undefined;
  try {
    writeFileSync(
      join(lockDir, MKDIR_LOCK_HOLDER_FILE),
      JSON.stringify(holderToWrite, null, 2) + '\n',
      'utf-8',
    );
    releaseLockId = ourLockId;
    const heartbeatMs = options.heartbeatMs;
    if (heartbeatMs !== undefined && Number.isFinite(heartbeatMs) && heartbeatMs > 0) {
      const heartbeatScript = [
        "const fs=require('fs');",
        'const [path,lockId,parentPidText,intervalText]=process.argv.slice(1);',
        'const parentPid=Number(parentPidText), interval=Number(intervalText);',
        'const beat=()=>{try{process.kill(parentPid,0);const row=JSON.parse(fs.readFileSync(path,\'utf8\'));if(row.lockId!==lockId)process.exit(0);const now=new Date();fs.utimesSync(path,now,now);}catch{process.exit(0)}};',
        'beat();setInterval(beat,interval);',
      ].join('');
      heartbeatProcess = spawn(process.execPath, ['-e', heartbeatScript, join(lockDir, MKDIR_LOCK_HOLDER_FILE), ourLockId, String(process.pid), String(heartbeatMs)], {
        stdio: 'ignore',
      });
      heartbeatProcess.on('error', () => { /* bounded mtime fallback remains authoritative */ });
      heartbeatProcess.unref();
    }
  } catch (writeErr: any) {
    if (options.requireHolderToken) {
      // Fail-closed: cannot prove ownership on release, so do not proceed
      // token-less. The dir we JUST created is empty (the holder.json write
      // failed) and no successor can exist yet (mkdir just won the race, age≈0 so
      // no waiter could stale-reclaim), so clean it up with the NON-recursive
      // empty-dir removal — B-d877 R4 (codex #2): never recursive-force-remove an
      // identity-unverified dir. Then fail the acquire.
      removeEmptyLockDirNonRecursive(lockDir);
      issuanceAuthority?.release();
      issuanceAuthority = undefined;
      throw new Error(
        `${label} lock: failed to persist required ownership token (holder.json): ${writeErr?.message ?? writeErr}`,
      );
    }
    /* PROBE: holder.json is descriptive metadata only — acquire still succeeded;
       release falls back to unconditional removal (back-compat). */
  }
  issuanceAuthority?.release();
  issuanceAuthority = undefined;

  return {
    lockDir,
    ...(releaseLockId ? { lockId: releaseLockId } : {}),
    isCurrent() {
      return releaseLockId !== undefined && readMkdirLockHolder(lockDir)?.lockId === releaseLockId;
    },
    release() {
      if (heartbeatProcess && heartbeatProcess.exitCode === null) {
        try { heartbeatProcess.kill(); } catch { /* already exited */ }
      }
      // B-d877 R4 (codex #2): release is OWNERSHIP-SAFE and NON-recursive. It
      // NEVER recursively force-removes an identity-unverified directory, so a
      // holder that was suspended (holder.json write failed / OS freeze),
      // stale-reclaimed, and then resumed can never wipe a SUCCESSOR's LIVE lock
      // dir. It removes only what it can prove it owns, and the directory removal
      // is the non-recursive empty-dir remove that fails harmlessly if a
      // successor's holder.json is present (dir not empty).
      if (releaseLockId === undefined) {
        // BACK-COMPAT / fail-open: the holder.json write failed AND the caller did
        // NOT require a token, so we have NO token to prove ownership.
        //
        // B-d877 R5 FIX 4 (F-015): a NULL holder is AMBIGUOUS — it is EITHER our
        // own failed-write orphan OR a SUCCESSOR MID-ACQUIRE (mkdir won the dir but
        // has not yet written holder.json). Removing on null would delete that
        // nascent successor's dir. So on a null holder we NO-OP and let the
        // stale-reclaim path collect a true orphan within staleMs.
        //
        // B-d877 R6 (codex R6 LOW): the legacy PRE-universal-token case — a
        // holder.json that EXISTS but carries no lockId (a dir acquired by pre-FIX-D
        // code that could not mint a token) — is ALSO a DELIBERATE SAFETY NO-OP.
        // Safe immediate removal is impossible without ownership identity: we cannot
        // prove we own that dir, so removing the file-then-dir could destroy a dir a
        // successor legitimately owns. (The prior code attempted a non-recursive
        // rmdir here, but that was DEAD-ON-ARRIVAL: the legacy holder.json is still
        // present, so rmdirSync always hit ENOTEMPTY and swallowed it — the dir never
        // came out anyway.) So we simply NO-OP and let the stale-reclaim path collect
        // it within staleMs, exactly like the null-holder case above.
        return;
      }
      // B-d877 R5 FIX 1 (codex R5 HIGH — release TOCTOU): ownership-checked release
      // via ATOMIC token ISOLATION. The prior read-then-remove had a window between
      // validating our token and removing the dir in which a stale-reclaim +
      // successor-acquire could swap the dir, so this old holder deleted the
      // successor's LIVE claim. Instead, atomically `renameSync` holder.json OUT of
      // the lock dir into a UNIQUE sibling candidate (rename is atomic on POSIX), so
      // token-validation and removal operate on an entry nothing can swap underneath
      // us.
      const candidatePath = join(
        dirname(lockDir),
        `${releaseLockId}.${process.pid}.release-candidate`,
      );
      try {
        renameSync(join(lockDir, MKDIR_LOCK_HOLDER_FILE), candidatePath);
      } catch {
        // ENOENT: no holder.json to isolate — the dir was reclaimed, or a successor
        // is mid-acquire (mkdir won but holder.json not yet written). Nothing we own
        // to remove → no-op.
        return;
      }
      const isolated = readHolderFile(candidatePath);
      if (isolated?.lockId === releaseLockId) {
        // MATCH — we own this release. holder.json is already OUT of the dir, so a
        // successor cannot mkdir the still-present dir; finish cleanup safely.
        // B-d877 R5 FIX 2 (F-016): remove HOLDER-owned aux files (e.g. the validation
        // lock's heartbeat.json) declared by the caller, ENOENT-tolerantly, so the
        // subsequent non-recursive dir remove is not blocked by our own aux files.
        for (const aux of ownedAuxFiles) {
          try {
            rmSync(join(lockDir, aux), { force: true });
          } catch {
            /* PROBE: ENOENT-tolerant — an aux file may already be gone. */
          }
        }
        // Non-recursive: tolerates ENOTEMPTY (an UNDECLARED file or a successor's
        // fresh dir → leave it for the stale-reclaim path; never recursive-force) and
        // ENOENT.
        removeEmptyLockDirNonRecursive(lockDir);
        rmSync(candidatePath, { force: true });
      } else {
        // MISMATCH — the isolated holder.json belongs to a SUCCESSOR (we were
        // stale-reclaimed and it re-acquired). We do NOT own it: atomically rename
        // the candidate BACK into the dir to RESTORE the successor's token, then
        // no-op. If the restore throws (the successor already wrote a fresh
        // holder.json), drop the stray candidate — never delete the successor's dir.
        //
        // B-d877 R6 (F-017, quality MED — DELIBERATE safe-side tradeoff): restoring
        // the successor's token is intentional even though, in a DOUBLY-degenerate
        // race, it can leak the lock dir. F-017 REQUIRES BOTH the already-documented
        // stale-reclaim-of-a-LIVE-holder precondition (the cross-host mtime-fallback
        // KNOWN LIMITATION) AND the successor's OWN release() interleaving in the
        // token-less window: if B.release() runs after we isolate the token (its
        // rename hits ENOENT → no-op, so B will not clean up again) but before this
        // restore, we re-populate the dir with B's now-ORPHANED token → a bounded
        // false "already running" until staleMs. We choose this over the alternative
        // — DROPPING the candidate on mismatch — because dropping would DESTROY a
        // possibly-LIVE successor's token (the exact release TOCTOU codex R5 flagged),
        // a real correctness bug. Restoring risks only a BOUNDED, SELF-HEALING leak:
        // the orphaned dir's mtime ages past staleMs and the ordinary stale-reclaim
        // path collects it; the atomic persist claim (mkdir + holder.json) stays the
        // double-mint fence, so there is NO correctness loss. CHK-002d4 in
        // transition-integrity-smoke.ts scripts this interleaving and proves the
        // orphan is stale-reclaimable.
        try {
          renameSync(candidatePath, join(lockDir, MKDIR_LOCK_HOLDER_FILE));
        } catch {
          rmSync(candidatePath, { force: true });
        }
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

interface TicketCandidate {
  path: string;
  name: string;
  holder: MkdirLockHolderInfo | null;
  ageMs: number;
}

function ticketCandidates(lockDir: string, suffix: '.choosing' | '.ticket', staleMs: number): TicketCandidate[] {
  let names: string[];
  try {
    names = readdirSync(lockDir).filter(name => name.endsWith(suffix));
  } catch {
    return [];
  }
  return names.flatMap((name): TicketCandidate[] => {
    const path = join(lockDir, name);
    try {
      const ageMs = Date.now() - statSync(path).mtimeMs;
      let holder: MkdirLockHolderInfo | null = null;
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as MkdirLockHolderInfo;
        if (
          Number.isFinite(parsed.pid)
          && typeof parsed.hostname === 'string'
          && typeof parsed.command === 'string'
          && typeof parsed.acquiredAt === 'string'
        ) holder = parsed;
      } catch {
        // A malformed fresh ticket is treated as unknown/live until staleMs.
      }
      return [{ path, name, holder, ageMs }];
    } catch {
      return [];
    }
  });
}

function removeStaleUniqueTickets(
  lockDir: string,
  suffix: '.choosing' | '.ticket',
  options: MkdirTicketLockOptions,
  staleMs: number,
): TicketCandidate[] {
  const nowMs = Date.now();
  const active: TicketCandidate[] = [];
  for (const candidate of ticketCandidates(lockDir, suffix, staleMs)) {
    const classification = options.classifyExistingLock
      ? options.classifyExistingLock({
        lockDir: candidate.path,
        holder: candidate.holder,
        ageMs: candidate.ageMs,
        staleMs,
        nowMs,
      })
      : 'unknown';
    const stale = classification === 'stale'
      || (classification === 'unknown' && candidate.ageMs > staleMs);
    if (!stale) {
      active.push(candidate);
      continue;
    }
    options.onBeforeStaleTicketRemove?.(candidate.path);
    // Identity-conditional reclaim: every acquisition owns a never-reused
    // UUID path. Removing stale A can therefore never remove replacement B.
    rmSync(candidate.path, { force: true });
  }
  return active;
}

/**
 * Bakery-style process lock with unique acquisition paths.
 *
 * Unlike a fixed mkdir path, stale reclaim removes the exact UUID ticket that
 * was classified stale. A replacement holder always has another path, so two
 * reclaimers cannot delete it through an ABA path swap.
 */
export function acquireMkdirTicketLock(
  lockDir: string,
  options: MkdirTicketLockOptions = {},
): AcquiredMkdirLock {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const label = options.label ?? 'mkdir ticket';
  const deadline = Date.now() + deadlineMs;
  const id = randomUUID();
  mkdirSync(lockDir, { recursive: true });

  const choosingPath = join(lockDir, `${id}.choosing`);
  writeFileSync(
    choosingPath,
    JSON.stringify(options.holderInfo ?? {
      pid: process.pid,
      hostname: 'unknown',
      command: label,
      acquiredAt: new Date().toISOString(),
      lockId: id,
    }, null, 2) + '\n',
    { encoding: 'utf8', flag: 'wx' },
  );

  let ticketPath = '';
  try {
    const existingNumbers = ticketCandidates(lockDir, '.ticket', staleMs)
      .map(candidate => Number(candidate.name.slice(0, candidate.name.indexOf('-'))))
      .filter(Number.isFinite);
    const number = (existingNumbers.length > 0 ? Math.max(...existingNumbers) : 0) + 1;
    ticketPath = join(lockDir, `${String(number).padStart(16, '0')}-${id}.ticket`);
    renameSync(choosingPath, ticketPath);

    while (true) {
      const choosing = removeStaleUniqueTickets(lockDir, '.choosing', options, staleMs);
      const tickets = removeStaleUniqueTickets(lockDir, '.ticket', options, staleMs)
        .sort((a, b) => a.name.localeCompare(b.name));
      if (choosing.length === 0 && tickets[0]?.path === ticketPath) break;
      if (Date.now() > deadline) {
        throw new Error(`${label} lock timeout after ${deadlineMs}ms`);
      }
      sleepSync(pollMs);
    }
  } catch (error) {
    rmSync(choosingPath, { force: true });
    if (ticketPath) rmSync(ticketPath, { force: true });
    throw error;
  }

  return {
    lockDir: ticketPath,
    release() {
      rmSync(ticketPath, { force: true });
    },
  };
}

export function withMkdirTicketLock<T>(
  lockDir: string,
  fn: () => T,
  options: MkdirTicketLockOptions = {},
): T {
  const lock = acquireMkdirTicketLock(lockDir, options);
  try {
    return fn();
  } finally {
    lock.release();
  }
}

export const REVIEW_METADATA_TICKET_LOCK_DIR = 'review-metadata-transaction.lock';

function reviewMetadataBarrierConfig(
  lockDir: string,
  operation: string,
): { root: string; id: 'w1' | 'w2' } | null {
  if (process.env.NODE_ENV !== 'test') return null;
  if (readBrandEnv('INTERNAL_REVIEW_METADATA_BARRIER') !== 'enabled') return null;
  const id = operation.startsWith('review_run_start') ? 'w2'
    : operation.startsWith('agent_prompt') ? 'w1'
      : null;
  if (!id) return null;
  return { root: join(dirname(lockDir), '.review-metadata-test-barrier'), id };
}

function waitForReviewMetadataBarrier(path: string): void {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`review metadata test barrier timed out: ${path}`);
    sleepSync(5);
  }
}

/**
 * Shared transaction boundary for every producer that can update reviewer
 * protocol metadata. In particular, review_run_start and Story-aware
 * agent_prompt must use this exact lock so prompt-envelopes.json cannot lose a
 * review-run envelope to a concurrent audit-only writer.
 */
export function acquireReviewMetadataTicketLock(
  lockDir: string,
  operation: string,
  overrides: Pick<MkdirTicketLockOptions, 'onBeforeStaleTicketRemove' | 'pollMs'> = {},
): AcquiredMkdirLock {
  const localHostname = hostname();
  const barrier = reviewMetadataBarrierConfig(lockDir, operation);
  const callerBeforeStaleRemove = overrides.onBeforeStaleTicketRemove;
  return acquireMkdirTicketLock(lockDir, {
    label: 'review metadata transaction',
    deadlineMs: 120_000,
    staleMs: 10_000,
    ...overrides,
    onBeforeStaleTicketRemove: ticketPath => {
      callerBeforeStaleRemove?.(ticketPath);
      if (!barrier || !ticketPath.endsWith('dead-a.ticket')) return;
      writeFileSync(join(barrier.root, `observed-${barrier.id}`), ticketPath);
      waitForReviewMetadataBarrier(join(barrier.root, `allow-remove-${barrier.id}`));
    },
    holderInfo: {
      pid: process.pid,
      hostname: localHostname,
      command: operation,
      acquiredAt: new Date().toISOString(),
    },
    classifyExistingLock: ({ holder }) => {
      if (!holder || holder.hostname !== localHostname) return 'unknown';
      try {
        process.kill(holder.pid, 0);
        return 'active';
      } catch (error: any) {
        return error?.code === 'ESRCH' ? 'stale' : 'active';
      }
    },
  });
}

export function withReviewMetadataTicketLock<T>(
  lockDir: string,
  operation: string,
  fn: () => T,
  overrides: Pick<MkdirTicketLockOptions, 'onBeforeStaleTicketRemove' | 'pollMs'> = {},
): T {
  const lock = acquireReviewMetadataTicketLock(lockDir, operation, overrides);
  const barrier = reviewMetadataBarrierConfig(lockDir, operation);
  try {
    if (barrier) {
      writeFileSync(join(barrier.root, `acquired-${barrier.id}`), lock.lockDir);
      waitForReviewMetadataBarrier(join(barrier.root, `release-${barrier.id}`));
    }
    const result = fn();
    if (barrier) writeFileSync(join(barrier.root, `completed-${barrier.id}`), operation);
    return result;
  } finally {
    lock.release();
  }
}
