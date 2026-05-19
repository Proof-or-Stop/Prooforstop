/**
 * B-c55d CHK-001: story owner lease core (local session ownership).
 *
 * session-ownership-and-write-leases.md rollout step 2b — "story owner lease".
 * Implements local Koala session ownership coordination so that, when multiple
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
 * It lives under the git-tracked `.koala/story/actives/<id>/` subtree, so an
 * un-ignored lease file would show up as an uncommitted change and could block
 * the DONE `git merge story/<id>` (the same failure mode as B-f60c F-008). The
 * file is therefore registered in `core/runtime-artifact-registry.ts` (entry
 * `runtime-story-owner-lease`) and `.gitignore` carries a matching
 * glob-star owner-lease.json pattern, so it is NEVER tracked and NEVER
 * produces a dirty write before DONE.
 */

import { createHash } from 'crypto';
import { hostname } from 'os';
import { join } from 'path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { gitProbe } from './git-probe.js';
import { appendActivityLog } from './activity-log.js';

/**
 * Filename of the per-story owner lease, written under the story directory
 * (`.koala/story/actives/<storyId>/owner-lease.json`).
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
  /**
   * Process-local session coordination id of the owning session.
   *
   * NOT a cryptographic identity — see the file header. Stable within a single
   * process: every read inside one process/session returns the same value.
   */
  sessionId: string;
  /**
   * How `sessionId` was identified — `koala-env` / `claude-code-env` /
   * `derived-ppid`. Surfaced by `session_brief` and debugging so an operator
   * can see whether the session came from an explicit override, the Claude
   * Code adapter env, or the ppid-fallback derivation.
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
  /** The koala command that first acquired the lease (audit context). */
  command: string;
  /** ISO 8601 timestamp of the initial acquire. */
  acquiredAt: string;
  /** ISO 8601 timestamp of the most recent owner mutating command. */
  heartbeatAt: string;
  /** Optional human-readable label (e.g. agent role); no gate semantics. */
  label?: string;
}

/*
 * sessionId derivation — implementation note (B-c55d CHK-001, user-ruled,
 * supersedes the earlier ppid-anchor design).
 *
 *   sessionId =
 *     KOALA_SESSION_ID                                       (sessionSource: koala-env)
 *     ?? CLAUDE_CODE_SESSION_ID                              (sessionSource: claude-code-env)
 *     ?? deriveLocalSessionId(hostname, root, process.ppid)  (sessionSource: derived-ppid)
 *
 * WHY ppid is NOT the primary anchor. An earlier revision anchored the derived
 * id on `process.ppid` (the parent shell), on the assumption the shell is
 * stable across `koala` invocations. That assumption is FALSE in the Claude
 * Code environment: each Bash tool call spawns a FRESH shell, so `process.ppid`
 * changes on every `koala` command (empirically observed 89439 -> 89466 ->
 * 89513 -> 89529 across 4 consecutive calls). A ppid-anchored id therefore
 * changes every command, so an agent's 2nd mutating command self-rejects its
 * own lease as "foreign" — the lease bricks the session. ppid is consequently
 * demoted to the LAST-RESORT fallback only, for plain terminals / CI /
 * non-Claude environments where the parent shell genuinely IS persistent.
 *
 * PRIMARY sources are env vars that are stable per real session:
 *   1. `KOALA_SESSION_ID` — canonical Koala override; the future Koala
 *      adapter / server injection entry point. Highest priority.
 *   2. `CLAUDE_CODE_SESSION_ID` — already present in the Claude Code
 *      environment and verified stable for the lifetime of a Claude Code
 *      session. Used verbatim.
 *
 * Claude Code env is a KNOWN ADAPTER ENVIRONMENT — it is NOT a Koala strong
 * identity and provides NO anti-spoofing. This is LOCAL session coordination
 * only (hard boundary 1): no keys, no signatures, no server authority. A
 * session could trivially set either env var to any value; the lease relies on
 * these only to detect accidental concurrent authoring, never to authenticate.
 *
 * ROOT in the fallback derivation = the worktree / project root, so two story
 * worktrees driven from the SAME parent shell still derive DISTINCT ids.
 *
 * DEGRADATION: in the ppid-fallback path a dead parent shell's pid can be
 * reused by an unrelated later shell — two genuine sessions could then collide
 * on one derived id. Acceptable: the collision window is covered by stale-lease
 * detection + takeover (CHK-003) — a heartbeat that stops advancing is detected
 * as stale and can be taken over.
 */

/** How `getSessionId()` identified the current session (recorded in the lease). */
export type SessionSource = 'koala-env' | 'claude-code-env' | 'derived-ppid';

/** Resolved session identity: the id plus how it was determined. */
export interface SessionIdentity {
  /** Process-local session coordination id. */
  sessionId: string;
  /** Which of the 3 prioritized sources produced `sessionId`. */
  sessionSource: SessionSource;
}

/** The subset of environment variables `resolveSessionIdentity` consults. */
export interface SessionEnv {
  KOALA_SESSION_ID?: string | undefined;
  CLAUDE_CODE_SESSION_ID?: string | undefined;
}

/** Synthetic process inputs for the fallback derivation (host / root / ppid). */
export interface SessionDerivationInputs {
  hostname: string;
  root: string;
  ppid: number;
}

/**
 * Derive a stable local-coordination session id from synthetic inputs.
 *
 * Pure and unit-testable: it takes `(host, root, ppid)` explicitly instead of
 * reading `process.ppid` internally, so tests can feed synthetic inputs to
 * exercise stability (same inputs → same id) and uniqueness (different parent
 * shell / different worktree root → different id) without spawning real
 * shells.
 *
 * The id is `sess-<sha256(host root ppid)[:16]>` — a short hash, NOT a
 * cryptographic identity. The hash only makes the id compact and free of path
 * separators; it provides no authentication.
 */
export function deriveLocalSessionId(host: string, root: string, ppid: number): string {
  const material = `${host} ${root} ${ppid}`;
  const digest = createHash('sha256').update(material).digest('hex');
  return `sess-${digest.slice(0, 16)}`;
}

/**
 * Pure session-identity resolver — the testable core of getSessionId().
 *
 * Applies the 3-source priority chain over a supplied `env` snapshot and
 * synthetic derivation `inputs`, so tests can feed any combination without
 * touching real process.env / process.ppid. Empty / whitespace-only env values
 * are treated as absent and fall through to the next source.
 */
export function resolveSessionIdentity(
  env: SessionEnv,
  inputs: SessionDerivationInputs,
): SessionIdentity {
  const koala = trimToNull(env.KOALA_SESSION_ID);
  if (koala !== null) return { sessionId: koala, sessionSource: 'koala-env' };

  const claude = trimToNull(env.CLAUDE_CODE_SESSION_ID);
  if (claude !== null) return { sessionId: claude, sessionSource: 'claude-code-env' };

  return {
    sessionId: deriveLocalSessionId(inputs.hostname, inputs.root, inputs.ppid),
    sessionSource: 'derived-ppid',
  };
}

/** Trim a possibly-undefined string; empty / whitespace-only becomes null. */
function trimToNull(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the worktree / project root used as the derivation anchor.
 *
 * Uses the git worktree top-level of the current working directory so each
 * story worktree resolves to its own root. When the cwd is not inside a git
 * repository the cwd itself is the anchor — still a stable per-process value.
 */
function resolveSessionRoot(): string {
  const probe = gitProbe('git rev-parse --show-toplevel');
  const top = probe.ok ? probe.output.trim() : '';
  return top.length > 0 ? top : process.cwd();
}

/**
 * Process-local cache of the resolved session identity (id + source).
 *
 * `getSessionIdentity()` resolves it once per process and memoizes it here, so
 * every later call returns the identical value (the process-internal
 * consistency requirement). Exactly one session exists per process.
 */
let cachedSessionIdentity: SessionIdentity | null = null;

/**
 * Resolve the stable, process-local session identity (id + source).
 *
 * Wraps the pure resolveSessionIdentity over real process.env, hostname(), the
 * resolved worktree root, and process.ppid. Memoized for the whole process.
 * This is a LOCAL coordination identity, never a crypto identity — see the
 * implementation note above.
 */
export function getSessionIdentity(): SessionIdentity {
  if (cachedSessionIdentity !== null) return cachedSessionIdentity;
  cachedSessionIdentity = resolveSessionIdentity(
    {
      KOALA_SESSION_ID: process.env.KOALA_SESSION_ID,
      CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    },
    { hostname: hostname(), root: resolveSessionRoot(), ppid: process.ppid },
  );
  return cachedSessionIdentity;
}

/**
 * Resolve the stable, process-local `sessionId`.
 *
 * Convenience accessor for getSessionIdentity().sessionId — the signature is
 * unchanged so existing consumers (cli-engine.ts) are unaffected.
 */
export function getSessionId(): string {
  return getSessionIdentity().sessionId;
}

/**
 * Test-only: clear the memoized session id so a subsequent `getSessionId()`
 * re-resolves from the environment. Not part of the production control flow —
 * a real process has exactly one session for its whole lifetime.
 */
export function resetSessionIdForTest(): void {
  cachedSessionIdentity = null;
}

/**
 * Resolve the absolute path of a story's `owner-lease.json`.
 *
 * `storyDir` MUST be the absolute story directory
 * (`.koala/story/actives/<storyId>`). Runtime re-validation rejects an empty
 * path rather than silently joining onto `''` — mirrors the "Handler 编码约定"
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
 * Runtime field-by-field re-validation (per "Handler 编码约定"): every required
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
  // sessionSource is optional (absent on pre-amendment leases). Only carry it
  // when it is one of the canonical values; an unknown / malformed value is
  // dropped rather than rejecting the whole lease.
  if (isSessionSource(v.sessionSource)) lease.sessionSource = v.sessionSource;
  const label = nonEmptyString(v.label);
  if (label !== null) lease.label = label;
  return lease;
}

/** Runtime type guard for the `SessionSource` enum. */
function isSessionSource(value: unknown): value is SessionSource {
  return (
    value === 'koala-env' ||
    value === 'claude-code-env' ||
    value === 'derived-ppid'
  );
}

/** Return a trimmed non-empty string, or `null`. */
function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Options shared by `acquireOwnerLease` / `refreshOwnerLease`. */
export interface OwnerLeaseWriteOptions {
  /** koala command label recorded in the lease (audit context). */
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
  writeFileSync(ownerLeasePath(dir), `${JSON.stringify(lease, null, 2)}\n`, 'utf-8');
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
export function acquireOwnerLease(
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
export function refreshOwnerLease(
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
export function acquireOrRefreshOwnerLease(
  storyDir: string,
  options: OwnerLeaseWriteOptions,
): { lease: StoryOwnerLease; action: 'acquired' | 'refreshed' | 'foreign' } {
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
export function releaseOwnerLease(storyDir: string): boolean {
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
 * doctor checks, and tests all reference the SAME literal — per "Handler 编码
 * 约定" the 30-minute rule is re-checked at every consumer, never re-typed.
 */
export const STALE_LEASE_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Whether `lease` is stale: its `heartbeatAt` has not advanced for at least
 * `STALE_LEASE_THRESHOLD_MS` (30 minutes).
 *
 * Pure and unit-testable — `now` is injectable (defaults to `Date.now()`).
 *
 * Runtime re-validation (per "Handler 编码约定"): a lease whose `heartbeatAt`
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
   * appended to (`<projectRoot>/.koala/activity.jsonl`). When omitted, the
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
  /** The koala command that triggered the takeover. */
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
 * Runtime re-validation (per "Handler 编码约定"): `kind` is re-checked against
 * the `{takeover, forceTakeover}` enum here, not trusted from an upstream
 * schema; an invalid `kind` throws.
 */
export function takeOverOwnerLease(
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

  return {
    transferred: true,
    lease: transferred,
    previous: existing,
    kind: options.kind,
  };
}
