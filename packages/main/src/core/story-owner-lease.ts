import { VALIDATION_EXECUTION_RUNTIME_REQUIREMENTS } from './runtime-fact-registry.js';
/**
 * B-c55d CHK-001: story owner lease core (local session ownership).
 *
 * session-ownership-and-write-leases.md rollout step 2b — "story owner lease".
 * Implements local Proof-or-Stop session ownership coordination so that, when multiple
 * agent sessions run in parallel, "one story has one mutating owner" is a
 * mechanically-enforced fact rather than something humans negotiate in chat.
 *
 * HARD BOUNDARIES (do not cross — design ruling from the story background):
 *  - This is LOCAL session coordination, NOT a strong-identity security
 *    mechanism. `sessionId` is a process-local coordination id: NOT a
 *    cryptographic identity, NO public/private key, NO server authority, NO
 *    reviewer attestation. A session can in principle forge another session's
 *    id; the lease only protects against accidental concurrent authoring, not a
 *    malicious actor.
 *  - This is ORTHOGONAL to the B-f60c main write lock
 *    (`core/main-write-lock.ts`). The main write lock serializes cross-session
 *    shared writes to main / B-META; the owner lease governs intra-story
 *    authoring / lifecycle-mutation ownership. They are not merged, and CHK-001
 *    does not touch the main write lock at all.
 *
 * CHK-001 SCOPE (this file): the lease primitive itself — a stable per-process
 * `sessionId`, the `owner-lease.json` schema, and acquire / refresh-heartbeat /
 * release / read APIs. The non-owner REJECTION gate, ownershipClass command
 * classification, and stale/takeover handling are explicitly OUT of CHK-001
 * scope (they are CHK-002 / CHK-003).
 *
 * F-008-CLASS DIRTY-WRITE PREVENTION: `owner-lease.json` is a runtime artifact.
 * It lives under the git-tracked `.proof-or-stop/story/actives/<id>/` subtree, so an
 * un-ignored lease file would show up as an uncommitted change and could block
 * the DONE `git merge story/<id>` (the same failure mode as B-f60c F-008). The
 * file is therefore registered in `core/runtime-artifact-registry.ts` (entry
 * `runtime-story-owner-lease`) and `.gitignore` carries a matching
 * glob-star owner-lease.json pattern, so it is NEVER tracked and NEVER
 * produces a dirty write before DONE.
 */

import { randomUUID, createHash } from 'node:crypto';
import { withMkdirLock } from './mkdir-lock.js';
import { storyRuntimeLockPath } from './shared-lock-root.js';
import { hostname } from 'os';
import { basename, dirname, join, resolve } from 'path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { appendActivityLog } from './activity-log.js';
import { bumpTakeoverCount } from './convergence-state-files.js';
import {
  deriveLocalSessionId,
  getSessionId,
  getSessionIdentity,
  renderSessionIdentityDiagnostic,
  warnIfDerivedPpidSessionIdentity,
  normalizeSessionSource,
  resetSessionIdForTest,
  resolveSessionIdentity,
  type SessionDerivationInputs,
  type SessionEnv,
  type SessionIdentity,
  type SessionSource,
} from './owner-session.js';

export {
  deriveLocalSessionId,
  getSessionId,
  getSessionIdentity,
  renderSessionIdentityDiagnostic,
  resetSessionIdForTest,
  resolveSessionIdentity,
};

export type {
  SessionDerivationInputs,
  SessionEnv,
  SessionIdentity,
  SessionSource,
};

/**
 * Filename of the per-story owner lease, written under the story directory
 * (`.proof-or-stop/story/actives/<storyId>/owner-lease.json`).
 *
 * Kept as an exported constant so the runtime-artifact registry, doctor checks,
 * and tests all reference the SAME literal instead of re-typing the string.
 */
export const OWNER_LEASE_FILE = 'owner-lease.json';

/**
 * On-disk schema for `owner-lease.json`.
 *
 * Every field except `label` is required. `label` is an optional
 * human-readable hint (e.g. an agent role) shown by `session_brief`; it carries
 * no gate semantics.
 */
export interface StoryOwnerLease {
  /** Acquisition generation; absent only on legacy leases. */
  leaseId?: string;
  /**
   * Process-local session coordination id of the owning session.
   *
   * NOT a cryptographic identity — see the file header. Stable within a single
   * process: every read inside one process/session returns the same value.
   */
  sessionId: string;
  /**
   * How `sessionId` was identified — `explicit-env` / `host-adapter` /
   * `generated-token` / `derived-ppid`. Surfaced by `session_brief` and
   * debugging so an operator can see whether the session came from the
   * canonical env, a host adapter, a local generated token, or the degraded
   * ppid fallback.
   *
   * Optional: leases written before this field existed (pre-amendment) simply
   * omit it; `readOwnerLease` still accepts them. New leases always populate it.
   */
  sessionSource?: SessionSource;
  /** Hostname of the machine that holds the lease. */
  hostname: string;
  /** PID of the process that acquired / last refreshed the lease. */
  pid: number;
  /** Working directory of the owning session at acquire time. */
  cwd: string;
  /** The proof-or-stop command that first acquired the lease (audit context). */
  command: string;
  /** ISO 8601 timestamp of the initial acquire. */
  acquiredAt: string;
  /** ISO 8601 timestamp of the most recent owner mutating command. */
  heartbeatAt: string;
  /** Optional human-readable label (e.g. agent role); no gate semantics. */
  label?: string;
}

/** Trim a possibly-undefined string; empty / whitespace-only becomes null. */
function trimToNull(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the absolute path of a story's `owner-lease.json`.
 *
 * `storyDir` MUST be the absolute story directory
 * (`.proof-or-stop/story/actives/<storyId>`). Runtime re-validation rejects an empty
 * path rather than silently joining onto `''` — mirrors the "Handler Coding Conventions"
 * rule that load-bearing invariants are re-checked at every consumer instead of
 * trusting an upstream schema.
 */
export function ownerLeasePath(storyDir: string): string {
  const dir = String(storyDir ?? '').trim();
  if (!dir) {
    throw new Error('ownerLeasePath: storyDir is required');
  }
  return join(dir, OWNER_LEASE_FILE);
}

/**
 * Read and validate the owner lease for a story directory.
 *
 * Returns `null` when no lease file exists (no owner yet). A file that exists
 * but is malformed (bad JSON, missing/empty required fields, wrong types) is
 * ALSO treated as "no valid lease" → `null`. A corrupt lease must never be
 * trusted as an ownership record; callers that need to (re)acquire simply
 * overwrite it. Returning `null` instead of throwing keeps a damaged runtime
 * artifact from hard-blocking every story-scoped command.
 */
export function readOwnerLease(storyDir: string): StoryOwnerLease | null {
  const path = ownerLeasePath(storyDir);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
  return normalizeLease(parsed);
}

/**
 * Validate a parsed object against the `StoryOwnerLease` schema.
 *
 * Runtime field-by-field re-validation (per "Handler Coding Conventions"): every required
 * field must be a non-empty string / finite number. `label` is optional and
 * only kept when it is a non-empty string. Any failure → `null`.
 */
function normalizeLease(value: unknown): StoryOwnerLease | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;

  const sessionId = nonEmptyString(v.sessionId);
  const host = nonEmptyString(v.hostname);
  const cwd = nonEmptyString(v.cwd);
  const command = nonEmptyString(v.command);
  const acquiredAt = nonEmptyString(v.acquiredAt);
  const heartbeatAt = nonEmptyString(v.heartbeatAt);
  const pid =
    typeof v.pid === 'number' && Number.isFinite(v.pid) ? v.pid : null;

  if (
    sessionId === null ||
    host === null ||
    cwd === null ||
    command === null ||
    acquiredAt === null ||
    heartbeatAt === null ||
    pid === null
  ) {
    return null;
  }

  const lease: StoryOwnerLease = {
    sessionId,
    hostname: host,
    pid,
    cwd,
    command,
    acquiredAt,
    heartbeatAt,
  };
  // sessionSource is optional (absent on pre-amendment leases). Legacy values
  // are normalized to the current vocabulary; an unknown / malformed value is
  // dropped rather than rejecting the whole lease.
  const sessionSource = normalizeSessionSource(v.sessionSource);
  if (sessionSource !== null) lease.sessionSource = sessionSource;
  const leaseId = nonEmptyString(v.leaseId);
  if (leaseId !== null) lease.leaseId = leaseId;
  const label = nonEmptyString(v.label);
  if (label !== null) lease.label = label;
  return lease;
}

/** Return a trimmed non-empty string, or `null`. */
function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizedCwdForCompare(value: unknown): string | null {
  const cwd = nonEmptyString(value);
  if (cwd === null) return null;
  try { return realpathSync(resolve(cwd)); } catch { return resolve(cwd); }
}

function ownerCwdMatchesCurrent(ownerCwd: unknown, currentCwd: unknown): boolean {
  const owner = normalizedCwdForCompare(ownerCwd);
  const current = normalizedCwdForCompare(currentCwd);
  return owner !== null && current !== null && owner === current;
}

/** Options shared by `acquireOwnerLease` / `refreshOwnerLease`. */
export interface OwnerLeaseWriteOptions {
  /** proof-or-stop command label recorded in the lease (audit context). */
  command: string;
  /** Working directory of the owning session. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Optional human-readable label (e.g. agent role). */
  label?: string;
  /**
   * Clock injection for deterministic tests. Defaults to
   * `() => new Date().toISOString()`. Production callers omit it.
   */
  now?: () => string;
}

/** Atomically write `lease` to `owner-lease.json` for `storyDir`. */
function writeLease(storyDir: string, lease: StoryOwnerLease): void {
  const dir = String(storyDir ?? '').trim();
  if (!dir) {
    throw new Error('writeLease: storyDir is required');
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const temporary = join(dir, `.owner-lease-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(lease, null, 2)}\n`, 'utf-8');
    renameSync(temporary, ownerLeasePath(dir));
  } finally { rmSync(temporary, { force: true }); }
}

/**
 * Acquire the owner lease for a story, recording the CURRENT session as owner.
 *
 * This is the "first story-scoped mutating command for a story acquires the
 * lease" entry point. It writes a fresh `owner-lease.json` with `acquiredAt`
 * and `heartbeatAt` both set to now. CHK-001 deliberately does NOT reject a
 * pre-existing lease owned by another session here — non-owner rejection is the
 * CHK-002 gate's job. `acquireOwnerLease` only ensures the lease file exists
 * and names the current session; an existing same-session lease is simply
 * overwritten with a refreshed timestamp pair.
 *
 * The lease's `command` field reflects whichever command first wrote the file.
 */
function acquireOwnerLeaseUnlocked(
  storyDir: string,
  options: OwnerLeaseWriteOptions,
): StoryOwnerLease {
  const command = nonEmptyString(options?.command);
  if (command === null) {
    throw new Error('acquireOwnerLease: command is required');
  }
  const nowFn = options.now ?? (() => new Date().toISOString());
  const stamp = nowFn();
  const identity = getSessionIdentity();
  const lease: StoryOwnerLease = {
    leaseId: randomUUID(),
    sessionId: identity.sessionId,
    sessionSource: identity.sessionSource,
    hostname: hostname(),
    pid: process.pid,
    cwd: nonEmptyString(options.cwd) ?? process.cwd(),
    command,
    acquiredAt: stamp,
    heartbeatAt: stamp,
  };
  const label = nonEmptyString(options.label);
  if (label !== null) lease.label = label;
  writeLease(storyDir, lease);
  return lease;
}

/**
 * Refresh the heartbeat of an existing owner lease.
 *
 * Called when a session that ALREADY owns the lease runs a further
 * story-scoped mutating command: only `heartbeatAt` advances; `acquiredAt`,
 * `sessionId`, and the original `command` are preserved. `pid` / `hostname` /
 * `cwd` are re-stamped from the current process so a long-lived owner session
 * that moved working directory keeps an accurate record.
 *
 * Returns `null` (no write) when there is no readable lease — refresh never
 * creates a lease; that is `acquireOwnerLease`'s job.
 */
function refreshOwnerLeaseUnlocked(
  storyDir: string,
  options: OwnerLeaseWriteOptions,
): StoryOwnerLease | null {
  const existing = readOwnerLease(storyDir);
  if (existing === null) return null;
  const nowFn = options.now ?? (() => new Date().toISOString());
  const refreshed: StoryOwnerLease = {
    ...existing,
    // sessionSource is preserved from `existing`; backfill it from the current
    // session identity when refreshing a pre-amendment lease that lacked it
    // (the refreshing session is, by definition, the same owner).
    sessionSource: existing.sessionSource ?? getSessionIdentity().sessionSource,
    hostname: hostname(),
    pid: process.pid,
    cwd: nonEmptyString(options.cwd) ?? process.cwd(),
    heartbeatAt: nowFn(),
  };
  // Preserve the optional label unless the caller supplies a new non-empty one.
  const label = nonEmptyString(options.label);
  if (label !== null) refreshed.label = label;
  writeLease(storyDir, refreshed);
  return refreshed;
}

/**
 * Acquire-or-refresh the owner lease in one call — the choke-point helper the
 * CLI uses for every story-scoped mutating command.
 *
 * Behavior:
 *  - No lease on disk            → `acquireOwnerLease` (this session becomes
 *    the owner). Returns `{ lease, action: 'acquired' }`.
 *  - Lease owned by THIS session → `refreshOwnerLease` (advance heartbeat).
 *    Returns `{ lease, action: 'refreshed' }`.
 *  - Lease owned by ANOTHER session → NO write; returns the foreign lease with
 *    `action: 'foreign'`. CHK-001 does not reject here — the CHK-002 gate
 *    decides whether to block. Keeping this a pure observation means the lease
 *    primitive itself stays side-effect-free for non-owners (a non-owner must
 *    never silently steal or refresh someone else's lease).
 */
function acquireOrRefreshOwnerLeaseUnlocked(
  storyDir: string,
  options: OwnerLeaseWriteOptions,
): { lease: StoryOwnerLease; action: 'acquired' | 'refreshed' | 'foreign' } {
  warnIfDerivedPpidSessionIdentity();
  const existing = readOwnerLease(storyDir);
  if (existing === null) {
    return { lease: acquireOwnerLease(storyDir, options), action: 'acquired' };
  }
  if (existing.sessionId === getSessionId()) {
    const refreshed = refreshOwnerLease(storyDir, options);
    // `refreshed` is non-null here: `existing` was just read successfully.
    return { lease: refreshed ?? existing, action: 'refreshed' };
  }
  return { lease: existing, action: 'foreign' };
}

/**
 * Release (delete) the owner lease for a story.
 *
 * Called when a story reaches a terminal state (DONE / DISCARDED) and its
 * cleanup succeeds: the lease is process metadata with no further purpose, so
 * the file is removed. Idempotent — removing an absent lease is a no-op.
 *
 * Returns `true` when a lease file was actually removed, `false` when there was
 * nothing to remove.
 */
function releaseOwnerLeaseUnlocked(storyDir: string): boolean {
  const path = ownerLeasePath(storyDir);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/**
 * Whether the CURRENT session owns the lease for `storyDir`.
 *
 * `true` only when a valid lease exists AND its `sessionId` equals this
 * process's `getSessionId()`. No lease, a corrupt lease, or a foreign lease all
 * yield `false`. This is an observation helper for `session_brief` rendering
 * and the CHK-002 gate — it performs no writes.
 */
export function isOwnedByCurrentSession(storyDir: string): boolean {
  const lease = readOwnerLease(storyDir);
  return lease !== null && lease.sessionId === getSessionId();
}

/* ─────────────────────────────────────────────────────────────────────────
 * B-c55d CHK-003: stale lease detection + takeover.
 *
 * In the ppid-fallback derivation path a dead parent shell's pid can be reused
 * by an unrelated later shell — two genuine sessions then collide on one
 * derived id, or a session simply dies and leaves an orphan lease nobody can
 * recognise as their own. CHK-003 recovers from that: a lease whose
 * `heartbeatAt` has not advanced for STALE_LEASE_THRESHOLD_MS is judged STALE
 * and may be taken over.
 *
 * Two takeover paths, both DANGEROUS (explicit-intent + audit-event discipline):
 *  - `--takeover` transfers a STALE foreign lease to the current session.
 *  - `--forceTakeover` transfers an ACTIVE (non-stale) foreign lease — treated
 *    as a deliberate human override (the operator KNOWS they are seizing a live
 *    session's lock).
 * Neither path ever transfers a lease silently: every takeover writes a
 * `story-owner-lease-takeover` record to the project activity log.
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Staleness threshold for an owner lease, in milliseconds (30 minutes).
 *
 * A lease whose `heartbeatAt` is older than this is considered stale and is
 * eligible for plain `--takeover`. Kept as an exported constant so the gate,
 * doctor checks, and tests all reference the SAME literal — per "Handler Coding
 * Conventions" the 30-minute rule is re-checked at every consumer, never re-typed.
 */
export const STALE_LEASE_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Whether `lease` is stale: its `heartbeatAt` has not advanced for at least
 * `STALE_LEASE_THRESHOLD_MS` (30 minutes).
 *
 * Pure and unit-testable — `now` is injectable (defaults to `Date.now()`).
 *
 * Runtime re-validation (per "Handler Coding Conventions"): a lease whose `heartbeatAt`
 * is not a parseable ISO 8601 timestamp has NO trustworthy age, so it is
 * conservatively treated as stale (`true`) — an unparseable heartbeat must
 * never masquerade as a fresh, protected lease. A `null` lease is NOT stale
 * (there is nothing to take over): callers acquire a fresh lease instead.
 */
export function isLeaseStale(lease: StoryOwnerLease | null, now: number = Date.now()): boolean {
  if (lease === null) return false;
  const heartbeatMs = Date.parse(lease.heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) return true;
  const reference = Number.isFinite(now) ? now : Date.now();
  return reference - heartbeatMs >= STALE_LEASE_THRESHOLD_MS;
}

/** Which takeover flag authorized a lease transfer. */
export type TakeoverKind = 'takeover' | 'forceTakeover';

/** Why a `takeOverOwnerLease` call refused to transfer the lease. */
export type TakeoverRefusalReason =
  /** No lease on disk — there is nothing to take over (caller should acquire). */
  | 'no-lease'
  /** The current session already owns the lease — takeover is unnecessary. */
  | 'already-owned'
  /** `--takeover` was used on an ACTIVE (non-stale) lease; needs `--forceTakeover`. */
  | 'lease-active';

/** Outcome of a `takeOverOwnerLease` attempt. */
export type TakeoverResult =
  /** The lease was transferred to the current session; `event` was logged. */
  | { transferred: true; lease: StoryOwnerLease; previous: StoryOwnerLease; kind: TakeoverKind }
  /** No transfer happened; `reason` explains why. `previous` is the foreign lease if any. */
  | { transferred: false; reason: TakeoverRefusalReason; previous: StoryOwnerLease | null };

/** Options for `takeOverOwnerLease`. */
export interface TakeoverOptions extends OwnerLeaseWriteOptions {
  /**
   * `takeover` → only a STALE foreign lease may be transferred.
   * `forceTakeover` → an ACTIVE foreign lease may also be transferred (human override).
   */
  kind: TakeoverKind;
  /**
   * Project root used to locate the activity log the takeover event is
   * appended to (`<projectRoot>/.proof-or-stop/activity.jsonl`). When omitted, the
   * takeover still transfers the lease but skips the audit record — callers
   * that need the event MUST supply this.
   */
  projectRoot?: string;
}

/** The shape of the audit record a takeover appends to the activity log. */
export interface TakeoverEvent {
  /** Discriminator for activity-log readers. */
  tool: 'story-owner-lease-takeover';
  /** Same value as `tool` — `activity-log` consumers key on `detail` too. */
  detail: 'story-owner-lease-takeover';
  /** ISO 8601 time the takeover happened. */
  timestamp: string;
  /** Which flag authorized the transfer. */
  kind: TakeoverKind;
  /** Story directory whose lease was transferred. */
  storyDir: string;
  /** Session id that NOW owns the lease (the taker). */
  toSessionId: string;
  /** Session id the lease was taken FROM. */
  fromSessionId: string;
  /** The taken-over lease's last `heartbeatAt` before transfer (audit context). */
  fromHeartbeatAt: string;
  /** Whether the taken-over lease was stale at transfer time. */
  fromWasStale: boolean;
  /** The proof-or-stop command that triggered the takeover. */
  command: string;
}

/**
 * Take over a foreign owner lease, transferring it to the CURRENT session.
 *
 * Behavior by `kind` (the authorizing flag):
 *  - no lease on disk            → refuse `{ transferred:false, reason:'no-lease' }`
 *    (takeover never CREATES a lease — the caller should acquire instead).
 *  - lease owned by this session → refuse `{ reason:'already-owned' }` (no-op).
 *  - foreign lease, STALE        → transferred for BOTH `takeover` and
 *    `forceTakeover`.
 *  - foreign lease, ACTIVE       → transferred ONLY for `forceTakeover`;
 *    `takeover` refuses `{ reason:'lease-active' }` (the gate then tells the
 *    operator to rerun with `--forceTakeover`).
 *
 * A successful transfer rewrites `owner-lease.json` naming the current session
 * (fresh `acquiredAt`/`heartbeatAt`) and — when `projectRoot` is supplied —
 * appends a `story-owner-lease-takeover` record to the activity log so the
 * transfer is never silent: who took it from whom, when, the previous
 * `heartbeatAt`, and whether it was stale.
 *
 * Runtime re-validation (per "Handler Coding Conventions"): `kind` is re-checked against
 * the `{takeover, forceTakeover}` enum here, not trusted from an upstream
 * schema; an invalid `kind` throws.
 */
/* ─────────────────────────────────────────────────────────────────────────
 * B-c55d CHK-004: ownership-aware error UX.
 *
 * The CHK-002/003 gate (`enforceStoryOwnerLeaseGate` in `cli-engine.ts`) is the
 * sole rejection point for a non-owner story-scoped / dangerous mutation. The
 * MESSAGE it produces is the operator's only window into "why am I blocked and
 * what do I do next". `session-ownership-and-write-leases.md` § Error UX
 * mandates four facts in every non-owner rejection:
 *   - which story is owned
 *   - the owner `sessionId`, `cwd`, and last-heartbeat age
 *   - whether the lease is stale
 *   - the allowed next action
 *
 * `formatNonOwnerError` is the single pure formatter for that message. Keeping
 * it here (not inline in the gate) means: (1) the gate stays a thin choke-point;
 * (2) the smoke can assert the exact field set without spawning the CLI; (3)
 * the stale-vs-active recovery text is computed in ONE place from `isLeaseStale`
 * so the gate can never drift from the message.
 * ───────────────────────────────────────────────────────────────────────── */

/** Inputs `formatNonOwnerError` needs beyond the foreign lease itself. */
export interface NonOwnerErrorContext {
  /** The story whose lease is owned by another session. */
  storyId: string;
  /** The proof-or-stop command that was rejected (audit / message context). */
  command: string;
  /** The owner-gated ownership class of `command` (`storyScopedMutating` / `dangerousMutating`). */
  ownershipClass: string;
  /** The CURRENT (rejected) session's id — so the operator sees both sides. */
  currentSessionId: string;
  /**
   * The CURRENT working directory. When it equals the owner cwd but the session
   * id differs, the operator is likely switching context in the same worktree.
   * This only changes guidance text; it never transfers the lease.
   */
  currentCwd?: string;
  /**
   * Clock injection for deterministic tests. Defaults to `Date.now()`.
   * Used only to compute the heartbeat age and the stale verdict.
   */
  now?: number;
}

/**
 * Format an age in ms as a compact human string (`30s`, `8m`, `2h`).
 *
 * Exported so the CLI gate and `session_brief` render heartbeat ages with the
 * IDENTICAL format instead of each re-implementing it (the message and the
 * brief must agree on "8m ago").
 */
export function formatLeaseAge(ageMs: number): string {
  const safe = Number.isFinite(ageMs) && ageMs >= 0 ? ageMs : 0;
  const seconds = Math.floor(safe / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

/**
 * Build the complete non-owner mutation rejection message.
 *
 * Pure and unit-testable: every input (the foreign `lease`, the story / command
 * / class / current session, the clock) is supplied explicitly. The returned
 * string ALWAYS contains the four `session-ownership-and-write-leases.md`
 * § Error UX facts:
 *   1. the owned story id;
 *   2. the owner `sessionId` + `cwd` + last-heartbeat age (`<n>m ago`);
 *   3. whether the lease is stale;
 *   4. the allowed next action — stale leases point at `--takeover`, active
 *      leases point at read-only / wait / `--forceTakeover`.
 *
 * The wording follows the doc example and the CHK-004 userSees target so an
 * operator (or the smoke) sees a clear, non-mysterious recovery path.
 */
export function formatNonOwnerError(
  lease: StoryOwnerLease,
  ctx: NonOwnerErrorContext,
): string {
  const nowMs = Number.isFinite(ctx.now) ? (ctx.now as number) : Date.now();
  const heartbeatMs = Date.parse(lease.heartbeatAt);
  const ageStr = Number.isFinite(heartbeatMs)
    ? `${formatLeaseAge(nowMs - heartbeatMs)} ago`
    : 'unknown';
  const stale = isLeaseStale(lease, nowMs);
  const staleStr = stale
    ? 'The owner lease is STALE (no heartbeat for 30+ minutes).'
    : 'The owner lease is still ACTIVE.';
  const sameWorktreeGuidance = ownerCwdMatchesCurrent(lease.cwd, ctx.currentCwd)
    ? ` Owner cwd matches the current cwd (${normalizedCwdForCompare(lease.cwd)}), so this may be a same-worktree context switch. Run proof-or-stop session_brief and confirm no live conflicting session; the lease is not transferred unless you rerun with an explicit takeover flag.`
    : '';
  const nextAction = stale
    ? `Use read-only commands, wait for the owner, or rerun with --takeover to transfer the stale lease.`
    : `Use read-only commands, wait for the owner, or rerun with --forceTakeover to seize the active lease (a deliberate human override).`;
  return (
    `${ctx.storyId} is owned by Proof-or-Stop session ${lease.sessionId}, heartbeat ${ageStr} ` +
    `(owner cwd: ${lease.cwd}). "${ctx.command}" is an owner-gated ${ctx.ownershipClass} command, ` +
    `so this session (${ctx.currentSessionId}) cannot run it. ${staleStr}${sameWorktreeGuidance} ${nextAction}`
  );
}

/**
 * The recommended next action for a session inspecting a story's owner lease.
 *
 *  - `proceed`            → the current session owns the lease (or there is no
 *    lease — it will acquire one on the next mutating command).
 *  - `read-only`          → a foreign ACTIVE lease holds the story; this session
 *    may only run read-only commands or wait.
 *  - `takeover-available` → a foreign STALE lease holds the story; this session
 *    may rerun a mutating command with `--takeover`.
 */
export type OwnershipRecommendation = 'proceed' | 'read-only' | 'takeover-available';

/**
 * Structured ownership view for `session_brief` rendering — the testable core of
 * the ownership section.
 *
 * Pure: `lease` and the current `sessionId` / clock are supplied explicitly so
 * the smoke can assert every rendered field without touching real process state.
 * Surfaces exactly the `session-ownership-and-write-leases.md` § session_brief
 * Requirements fields: owner session (+ source), owner cwd, last-heartbeat age,
 * stale/active status, whether the current session is owner, recommended action.
 */
export interface OwnerLeaseView {
  /** `true` when a valid lease exists on disk. */
  hasLease: boolean;
  /** Owner `sessionId`, or `null` when there is no lease. */
  ownerSessionId: string | null;
  /** How the owner session was identified, or `null` (absent on legacy leases). */
  ownerSessionSource: SessionSource | null;
  /** Owner `cwd`, or `null` when there is no lease. */
  ownerCwd: string | null;
  /** Compact last-heartbeat age (`8m ago`), or `null` when there is no lease. */
  heartbeatAge: string | null;
  /** `true` when the lease is stale, `false` when active; `false` when no lease. */
  stale: boolean;
  /** `true` when the inspecting session owns the lease. */
  isCurrentSessionOwner: boolean;
  /** The recommended next action for the inspecting session. */
  recommendation: OwnershipRecommendation;
  /** True when a non-owner is inspecting from the same cwd recorded by owner. */
  ownerCwdMatchesCurrent?: boolean;
  /** Inspecting cwd used for same-worktree guidance, when known. */
  currentCwd?: string | null;
  /**
   * The inspecting session's own id — carried so renderers stay pure (they can
   * show "this session (<id>)" without re-reading process state).
   */
  currentSessionId: string;
}

/**
 * Build the `OwnerLeaseView` for a story directory — used by `session_brief`.
 *
 * `currentSessionId` is the inspecting session; `now` is injectable for tests.
 * No lease → `{ hasLease:false, recommendation:'proceed' }` (the next mutating
 * command will acquire one). A foreign STALE lease → `takeover-available`; a
 * foreign ACTIVE lease → `read-only`; an owned lease → `proceed`.
 */
export function summarizeOwnerLease(
  storyDir: string,
  currentSessionId: string,
  now: number = Date.now(),
  currentCwd: string = process.cwd(),
): OwnerLeaseView {
  const normalizedCurrentCwd = normalizedCwdForCompare(currentCwd);
  const lease = readOwnerLease(storyDir);
  if (lease === null) {
    return {
      hasLease: false,
      ownerSessionId: null,
      ownerSessionSource: null,
      ownerCwd: null,
      heartbeatAge: null,
      stale: false,
      isCurrentSessionOwner: false,
      recommendation: 'proceed',
      ownerCwdMatchesCurrent: false,
      currentCwd: normalizedCurrentCwd,
      currentSessionId,
    };
  }
  const isOwner = lease.sessionId === currentSessionId;
  const stale = isLeaseStale(lease, now);
  const heartbeatMs = Date.parse(lease.heartbeatAt);
  const heartbeatAge = Number.isFinite(heartbeatMs)
    ? `${formatLeaseAge(now - heartbeatMs)} ago`
    : 'unknown';
  // Owner → proceed. Foreign stale → takeover available. Foreign active → read-only.
  const recommendation: OwnershipRecommendation = isOwner
    ? 'proceed'
    : stale
      ? 'takeover-available'
      : 'read-only';
  const sameWorktree = !isOwner && ownerCwdMatchesCurrent(lease.cwd, currentCwd);
  return {
    hasLease: true,
    ownerSessionId: lease.sessionId,
    ownerSessionSource: lease.sessionSource ?? null,
    ownerCwd: lease.cwd,
    heartbeatAge,
    stale,
    isCurrentSessionOwner: isOwner,
    recommendation,
    ownerCwdMatchesCurrent: sameWorktree,
    currentCwd: normalizedCurrentCwd,
    currentSessionId,
  };
}

/* ───────────────────────────────────────────────────────────────────────── */

function takeOverOwnerLeaseUnlocked(
  storyDir: string,
  options: TakeoverOptions,
): TakeoverResult {
  // Runtime enum re-validation — never trust an upstream schema for `kind`.
  if (options.kind !== 'takeover' && options.kind !== 'forceTakeover') {
    throw new Error(
      `takeOverOwnerLease: kind must be "takeover" or "forceTakeover", got "${String(options.kind)}"`,
    );
  }
  const command = nonEmptyString(options.command);
  if (command === null) {
    throw new Error('takeOverOwnerLease: command is required');
  }

  const existing = readOwnerLease(storyDir);
  // No lease (or corrupt → null): nothing to take over; the caller acquires.
  if (existing === null) {
    return { transferred: false, reason: 'no-lease', previous: null };
  }
  // Already ours: takeover is a no-op — refresh, do not "take over".
  if (existing.sessionId === getSessionId()) {
    return { transferred: false, reason: 'already-owned', previous: existing };
  }

  const nowFn = options.now ?? (() => new Date().toISOString());
  const stamp = nowFn();
  const wasStale = isLeaseStale(existing, Date.parse(stamp));

  // Plain `--takeover` may only transfer a STALE lease. An ACTIVE foreign lease
  // needs the explicit `--forceTakeover` human override.
  if (options.kind === 'takeover' && !wasStale) {
    return { transferred: false, reason: 'lease-active', previous: existing };
  }

  // Transfer: rewrite the lease naming the current session.
  const identity = getSessionIdentity();
  const transferred: StoryOwnerLease = {
    leaseId: randomUUID(),
    sessionId: identity.sessionId,
    sessionSource: identity.sessionSource,
    hostname: hostname(),
    pid: process.pid,
    cwd: nonEmptyString(options.cwd) ?? process.cwd(),
    command,
    acquiredAt: stamp,
    heartbeatAt: stamp,
  };
  const label = nonEmptyString(options.label);
  if (label !== null) transferred.label = label;
  writeLease(storyDir, transferred);

  // Audit: append the takeover event so a transfer is NEVER silent.
  const projectRoot = nonEmptyString(options.projectRoot);
  if (projectRoot !== null) {
    const event: TakeoverEvent = {
      tool: 'story-owner-lease-takeover',
      detail: 'story-owner-lease-takeover',
      timestamp: stamp,
      kind: options.kind,
      storyDir,
      toSessionId: identity.sessionId,
      fromSessionId: existing.sessionId,
      fromHeartbeatAt: existing.heartbeatAt,
      fromWasStale: wasStale,
      command,
    };
    try {
      appendActivityLog(projectRoot, event as unknown as Record<string, unknown>);
    } catch {
      // A failed audit append must not strand the (already-written) lease in an
      // inconsistent half-transferred state. The transfer itself succeeded; the
      // missing audit line is reported by callers, not re-thrown here.
    }
  }

  // B-bbaf CHK-002: bump the per-story takeover counter so the convergence
  // breaker can read takeover frequency with an O(1) per-story read instead of
  // scanning the shared activity log on the story_advance hot path. This runs at
  // the ONE serialized takeover write site (a transfer just succeeded above), and
  // is best-effort: a failed counter bump only DELAYS a takeover-storm trip
  // because advance-count still catches the same runaway loop. The single
  // legitimate forceTakeover is counted, never blocked here.
  bumpTakeoverCount(storyDir);

  return {
    transferred: true,
    lease: transferred,
    previous: existing,
    kind: options.kind,
  };
}


const activeOwnerMutationLocks = new Set<string>();
function withOwnerMutation<T>(storyDir: string, fn: () => T): T {
  const path = resolve(ownerLeasePath(storyDir));
  const directory = dirname(path);
  const canonical = existsSync(directory) ? realpathSync(directory) : directory;
  const key = createHash('sha256').update(canonical).digest('hex').slice(0, 24);
  const lockPath = storyRuntimeLockPath(dirname(directory), 'owner-lease', basename(directory), key);
  if (activeOwnerMutationLocks.has(lockPath)) return fn();
  return withMkdirLock(lockPath, () => {
    activeOwnerMutationLocks.add(lockPath);
    try { return fn(); } finally { activeOwnerMutationLocks.delete(lockPath); }
  }, { label: 'story owner lease', deadlineMs: 15000, staleMs: 10000 });
}

export function acquireOwnerLease(storyDir: string, options: OwnerLeaseWriteOptions): StoryOwnerLease {
  return withOwnerMutation(storyDir, () => acquireOwnerLeaseUnlocked(storyDir, options));
}
export function refreshOwnerLease(storyDir: string, options: OwnerLeaseWriteOptions): StoryOwnerLease | null {
  return withOwnerMutation(storyDir, () => refreshOwnerLeaseUnlocked(storyDir, options));
}
export function acquireOrRefreshOwnerLease(storyDir: string, options: OwnerLeaseWriteOptions): { lease: StoryOwnerLease; action: 'acquired' | 'refreshed' | 'foreign' } {
  return withOwnerMutation(storyDir, () => acquireOrRefreshOwnerLeaseUnlocked(storyDir, options));
}
export function releaseOwnerLease(storyDir: string): boolean {
  return withOwnerMutation(storyDir, () => releaseOwnerLeaseUnlocked(storyDir));
}
export function takeOverOwnerLease(storyDir: string, options: TakeoverOptions): TakeoverResult {
  return withOwnerMutation(storyDir, () => takeOverOwnerLeaseUnlocked(storyDir, options));
}

export interface OwnerLeaseHeartbeatOptions {
  intervalMs?: number;
  now?: () => string;
}

/** Renew an existing generation only. Missing, expired, or transferred leases
 * abort renewal; a heartbeat never acquires or takes over ownership. The signal
 * lets a queued caller stop waiting when renewal fails; callers that already
 * execute work still retain their own launch/publication fencing. */
export async function withOwnerLeaseHeartbeat<T>(
  storyDir: string, options: OwnerLeaseWriteOptions & OwnerLeaseHeartbeatOptions,
  fn: (leaseLostSignal: AbortSignal) => Promise<T> | T,
): Promise<T> {
  const now = options.now ?? (() => new Date().toISOString());
  const initial = readOwnerLease(storyDir);
  const beat = () => withOwnerMutation(storyDir, () => {
    const current = readOwnerLease(storyDir);
    if (!initial || !current || current.sessionId !== getSessionId()
      || current.sessionId !== initial.sessionId || current.acquiredAt !== initial.acquiredAt
      || current.leaseId !== initial.leaseId || !ownerCwdMatchesCurrent(current.cwd, options.cwd ?? process.cwd())
      || isLeaseStale(current, Date.parse(now()))) {
      throw new Error('validation owner lease lost, expired, or transferred');
    }
    refreshOwnerLeaseUnlocked(storyDir, options);
  });
  beat();
  const leaseLost = new AbortController();
  let failure: unknown;
  const interval = options.intervalMs ?? VALIDATION_EXECUTION_RUNTIME_REQUIREMENTS.ownerLeaseHeartbeatMs;
  if (!Number.isFinite(interval) || interval < 1 || interval >= STALE_LEASE_THRESHOLD_MS / 2) {
    throw new Error('invalid owner lease heartbeat interval');
  }
  const timer = setInterval(() => {
    if (failure) return;
    try { beat(); } catch (error) { failure = error; leaseLost.abort(error); }
  }, interval);
  timer.unref?.();
  try {
    const result = await fn(leaseLost.signal);
    if (failure) throw failure;
    beat();
    return result;
  } finally { clearInterval(timer); }
}
