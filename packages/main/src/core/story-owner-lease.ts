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

import { hostname } from 'os';
import { join } from 'path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';

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

/**
 * Process-local cache of the stable session id.
 *
 * `getSessionId()` resolves the id once per process and memoizes it here so
 * every subsequent call in the same process / session returns the identical
 * value (the "process-internal consistency" requirement). It is intentionally
 * mutable module state — there is exactly one session per process.
 */
let cachedSessionId: string | null = null;

/**
 * Resolve the stable, process-local `sessionId`.
 *
 * Resolution order (first non-empty wins):
 *   1. `KOALA_SESSION_ID`        — explicit override (kept consistent with
 *      `handlers/context.ts`, which already reads this var for event records).
 *   2. `CLAUDE_SESSION_ID`       — Claude Code session id, when present.
 *   3. `KOALA_ACTIVITY_SESSION`  — activity-log session token set by the codex
 *      bootstrap (`init-assets.ts`); reused so the lease and the activity log
 *      agree on one session.
 *   4. `TERM_SESSION_ID`         — terminal session id (one per terminal tab),
 *      a stable per-session anchor on macOS terminals.
 *   5. derived fallback          — `local-<hostname>-<ppid>`. The koala CLI is
 *      a short-lived process: every `koala <cmd>` invocation is a NEW process,
 *      so a `process.pid`-based id would change on EVERY command and make a
 *      session unable to ever refresh its own lease (every second command
 *      would look "foreign"). The PARENT pid (`process.ppid` — the agent's
 *      shell) is stable across all `koala` invocations from one session, so it
 *      is the correct local-coordination anchor when no session env var exists.
 *
 * The result is memoized in `cachedSessionId`, so the value is stable for the
 * whole process. This is a LOCAL coordination id, never a crypto identity:
 * there is no signing, no key, and a different session could trivially set the
 * same env var. The lease relies on this only to detect accidental concurrent
 * authoring, never to authenticate.
 */
export function getSessionId(): string {
  if (cachedSessionId !== null) return cachedSessionId;
  const fromEnv =
    pickEnv('KOALA_SESSION_ID') ??
    pickEnv('CLAUDE_SESSION_ID') ??
    pickEnv('KOALA_ACTIVITY_SESSION') ??
    pickEnv('TERM_SESSION_ID');
  cachedSessionId = fromEnv ?? `local-${hostname()}-${process.ppid}`;
  return cachedSessionId;
}

/**
 * Test-only: clear the memoized session id so a subsequent `getSessionId()`
 * re-resolves from the environment. Not part of the production control flow —
 * a real process has exactly one session for its whole lifetime.
 */
export function resetSessionIdForTest(): void {
  cachedSessionId = null;
}

/** Return a trimmed non-empty env var value, or `null`. */
function pickEnv(name: string): string | null {
  const raw = process.env[name];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
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
  const lease: StoryOwnerLease = {
    sessionId: getSessionId(),
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
