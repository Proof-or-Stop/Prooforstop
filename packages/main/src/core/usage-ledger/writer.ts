/**
 * B-253e CHK-002 / CHK-004 / CHK-006: the single append-only writer for the LLM
 * usage ledger — the completeness choke-point.
 *
 * This module is the ONLY code that writes `.proof-or-stop/usage/llm-usage.jsonl`.
 * `fs` access to the ledger is private to this module: callers hand a record to
 * `appendUsageRecord` and never touch the file directly. The smoke test asserts
 * no other module under `core/` references the ledger path or appends to it.
 *
 * Responsibilities (per "JSONL Ledger Record Shape", "Required record
 * constraints", "Completeness Guarantee", "Privacy Constraints"):
 *   - opt-out gate (CHK-006): default ON; a strict no-op when the flag is set
 *     OFF (PROOF_OR_STOP_USAGE_LEDGER=0) — writes nothing and creates no file/directory;
 *   - ensure `.proof-or-stop/usage/` exists;
 *   - validate the record (CHK-001) and reject privacy/secret/raw-content and
 *     stored-total fields (CHK-004) before any write;
 *   - compute `recordHash` over the canonical record minus `recordHash`, and
 *     chain `previousRecordHash` from the prior line's `recordHash` (genesis =
 *     null);
 *   - append EXACTLY one JSON line; never rewrite or edit prior lines.
 *
 * This slice is FOUNDATION only: no provider adapters, no live dispatch, no
 * estimate computation, no budget enforcement, no Authority receipt path.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { canonicalJson } from './canonical-json.js';
import {
  type UsageLedgerRecord,
  type UsageLedgerRecordInput,
  validateUsageLedgerRecord,
} from './record.js';
import { readBrandEnv } from '../brand-env.js';
import { PROOF_OR_STOP_DIR } from '../proof-or-stop-paths.js';

/** Relative path of the ledger from the project root. */
export const USAGE_LEDGER_DIR = join(PROOF_OR_STOP_DIR, 'usage');
export const USAGE_LEDGER_FILENAME = 'llm-usage.jsonl';
export const USAGE_LEDGER_RELATIVE_PATH = join(USAGE_LEDGER_DIR, USAGE_LEDGER_FILENAME);

/**
 * Genesis sentinel for the first record's `previousRecordHash`. Stored as JSON
 * `null` on the record; this constant documents the genesis value.
 */
export const GENESIS_PREVIOUS_HASH = null;

/**
 * Ledger enable flag (CHK-006). Default ON; set PROOF_OR_STOP_USAGE_LEDGER=0 to disable.
 * When the flag is UNSET the ledger is active by default; the explicit escape
 * hatch ('0'/'false'/'off'/'no'/'') disables usage rows and the budget guard
 * while preserving the original provider argv. Provider-process admission and
 * its canonical registry I/O remain mandatory independently of this flag.
 *
 * Read every call (not memoized) so tests and operators can toggle it without
 * restarting the process.
 */
export function isUsageLedgerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = readBrandEnv('USAGE_LEDGER', env);
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
}

/**
 * Compute the record hash: sha256 over the canonical record with the
 * `integrity.recordHash` field removed (but `previousRecordHash` retained, so
 * the chain link is bound into the hash). Returns a `sha256:<hex>` string.
 */
export function computeRecordHash(record: UsageLedgerRecord): string {
  const forHashing: Record<string, unknown> = { ...record };
  const integrity = { ...(record.integrity ?? {}) } as Record<string, unknown>;
  delete integrity.recordHash;
  forHashing.integrity = integrity;
  const digest = createHash('sha256').update(canonicalJson(forHashing), 'utf8').digest('hex');
  return `sha256:${digest}`;
}

/** Resolve the absolute ledger file path under a project root. */
export function resolveLedgerPath(projectRoot: string): string {
  return join(projectRoot, USAGE_LEDGER_RELATIVE_PATH);
}

// ---------------------------------------------------------------------------
// F-012: cross-process append serialization.
//
// appendUsageRecord's read-last-hash -> append section is a classic TOCTOU:
// concurrent host_run processes (the ledger is default-ON and host_run's cap-4
// concurrency is the feature's EXPECTED mode) could read the same predecessor
// and append rows whose previousRecordHash breaks verifyLedgerChain. The
// critical section is therefore guarded by a cross-process mutex: an atomic
// mkdir of a sibling lock DIRECTORY (`llm-usage.jsonl.lock/`). mkdirSync either
// creates the dir (lock acquired) or fails EEXIST (held) — there is no
// in-between, so at most one process is inside the section at a time.
// Dependency-free and synchronous, matching this module's contract.
//
// F-018: ownership-aware reclaim — never steal a live holder. The acquirer
// records `owner.json` (holder pid + a unique release token) inside the lock
// dir. A held lock is reclaimable ONLY when:
//   (a) owner.json is present/valid and its pid is DEAD (process.kill(pid,0)
//       throws ESRCH), regardless of lock age; or
//   (b) owner.json is missing or unreadable/corrupt AND the dir mtime exceeds
//       the orphan backstop (PROOF_OR_STOP_USAGE_LEDGER_LOCK_STALE_MS) — this covers
//       exactly the mkdir-then-crash-before-owner-write window (plus external
//       corruption), where pid liveness is unknowable.
// A LIVE pid with a valid owner.json is NEVER reclaimed, no matter how old the
// lock is: a holder stuck inside the critical section (large ledger read, slow
// filesystem, GC pause, process suspension) keeps its lock; waiters wait out
// their bounded budget and then skip-not-corrupt. Accepted residual: a dead
// holder's pid may have been reused by an unrelated live process (standard
// pid-reuse residual) — such a lock is simply never reclaimed and waiters skip;
// the token guards RELEASE, not reclaim.
// ---------------------------------------------------------------------------

/** Suffix appended to the ledger path to form the lock directory. */
export const USAGE_LEDGER_LOCK_SUFFIX = '.lock';

/** Owner file written inside the lock dir by the acquirer (F-018). */
export const USAGE_LEDGER_LOCK_OWNER_FILENAME = 'owner.json';

/** Bounded total wait for the lock (env PROOF_OR_STOP_USAGE_LEDGER_LOCK_WAIT_MS). */
const DEFAULT_LOCK_WAIT_MS = 5_000;
/** Orphan backstop (env PROOF_OR_STOP_USAGE_LEDGER_LOCK_STALE_MS). F-018: this age
 * threshold applies ONLY to ownerless/corrupt locks — the holder crashed
 * between mkdir and recording owner.json, so pid liveness is unknowable and
 * mtime age is the only signal left. Locks with a valid owner.json are
 * reclaimed on pid death alone and NEVER on age. */
const DEFAULT_LOCK_STALE_MS = 30_000;
/** Sleep between acquisition retries. */
const LOCK_RETRY_SLEEP_MS = 25;

/** Resolve the lock directory used to serialize appends for a project root. */
export function resolveLedgerLockPath(projectRoot: string): string {
  return `${resolveLedgerPath(projectRoot)}${USAGE_LEDGER_LOCK_SUFFIX}`;
}

function nonNegativeIntEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = readBrandEnv(key, env);
  if (raw === undefined) return fallback;
  const parsed = Number(raw.trim());
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

let sleepView: Int32Array<SharedArrayBuffer> | null = null;

/**
 * Synchronous, dependency-free sleep: Atomics.wait on a throwaway
 * SharedArrayBuffer (never notified, so it simply times out after `ms`).
 * Falls back to a bounded busy-wait if SharedArrayBuffer is unavailable.
 */
function sleepSync(ms: number): void {
  try {
    if (sleepView === null) sleepView = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sleepView, 0, 0, ms);
    return;
  } catch {
    // fall through to the busy-wait below
  }
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // bounded busy-wait fallback
  }
}

/** Result of reading a lock dir's owner.json (F-018). */
type LockOwnerRead =
  | { state: 'valid'; pid: number; token: string }
  | { state: 'corrupt' } // present but unreadable or malformed
  | { state: 'missing' };

/** Read + parse `owner.json` from a lock dir. Never throws. */
function readLockOwner(lockDir: string): LockOwnerRead {
  const ownerPath = join(lockDir, USAGE_LEDGER_LOCK_OWNER_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(ownerPath, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? { state: 'missing' }
      : { state: 'corrupt' };
  }
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; token?: unknown };
    if (
      typeof parsed?.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0
      && typeof parsed?.token === 'string' && parsed.token.length > 0
    ) {
      return { state: 'valid', pid: parsed.pid, token: parsed.token };
    }
  } catch {
    // fall through: unparseable JSON is corrupt
  }
  return { state: 'corrupt' };
}

/**
 * Record ownership inside a just-acquired lock dir. Returns the minted release
 * token, or null when the write failed (the caller must give the dir back
 * rather than hold an ownerless lock). Small and synchronous by contract.
 */
function writeLockOwner(lockDir: string): string | null {
  const token = randomUUID();
  try {
    writeFileSync(
      join(lockDir, USAGE_LEDGER_LOCK_OWNER_FILENAME),
      JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }),
      'utf8',
    );
    return token;
  } catch {
    return null;
  }
}

/** True when the pid is (or may be) a running process. ESRCH => dead; EPERM => alive. */
function isLockOwnerPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Remove an abandoned lock (owner.json + rmdir) after re-verifying that the
 * owner state still matches what we judged reclaimable — if a concurrent
 * reclaimer already won and a NEW holder re-acquired, its fresh owner.json no
 * longer matches and we back off. The remaining re-verify -> unlink window is
 * the same pid-reuse-class residual documented on the module header; losing
 * any step of the race is harmless (the loser just retries within budget).
 */
function reclaimLedgerLock(lockDir: string, judged: LockOwnerRead): void {
  try {
    const current = readLockOwner(lockDir);
    if (current.state !== judged.state) return;
    if (current.state === 'valid' && judged.state === 'valid' && current.token !== judged.token) return;
    if (current.state !== 'missing') {
      try {
        unlinkSync(join(lockDir, USAGE_LEDGER_LOCK_OWNER_FILENAME));
      } catch {
        // already unlinked by a racing reclaimer — rmdir below settles it
      }
    }
    rmdirSync(lockDir);
  } catch {
    // lost the reclaim race to another writer (or a new holder's owner.json
    // landed first: rmdir fails ENOTEMPTY) — harmless, retry within budget
  }
}

/**
 * F-018 stale evaluation for a held lock. Reclaims ONLY a provably-abandoned
 * lock: valid owner + dead pid (any age), or ownerless/corrupt owner + dir
 * mtime beyond the orphan backstop. A live holder is never touched.
 */
function maybeReclaimAbandonedLock(lockDir: string, staleMs: number): void {
  const owner = readLockOwner(lockDir);
  if (owner.state === 'valid') {
    // A LIVE pid with a valid owner.json is NEVER reclaimed regardless of lock
    // age — waiters keep waiting until their bounded budget expires, then
    // skip-not-corrupt. (Pid-reuse can make a dead holder look alive; accepted
    // residual — see the module header.)
    if (isLockOwnerPidAlive(owner.pid)) return;
    reclaimLedgerLock(lockDir, owner);
    return;
  }
  // Ownerless or corrupt owner.json: pid liveness is unknowable (holder
  // crashed between mkdir and the owner write, or the file was damaged). The
  // mtime backstop is the only remaining signal; a YOUNG ownerless lock may be
  // a holder mid-way through writing owner.json, so age must exceed the
  // generous orphan threshold before it is reclaimed.
  try {
    const age = Date.now() - statSync(lockDir).mtimeMs;
    if (age <= staleMs) return;
  } catch {
    return; // holder released between mkdir-fail and stat — retry
  }
  reclaimLedgerLock(lockDir, owner);
}

/**
 * Acquire the cross-process append lock. Returns the minted owner token when
 * acquired, or null when the bounded wait elapsed without acquisition.
 * Reclaim is ownership-aware (F-018): see maybeReclaimAbandonedLock. Losing
 * a reclaim/re-create race to another writer is harmless (the loser just
 * keeps retrying within budget).
 *
 * Exported for the smoke suite (release-token-guard coverage); production
 * callers go through appendUsageRecord only.
 */
export function acquireLedgerLock(lockDir: string, env: NodeJS.ProcessEnv): string | null {
  const waitMs = nonNegativeIntEnv(env, 'PROOF_OR_STOP_USAGE_LEDGER_LOCK_WAIT_MS', DEFAULT_LOCK_WAIT_MS);
  const staleMs = nonNegativeIntEnv(env, 'PROOF_OR_STOP_USAGE_LEDGER_LOCK_STALE_MS', DEFAULT_LOCK_STALE_MS);
  const deadline = Date.now() + waitMs;
  for (;;) {
    let acquired = false;
    try {
      mkdirSync(lockDir); // atomic: creates OR fails EEXIST — never both
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        // Unexpected fs failure (e.g. the usage dir vanished mid-flight):
        // best-effort re-create the parent, then keep retrying within budget.
        try {
          mkdirSync(dirname(lockDir), { recursive: true });
        } catch {
          // retry below
        }
      } else {
        // Held by another process. Reclaim only when it is provably abandoned.
        maybeReclaimAbandonedLock(lockDir, staleMs);
      }
    }
    if (acquired) {
      const token = writeLockOwner(lockDir);
      if (token !== null) return token;
      // Could not record ownership (e.g. disk full): give the dir back rather
      // than hold an ownerless lock that only the mtime backstop could clear.
      try {
        rmdirSync(lockDir);
      } catch {
        // best-effort — the backstop covers a leak here
      }
    }
    if (Date.now() >= deadline) return null;
    sleepSync(LOCK_RETRY_SLEEP_MS);
  }
}

/**
 * Release the lock ONLY while owner.json still carries OUR token (F-018
 * read-verify-then-delete). If the token differs — or the owner file is gone —
 * someone legitimately reclaimed the lock after judging us dead (a pid-death
 * false positive, e.g. pid probe raced our exit path) and may already hold a
 * fresh lock: do NOT remove theirs; just return. The tiny check-then-delete
 * window between the read and the unlink is the same pid-reuse-class residual
 * documented on the module header.
 *
 * Exported for the smoke suite (release-token-guard coverage); production
 * callers go through appendUsageRecord only.
 */
export function releaseLedgerLock(lockDir: string, token: string): void {
  try {
    const owner = readLockOwner(lockDir);
    if (owner.state !== 'valid' || owner.token !== token) return;
    try {
      unlinkSync(join(lockDir, USAGE_LEDGER_LOCK_OWNER_FILENAME));
    } catch {
      // already gone — proceed to the rmdir
    }
    rmdirSync(lockDir);
  } catch {
    // Best-effort: a reclaimer may have already removed it. Never let a
    // release failure mask a successful append.
  }
}

/**
 * Read the last line's `recordHash` to chain from. Returns `null` when the file
 * is absent or empty (genesis). Throws when the last line is unparseable or is
 * missing a `recordHash` — a chain cannot be built from a corrupt predecessor.
 */
function readLastRecordHash(ledgerPath: string): string | null {
  if (!existsSync(ledgerPath)) return null;
  const content = readFileSync(ledgerPath, 'utf8');
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;
  const lastLine = lines[lines.length - 1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    throw new Error('usage-ledger: cannot chain from a corrupt last line (unparseable JSON)');
  }
  const hash = (parsed as { integrity?: { recordHash?: unknown } })?.integrity?.recordHash;
  if (typeof hash !== 'string' || hash.length === 0) {
    throw new Error('usage-ledger: last line is missing integrity.recordHash; cannot chain');
  }
  return hash;
}

export interface AppendResult {
  /** false when the ledger flag was set OFF (strict no-op). */
  written: boolean;
  /** The finalized record (with computed integrity), when written. */
  record?: UsageLedgerRecord;
  /** Absolute path written to, when written. */
  path?: string;
}

export interface AppendOptions {
  /** Override env for the ledger flag check (tests). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Append exactly one record to the ledger. THE single write choke-point.
 *
 * Behaviour:
 *   - flag OFF -> strict no-op (returns {written:false}, no file, no dir);
 *   - validates the record and the privacy/secret denylist; THROWS on any
 *     violation BEFORE writing (no partial line);
 *   - computes `recordHash`, chains `previousRecordHash` from the prior line
 *     (genesis = null), overwriting any caller-supplied integrity so a caller
 *     cannot forge or inject a hash;
 *   - F-012/F-018: serializes the read-last-hash -> append section behind a
 *     cross-process mkdir lock (sibling `llm-usage.jsonl.lock/` dir; bounded
 *     wait PROOF_OR_STOP_USAGE_LEDGER_LOCK_WAIT_MS). Reclaim is OWNERSHIP-AWARE:
 *     the acquirer records owner.json (pid + release token); a held lock is
 *     reclaimed only on holder pid death, or — for ownerless/corrupt locks —
 *     past the PROOF_OR_STOP_USAGE_LEDGER_LOCK_STALE_MS orphan backstop; a live
 *     holder is never stolen. On bounded-wait exhaustion it THROWS
 *     (skip-not-corrupt) instead of appending off a stale predecessor;
 *   - appends one newline-terminated JSON line; never edits prior lines.
 */
export function appendUsageRecord(
  projectRoot: string,
  input: UsageLedgerRecordInput,
  options: AppendOptions = {},
): AppendResult {
  // CHK-006: strict no-op when disabled. No file, no directory, no side effects.
  if (!isUsageLedgerEnabled(options.env)) {
    return { written: false };
  }

  // Validate the caller-supplied record body BEFORE chaining. Integrity is
  // computed by the writer, so it is not required of the caller here. This also
  // runs the CHK-004 privacy/secret/stored-total deep scan.
  const preCheck = validateUsageLedgerRecord(stripIntegrity(input), { expectIntegrity: false });
  if (!preCheck.ok) {
    throw new Error(`usage-ledger: refused to write invalid record:\n - ${preCheck.errors.join('\n - ')}`);
  }

  const ledgerPath = resolveLedgerPath(projectRoot);
  mkdirSync(dirname(ledgerPath), { recursive: true });

  // F-012: the read-last-hash -> append section below MUST be atomic across
  // processes, or two concurrent writers chain off the same predecessor and
  // corrupt the ledger for every future verifyLedgerChain. Record assembly and
  // the pre-check above stay OUTSIDE the lock; only the predecessor-dependent
  // section (read last line -> finalize integrity -> append) is held.
  const env = options.env ?? process.env;
  const lockDir = `${ledgerPath}${USAGE_LEDGER_LOCK_SUFFIX}`;
  const lockToken = acquireLedgerLock(lockDir, env);
  if (lockToken === null) {
    // F-012 tradeoff (skip-not-corrupt): after the bounded wait we REFUSE to
    // append rather than write a row chained off a possibly-stale predecessor —
    // a stale-predecessor append is exactly the chain corruption this lock
    // exists to prevent. The throw rides the writer's EXISTING error path: the
    // dispatch seams (dispatch-usage.ts) already catch and fail open, so the
    // outcome is an honest under-count that reconciliation doctrine can see,
    // never a corrupt chain.
    throw new Error(
      'usage-ledger: could not acquire the cross-process append lock within the bounded wait; '
      + 'skipping this append (skip-not-corrupt: appending with a possibly-stale predecessor would break the hash chain)',
    );
  }
  try {
    // Chain from the prior line. A corrupt predecessor throws here, before write.
    const previousRecordHash = readLastRecordHash(ledgerPath);

    // Build the finalized record. The writer OWNS integrity: any caller-supplied
    // recordHash/previousRecordHash is discarded so a caller cannot forge it.
    const finalized: UsageLedgerRecord = {
      ...(input as Omit<UsageLedgerRecord, 'integrity'>),
      integrity: {
        previousRecordHash,
        recordHash: '', // filled below
      },
    };
    finalized.integrity.recordHash = computeRecordHash(finalized);

    // Defense in depth: validate the finalized record WITH integrity. This also
    // re-runs the privacy/stored-total scan on the exact bytes about to be written.
    const finalCheck = validateUsageLedgerRecord(finalized, { expectIntegrity: true });
    if (!finalCheck.ok) {
      throw new Error(`usage-ledger: finalized record failed validation:\n - ${finalCheck.errors.join('\n - ')}`);
    }

    // Append EXACTLY one line. Never rewrite or edit prior lines.
    appendFileSync(ledgerPath, `${JSON.stringify(finalized)}\n`, 'utf8');

    return { written: true, record: finalized, path: ledgerPath };
  } finally {
    releaseLedgerLock(lockDir, lockToken);
  }
}

function stripIntegrity(input: UsageLedgerRecordInput): Omit<UsageLedgerRecordInput, 'integrity'> {
  const { integrity: _integrity, ...rest } = input;
  return rest;
}

/**
 * Verify the hash chain of a ledger file (tamper detection). Returns the parsed
 * records when valid; throws with the offending line index when a recomputed
 * `recordHash` does not match, or when `previousRecordHash` does not match the
 * predecessor's `recordHash`. This is local tamper evidence only — it does NOT
 * make the ledger Authority evidence.
 */
export function verifyLedgerChain(ledgerPath: string): UsageLedgerRecord[] {
  if (!existsSync(ledgerPath)) return [];
  const content = readFileSync(ledgerPath, 'utf8');
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  const records: UsageLedgerRecord[] = [];
  let expectedPrevious: string | null = GENESIS_PREVIOUS_HASH;

  lines.forEach((line, index) => {
    let record: UsageLedgerRecord;
    try {
      record = JSON.parse(line) as UsageLedgerRecord;
    } catch {
      throw new Error(`usage-ledger: line ${index} is not valid JSON`);
    }
    const recomputed = computeRecordHash(record);
    if (recomputed !== record.integrity?.recordHash) {
      throw new Error(`usage-ledger: line ${index} recordHash mismatch (tampered content)`);
    }
    if ((record.integrity?.previousRecordHash ?? null) !== expectedPrevious) {
      throw new Error(`usage-ledger: line ${index} previousRecordHash breaks the chain (tampered predecessor)`);
    }
    expectedPrevious = record.integrity.recordHash;
    records.push(record);
  });

  return records;
}
