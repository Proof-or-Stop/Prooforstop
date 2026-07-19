import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
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
  return acquireMkdirTicketLock(lockDir, {
    label: 'review metadata transaction',
    deadlineMs: 120_000,
    staleMs: 10_000,
    ...overrides,
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
  try {
    return fn();
  } finally {
    lock.release();
  }
}
