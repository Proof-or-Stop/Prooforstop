#!/usr/bin/env node
/**
 * B-c55d CHK-001 / CHK-003 / CHK-004 / CHK-005: unit smoke for
 * core/story-owner-lease.ts (plus the CHK-004 session_brief ownership renderers
 * in handlers/session.ts, the CHK-005 doctor stale-lease scanner in
 * core/story-owner-lease-doctor.ts, and the CHK-005 multi-session regression
 * group exercised through the real `enforceStoryOwnerLeaseGate` choke-point).
 *
 * Covers the load-bearing semantics of the story owner lease primitive
 * (session-ownership-and-write-leases.md rollout step 2b — "story owner
 * lease"), the CHK-001 scope being the lease MECHANISM only (no gate):
 *
 *   1. sessionId — process-local, stable (memoized; same value every call) and
 *      resolved from the env override.
 *   2. acquire — `owner-lease.json` lands at the canonical path with every
 *      schema field populated; `acquiredAt === heartbeatAt` on first acquire.
 *   3. heartbeat refresh — a refresh advances ONLY `heartbeatAt`; `acquiredAt`,
 *      `sessionId`, and the original `command` are preserved.
 *   4. release — the lease file is removed; release is idempotent.
 *   5. acquire-or-refresh — no lease → acquired; same session → refreshed;
 *      foreign session → observed without a write (no silent steal).
 *   6. malformed lease → treated as "no valid lease" (`readOwnerLease` → null).
 *   7. F-008-class dirty-write prevention — the lease path is a registered
 *      runtime artifact (volatile + material-excluded + a glob-star
 *      owner-lease.json ignore pattern), so it never produces a tracked/dirty
 *      write before DONE.
 *
 * CHK-005 adds (cases 18-25):
 *   - the doctor stale-lease scanner (`scanStoryOwnerLeases` /
 *     `renderStoryOwnerLeaseScan`): a >30min lease is detected + reported, an
 *     active lease is never misflagged, an absent lease is never a false
 *     positive;
 *   - the multi-session regression group driven through the real
 *     `enforceStoryOwnerLeaseGate` choke-point — two sessions on the same story
 *     (2nd rejected), on different stories (both proceed), stale takeover (only
 *     with `--takeover` + event), active takeover (rejected unless
 *     `--forceTakeover`), `session_brief` guidance for a non-owner session, and
 *     the reviewer read-only + `reviewerWrite` exemption;
 *   - the F-008-class regression: `owner-lease.json` is verified gitignored in
 *     the live repo tree, so it never becomes an uncommitted dirty write.
 *
 * Clock injection (`now`) keeps timestamp ordering deterministic without
 * sleeping; the smoke runs in milliseconds.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OWNER_LEASE_FILE,
  STALE_LEASE_THRESHOLD_MS,
  acquireOrRefreshOwnerLease,
  acquireOwnerLease,
  deriveLocalSessionId,
  formatLeaseAge,
  formatNonOwnerError,
  getSessionId,
  getSessionIdentity,
  isLeaseStale,
  isOwnedByCurrentSession,
  ownerLeasePath,
  readOwnerLease,
  refreshOwnerLease,
  releaseOwnerLease,
  resetSessionIdForTest,
  resolveSessionIdentity,
  summarizeOwnerLease,
  takeOverOwnerLease,
} from '../core/story-owner-lease.js';
import { renderMetaAuditBlock, renderOwnershipBlock } from '../handlers/session.js';
import { readActivityLogTail } from '../core/activity-log.js';
import {
  findRuntimeArtifactEntry,
  isMaterialExcludedRuntimeArtifactPath,
  isVolatileRuntimeArtifactPath,
  listRuntimeArtifactIgnorePatterns,
} from '../core/runtime-artifact-registry.js';
import {
  renderStoryOwnerLeaseScan,
  scanStoryOwnerLeases,
} from '../core/story-owner-lease-doctor.js';
import { StoryStore } from '../core/store.js';
import {
  enforceStoryOwnerLeaseGate,
  resolveEffectiveOwnershipClass,
} from '../cli-engine.js';
import { execFileSync } from 'node:child_process';

const root = join(tmpdir(), `lattice-story-owner-lease-smoke-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });

try {
  // ── 1. sessionId — 3-source chain (LATTICE_SESSION_ID / CLAUDE_CODE / derive) ─
  {
    // Synthetic derivation inputs reused across the sub-tests.
    const inA = { hostname: 'host-1', root: '/repo/.worktrees/B-c55d', ppid: 4242 };

    // 1a. REGRESSION GUARD for the ppid-bricking bug — with CLAUDE_CODE_SESSION_ID
    // set, varying ppid (simulating multiple fresh Claude Code shells / Node
    // procs) MUST yield an IDENTICAL sessionId. ppid no longer anchors the id
    // when the Claude Code env var is present, so a 2nd mutating command can
    // recognise its own lease instead of self-rejecting as "foreign".
    const claudeEnv = { CLAUDE_CODE_SESSION_ID: 'claude-sess-AAA' };
    const r1 = resolveSessionIdentity(claudeEnv, { ...inA, ppid: 89439 });
    const r2 = resolveSessionIdentity(claudeEnv, { ...inA, ppid: 89466 });
    const r3 = resolveSessionIdentity(claudeEnv, { ...inA, ppid: 89529 });
    assert.equal(r1.sessionId, 'claude-sess-AAA', 'CLAUDE_CODE_SESSION_ID is used verbatim');
    assert.equal(r1.sessionId, r2.sessionId, 'ppid variation does NOT change sessionId when CLAUDE_CODE_SESSION_ID is set (ppid-bricking regression guard)');
    assert.equal(r1.sessionId, r3.sessionId, 'ppid variation does NOT change sessionId across a 3rd fresh shell either');
    assert.equal(r1.sessionSource, 'claude-code-env', 'sessionSource is claude-code-env when CLAUDE_CODE_SESSION_ID drives the id');
    assert.equal(r2.sessionSource, 'claude-code-env', 'sessionSource stays claude-code-env across ppid changes');

    // 1b. Two DIFFERENT CLAUDE_CODE_SESSION_ID values → two DIFFERENT sessionIds,
    // so two genuinely different Claude Code sessions never collide.
    const rClaudeA = resolveSessionIdentity({ CLAUDE_CODE_SESSION_ID: 'claude-sess-AAA' }, inA);
    const rClaudeB = resolveSessionIdentity({ CLAUDE_CODE_SESSION_ID: 'claude-sess-BBB' }, inA);
    assert.notEqual(rClaudeA.sessionId, rClaudeB.sessionId, 'different CLAUDE_CODE_SESSION_ID values → different sessionIds');

    // 1c. LATTICE_SESSION_ID WINS over CLAUDE_CODE_SESSION_ID — it is the
    // highest-priority canonical override; sessionSource = koala-env.
    const rBoth = resolveSessionIdentity(
      { LATTICE_SESSION_ID: 'koala-override-1', CLAUDE_CODE_SESSION_ID: 'claude-sess-AAA' },
      inA,
    );
    assert.equal(rBoth.sessionId, 'koala-override-1', 'LATTICE_SESSION_ID wins over CLAUDE_CODE_SESSION_ID');
    assert.equal(rBoth.sessionSource, 'koala-env', 'sessionSource is koala-env when LATTICE_SESSION_ID drives the id');
    // Empty / whitespace-only env values are treated as absent (fall through).
    const rEmptyKoala = resolveSessionIdentity(
      { LATTICE_SESSION_ID: '   ', CLAUDE_CODE_SESSION_ID: 'claude-sess-AAA' },
      inA,
    );
    assert.equal(rEmptyKoala.sessionSource, 'claude-code-env', 'a whitespace-only LATTICE_SESSION_ID is treated as absent');

    // 1d. BOTH env vars absent → deriveLocalSessionId(hostname, root, ppid) is
    // the fallback; sessionSource = derived-ppid. Keep the derive stability /
    // uniqueness assertions for this last-resort path.
    const rDerived = resolveSessionIdentity({}, inA);
    assert.equal(rDerived.sessionSource, 'derived-ppid', 'both env vars absent → sessionSource is derived-ppid');
    assert.equal(rDerived.sessionId, deriveLocalSessionId('host-1', '/repo/.worktrees/B-c55d', 4242), 'fallback sessionId is exactly deriveLocalSessionId(host, root, ppid)');
    // Stability: identical inputs → identical id (the cross-invocation property).
    assert.equal(
      deriveLocalSessionId('host-1', '/repo/.worktrees/B-c55d', 4242),
      deriveLocalSessionId('host-1', '/repo/.worktrees/B-c55d', 4242),
      'deriveLocalSessionId is stable: identical inputs → identical id',
    );
    // Uniqueness: a different parent shell / worktree root / host → different id.
    const idBase = deriveLocalSessionId('host-1', '/repo/.worktrees/B-c55d', 4242);
    assert.notEqual(idBase, deriveLocalSessionId('host-1', '/repo/.worktrees/B-c55d', 9999), 'a different ppid → a different derived id');
    assert.notEqual(idBase, deriveLocalSessionId('host-1', '/repo/.worktrees/B-other', 4242), 'a different worktree root → a different derived id');
    assert.notEqual(idBase, deriveLocalSessionId('host-2', '/repo/.worktrees/B-c55d', 4242), 'a different hostname → a different derived id');

    // 1e. The memoized public getter wraps the resolver and stays stable for the
    // process. Set LATTICE_SESSION_ID so sections 2+ have a deterministic owner.
    process.env.LATTICE_SESSION_ID = 'sess-alpha';
    delete process.env.CLAUDE_CODE_SESSION_ID;
    resetSessionIdForTest();
    assert.equal(getSessionId(), 'sess-alpha', 'getSessionId() wraps the resolver over real process.env');
    assert.equal(getSessionIdentity().sessionSource, 'koala-env', 'getSessionIdentity() reports the resolved source');
    process.env.LATTICE_SESSION_ID = 'changed-after';
    assert.equal(getSessionId(), 'sess-alpha', 'getSessionId() stays memoized for the process lifetime');
    process.env.LATTICE_SESSION_ID = 'sess-alpha';
    resetSessionIdForTest();
  }

  // ── 2. acquire — schema-complete lease at the canonical path ─────────────
  {
    const storyDir = join(root, 'acquire');
    mkdirSync(storyDir, { recursive: true });
    const leasePath = ownerLeasePath(storyDir);
    assert.equal(leasePath, join(storyDir, OWNER_LEASE_FILE), 'lease path is <storyDir>/owner-lease.json');
    assert.equal(OWNER_LEASE_FILE, 'owner-lease.json', 'canonical lease filename');

    const lease = acquireOwnerLease(storyDir, {
      command: 'checklist_update',
      cwd: '/tmp/worktree-acquire',
      label: 'main-agent',
      now: () => '2026-05-19T10:00:00.000Z',
    });
    assert.equal(existsSync(leasePath), true, 'owner-lease.json written on acquire');
    assert.equal(lease.sessionId, 'sess-alpha', 'lease records the current session');
    assert.equal(lease.sessionSource, 'koala-env', 'lease records sessionSource (koala-env for the LATTICE_SESSION_ID owner)');
    assert.equal(lease.command, 'checklist_update', 'lease records the acquiring command');
    assert.equal(lease.cwd, '/tmp/worktree-acquire', 'lease records the owning cwd');
    assert.equal(lease.label, 'main-agent', 'lease records the optional label');
    assert.equal(typeof lease.pid, 'number', 'lease records a numeric pid');
    assert.equal(typeof lease.hostname, 'string', 'lease records a hostname');
    assert.equal(lease.acquiredAt, '2026-05-19T10:00:00.000Z', 'acquiredAt is the acquire timestamp');
    assert.equal(lease.heartbeatAt, lease.acquiredAt, 'first acquire: heartbeatAt === acquiredAt');

    // Persisted form round-trips through readOwnerLease.
    const readBack = readOwnerLease(storyDir);
    assert.deepEqual(readBack, lease, 'readOwnerLease round-trips the persisted lease');
    assert.equal(isOwnedByCurrentSession(storyDir), true, 'current session owns the freshly acquired lease');
  }

  // ── 3. heartbeat refresh — advances ONLY heartbeatAt ─────────────────────
  {
    const storyDir = join(root, 'heartbeat');
    mkdirSync(storyDir, { recursive: true });
    acquireOwnerLease(storyDir, {
      command: 'understanding_set',
      cwd: '/tmp/worktree-hb',
      now: () => '2026-05-19T11:00:00.000Z',
    });
    const refreshed = refreshOwnerLease(storyDir, {
      command: 'decision_set', // a later command — must NOT overwrite the recorded one
      cwd: '/tmp/worktree-hb',
      now: () => '2026-05-19T11:30:00.000Z',
    });
    assert.notEqual(refreshed, null, 'refresh of an existing lease returns the updated lease');
    assert.equal(refreshed!.heartbeatAt, '2026-05-19T11:30:00.000Z', 'refresh advances heartbeatAt');
    assert.equal(refreshed!.acquiredAt, '2026-05-19T11:00:00.000Z', 'refresh preserves acquiredAt');
    assert.equal(refreshed!.command, 'understanding_set', 'refresh preserves the original acquiring command');
    assert.equal(refreshed!.sessionId, 'sess-alpha', 'refresh preserves the owner sessionId');

    // refresh on a story with NO lease is a no-op (refresh never creates a lease).
    const noLeaseDir = join(root, 'heartbeat-empty');
    mkdirSync(noLeaseDir, { recursive: true });
    const noop = refreshOwnerLease(noLeaseDir, { command: 'checklist_update' });
    assert.equal(noop, null, 'refresh returns null when there is no lease to refresh');
    assert.equal(existsSync(ownerLeasePath(noLeaseDir)), false, 'refresh never creates a lease file');
  }

  // ── 4. release — removes the lease, idempotent ───────────────────────────
  {
    const storyDir = join(root, 'release');
    mkdirSync(storyDir, { recursive: true });
    acquireOwnerLease(storyDir, { command: 'story_advance' });
    const leasePath = ownerLeasePath(storyDir);
    assert.equal(existsSync(leasePath), true, 'lease present before release');

    const removed = releaseOwnerLease(storyDir);
    assert.equal(removed, true, 'release reports it removed the lease');
    assert.equal(existsSync(leasePath), false, 'lease file gone after release');
    assert.equal(isOwnedByCurrentSession(storyDir), false, 'no owner after release');

    // Idempotent: releasing an absent lease is a no-op false.
    const removedAgain = releaseOwnerLease(storyDir);
    assert.equal(removedAgain, false, 'release of an absent lease is an idempotent no-op');
  }

  // ── 5. acquire-or-refresh — acquired / refreshed / foreign ───────────────
  {
    const storyDir = join(root, 'acquire-or-refresh');
    mkdirSync(storyDir, { recursive: true });

    // No lease → acquired.
    const r1 = acquireOrRefreshOwnerLease(storyDir, {
      command: 'checklist_update',
      now: () => '2026-05-19T12:00:00.000Z',
    });
    assert.equal(r1.action, 'acquired', 'first acquire-or-refresh acquires');
    assert.equal(r1.lease.heartbeatAt, '2026-05-19T12:00:00.000Z', 'acquired lease stamped now');

    // Same session → refreshed.
    const r2 = acquireOrRefreshOwnerLease(storyDir, {
      command: 'verification_evidence_add',
      now: () => '2026-05-19T12:15:00.000Z',
    });
    assert.equal(r2.action, 'refreshed', 'same-session acquire-or-refresh refreshes');
    assert.equal(r2.lease.heartbeatAt, '2026-05-19T12:15:00.000Z', 'refresh advanced heartbeatAt');
    assert.equal(r2.lease.acquiredAt, '2026-05-19T12:00:00.000Z', 'refresh kept acquiredAt');

    // Foreign session → observed, NOT written (no silent steal).
    process.env.LATTICE_SESSION_ID = 'sess-bravo';
    resetSessionIdForTest();
    const before = readFileSync(ownerLeasePath(storyDir), 'utf-8');
    const r3 = acquireOrRefreshOwnerLease(storyDir, {
      command: 'checklist_update',
      now: () => '2026-05-19T13:00:00.000Z',
    });
    assert.equal(r3.action, 'foreign', 'a non-owner session sees action=foreign');
    assert.equal(r3.lease.sessionId, 'sess-alpha', 'foreign result reports the existing owner, not the caller');
    const after = readFileSync(ownerLeasePath(storyDir), 'utf-8');
    assert.equal(before, after, 'a non-owner acquire-or-refresh performs NO write (no silent steal)');
    assert.equal(isOwnedByCurrentSession(storyDir), false, 'a non-owner does not own the lease');

    // Restore the canonical owner session.
    process.env.LATTICE_SESSION_ID = 'sess-alpha';
    resetSessionIdForTest();
  }

  // ── 6. malformed lease → treated as no valid lease ───────────────────────
  {
    const storyDir = join(root, 'malformed');
    mkdirSync(storyDir, { recursive: true });
    const leasePath = ownerLeasePath(storyDir);

    // Invalid JSON.
    writeFileSync(leasePath, '{ not json', 'utf-8');
    assert.equal(readOwnerLease(storyDir), null, 'invalid JSON lease reads as null');

    // Valid JSON but missing required fields.
    writeFileSync(leasePath, JSON.stringify({ sessionId: 'x' }), 'utf-8');
    assert.equal(readOwnerLease(storyDir), null, 'incomplete lease reads as null');

    // Valid JSON, all fields present but pid wrong type.
    writeFileSync(leasePath, JSON.stringify({
      sessionId: 'x', hostname: 'h', pid: 'not-a-number', cwd: '/c',
      command: 'checklist_update', acquiredAt: 't', heartbeatAt: 't',
    }), 'utf-8');
    assert.equal(readOwnerLease(storyDir), null, 'lease with wrong-typed pid reads as null');

    // Backward compat: a pre-amendment lease with NO sessionSource is still
    // valid — sessionSource is optional and simply absent from the result.
    writeFileSync(leasePath, JSON.stringify({
      sessionId: 'x', hostname: 'h', pid: 1, cwd: '/c',
      command: 'checklist_update', acquiredAt: 't', heartbeatAt: 't',
    }), 'utf-8');
    const legacyLease = readOwnerLease(storyDir);
    assert.notEqual(legacyLease, null, 'a pre-amendment lease without sessionSource is still valid');
    assert.equal(legacyLease!.sessionSource, undefined, 'an absent sessionSource stays undefined (not fabricated)');

    // An unknown sessionSource value is dropped, not fatal.
    writeFileSync(leasePath, JSON.stringify({
      sessionId: 'x', sessionSource: 'bogus-source', hostname: 'h', pid: 1, cwd: '/c',
      command: 'checklist_update', acquiredAt: 't', heartbeatAt: 't',
    }), 'utf-8');
    const droppedSource = readOwnerLease(storyDir);
    assert.notEqual(droppedSource, null, 'a lease with an unknown sessionSource is still valid');
    assert.equal(droppedSource!.sessionSource, undefined, 'an unknown sessionSource value is dropped, not carried');
    rmSync(leasePath, { force: true });
  }

  // ── 7. F-008-class dirty-write prevention — registered runtime artifact ──
  {
    // The lease path must be classified as a runtime artifact: volatile,
    // material-excluded, and carrying a `**/owner-lease.json` ignore pattern.
    const sampleLeasePath = '.lattice/story/actives/B-c55d/owner-lease.json';
    const entry = findRuntimeArtifactEntry(sampleLeasePath);
    assert.notEqual(entry, undefined, 'owner-lease.json is a registered runtime artifact');
    assert.equal(entry!.id, 'runtime-story-owner-lease', 'owner-lease.json matches the owner-lease registry entry');
    assert.equal(
      isVolatileRuntimeArtifactPath(sampleLeasePath), true,
      'owner-lease.json is classified as volatile runtime state',
    );
    assert.equal(
      isMaterialExcludedRuntimeArtifactPath(sampleLeasePath), true,
      'owner-lease.json is excluded from material hashing',
    );
    assert.equal(
      listRuntimeArtifactIgnorePatterns().includes('**/owner-lease.json'), true,
      'the runtime ignore patterns include **/owner-lease.json',
    );
  }

  // ── 8. CHK-003: stale lease detection (30-minute threshold) ──────────────
  {
    // The threshold constant is exactly 30 minutes.
    assert.equal(STALE_LEASE_THRESHOLD_MS, 30 * 60 * 1000, 'stale threshold is 30 minutes');

    const storyDir = join(root, 'stale-detect');
    mkdirSync(storyDir, { recursive: true });
    // A lease last refreshed at a fixed reference time.
    const heartbeat = '2026-05-19T12:00:00.000Z';
    const lease = acquireOwnerLease(storyDir, {
      command: 'checklist_update',
      now: () => heartbeat,
    });
    const baseMs = Date.parse(heartbeat);

    // 8a. A heartbeat OLDER than 30 minutes → stale.
    assert.equal(
      isLeaseStale(lease, baseMs + STALE_LEASE_THRESHOLD_MS + 1),
      true,
      'a lease with no heartbeat for >30min is stale',
    );
    // 8b. A heartbeat NEWER than 30 minutes → not stale.
    assert.equal(
      isLeaseStale(lease, baseMs + STALE_LEASE_THRESHOLD_MS - 1),
      false,
      'a lease refreshed <30min ago is not stale',
    );
    // 8c. EXACTLY at the threshold → stale (>= boundary).
    assert.equal(
      isLeaseStale(lease, baseMs + STALE_LEASE_THRESHOLD_MS),
      true,
      'a lease exactly 30min old is stale (>= boundary)',
    );
    // 8d. A null lease is never stale (nothing to take over).
    assert.equal(isLeaseStale(null, baseMs), false, 'a null lease is not stale');
    // 8e. An unparseable heartbeat is conservatively treated as stale.
    assert.equal(
      isLeaseStale({ ...lease, heartbeatAt: 'not-a-timestamp' }, baseMs),
      true,
      'a lease with an unparseable heartbeat is conservatively stale',
    );
  }

  // ── 9. CHK-003: --takeover transfers a STALE lease + logs the event ──────
  {
    const storyDir = join(root, 'takeover-stale');
    mkdirSync(storyDir, { recursive: true });

    // Owner = sess-alpha; acquire a lease with an OLD heartbeat (stale).
    const staleHeartbeat = '2026-05-19T10:00:00.000Z';
    acquireOwnerLease(storyDir, {
      command: 'checklist_update',
      cwd: '/tmp/owner-worktree',
      now: () => staleHeartbeat,
    });

    // Act as a DIFFERENT session and take over.
    process.env.LATTICE_SESSION_ID = 'sess-takeover';
    resetSessionIdForTest();
    // The takeover stamp is >30min after the stale heartbeat.
    const takeoverStamp = '2026-05-19T11:00:00.000Z';
    const result = takeOverOwnerLease(storyDir, {
      kind: 'takeover',
      command: 'story_advance',
      cwd: '/tmp/taker-worktree',
      projectRoot: root,
      now: () => takeoverStamp,
    });
    assert.equal(result.transferred, true, '--takeover transfers a stale lease');
    if (result.transferred) {
      assert.equal(result.lease.sessionId, 'sess-takeover', 'the lease now names the taker session');
      assert.equal(result.previous.sessionId, 'sess-alpha', 'the previous owner is recorded');
      assert.equal(result.lease.heartbeatAt, takeoverStamp, 'the transferred lease is freshly stamped');
      assert.equal(result.kind, 'takeover', 'the takeover kind is recorded');
    }
    // The lease on disk is now owned by the taker.
    assert.equal(isOwnedByCurrentSession(storyDir), true, 'the taker session owns the lease after takeover');

    // A takeover EVENT was appended to the activity log.
    const events = readActivityLogTail(root, 50)
      .filter((e) => e.tool === 'story-owner-lease-takeover');
    assert.equal(events.length >= 1, true, 'a story-owner-lease-takeover event was logged');
    const ev = events[0];
    assert.equal(ev.kind, 'takeover', 'the logged event records kind=takeover');
    assert.equal(ev.fromSessionId, 'sess-alpha', 'the event records who the lease was taken from');
    assert.equal(ev.toSessionId, 'sess-takeover', 'the event records who took the lease');
    assert.equal(ev.fromHeartbeatAt, staleHeartbeat, 'the event records the previous heartbeat');
    assert.equal(ev.fromWasStale, true, 'the event records the lease was stale at takeover');

    process.env.LATTICE_SESSION_ID = 'sess-alpha';
    resetSessionIdForTest();
  }

  // ── 10. CHK-003: --takeover on an ACTIVE lease is REFUSED ────────────────
  {
    const storyDir = join(root, 'takeover-active-refused');
    mkdirSync(storyDir, { recursive: true });

    // Owner = sess-alpha with a FRESH heartbeat (active, not stale).
    const freshHeartbeat = '2026-05-19T12:00:00.000Z';
    acquireOwnerLease(storyDir, {
      command: 'checklist_update',
      now: () => freshHeartbeat,
    });
    const leaseBefore = readFileSync(ownerLeasePath(storyDir), 'utf-8');

    process.env.LATTICE_SESSION_ID = 'sess-takeover';
    resetSessionIdForTest();
    // The takeover attempt is only 5 minutes after the fresh heartbeat → active.
    const result = takeOverOwnerLease(storyDir, {
      kind: 'takeover',
      command: 'story_advance',
      projectRoot: root,
      now: () => '2026-05-19T12:05:00.000Z',
    });
    assert.equal(result.transferred, false, '--takeover refuses an active (non-stale) lease');
    if (!result.transferred) {
      assert.equal(result.reason, 'lease-active', 'the refusal reason is lease-active (needs --forceTakeover)');
    }
    // The active lease was NOT modified.
    assert.equal(
      readFileSync(ownerLeasePath(storyDir), 'utf-8'),
      leaseBefore,
      'a refused --takeover performs no lease write (the active lease is untouched)',
    );

    process.env.LATTICE_SESSION_ID = 'sess-alpha';
    resetSessionIdForTest();
  }

  // ── 11. CHK-003: --forceTakeover transfers an ACTIVE lease + logs event ──
  {
    const storyDir = join(root, 'forcetakeover-active');
    mkdirSync(storyDir, { recursive: true });

    // Owner = sess-alpha with a FRESH heartbeat (active).
    const freshHeartbeat = '2026-05-19T12:00:00.000Z';
    acquireOwnerLease(storyDir, { command: 'checklist_update', now: () => freshHeartbeat });

    process.env.LATTICE_SESSION_ID = 'sess-takeover';
    resetSessionIdForTest();
    const forceStamp = '2026-05-19T12:05:00.000Z'; // only 5min later — still active
    const result = takeOverOwnerLease(storyDir, {
      kind: 'forceTakeover',
      command: 'story_advance',
      projectRoot: root,
      now: () => forceStamp,
    });
    assert.equal(result.transferred, true, '--forceTakeover transfers an active lease (human override)');
    if (result.transferred) {
      assert.equal(result.lease.sessionId, 'sess-takeover', 'the lease now names the taker session');
      assert.equal(result.kind, 'forceTakeover', 'the takeover kind is recorded as forceTakeover');
    }
    // A forceTakeover EVENT records the active lease was NOT stale.
    const events = readActivityLogTail(root, 50)
      .filter((e) => e.tool === 'story-owner-lease-takeover' && e.kind === 'forceTakeover');
    assert.equal(events.length >= 1, true, 'a forceTakeover event was logged');
    assert.equal(events[0].fromWasStale, false, 'the forceTakeover event records the lease was active (not stale)');

    process.env.LATTICE_SESSION_ID = 'sess-alpha';
    resetSessionIdForTest();
  }

  // ── 12. CHK-003: no flag → no transfer; takeover guards no-lease/own ─────
  {
    // 12a. No-lease story → takeover refuses (it never CREATES a lease).
    const emptyDir = join(root, 'takeover-no-lease');
    mkdirSync(emptyDir, { recursive: true });
    const noLease = takeOverOwnerLease(emptyDir, {
      kind: 'takeover',
      command: 'story_advance',
      projectRoot: root,
    });
    assert.equal(noLease.transferred, false, 'takeover on a story with no lease does not transfer');
    if (!noLease.transferred) {
      assert.equal(noLease.reason, 'no-lease', 'the refusal reason is no-lease');
    }
    assert.equal(existsSync(ownerLeasePath(emptyDir)), false, 'takeover never creates a lease file');

    // 12b. Taking over a lease THIS session already owns → already-owned no-op.
    const ownDir = join(root, 'takeover-already-owned');
    mkdirSync(ownDir, { recursive: true });
    acquireOwnerLease(ownDir, { command: 'checklist_update', now: () => '2026-05-19T09:00:00.000Z' });
    const ownResult = takeOverOwnerLease(ownDir, {
      kind: 'forceTakeover',
      command: 'story_advance',
      projectRoot: root,
      now: () => '2026-05-19T12:00:00.000Z',
    });
    assert.equal(ownResult.transferred, false, 'takeover of an own lease is a no-op');
    if (!ownResult.transferred) {
      assert.equal(ownResult.reason, 'already-owned', 'the refusal reason is already-owned');
    }

    // 12c. WITHOUT any takeover flag a foreign STALE lease is observed but
    // NEVER transferred — acquireOrRefreshOwnerLease returns `foreign` and
    // writes nothing (the no-flag path keeps the CHK-002 fail-closed reject).
    const foreignDir = join(root, 'no-flag-no-transfer');
    mkdirSync(foreignDir, { recursive: true });
    acquireOwnerLease(foreignDir, {
      command: 'checklist_update',
      now: () => '2026-05-19T08:00:00.000Z', // very old → stale
    });
    process.env.LATTICE_SESSION_ID = 'sess-other';
    resetSessionIdForTest();
    const leaseBefore = readFileSync(ownerLeasePath(foreignDir), 'utf-8');
    const observed = acquireOrRefreshOwnerLease(foreignDir, { command: 'story_advance' });
    assert.equal(observed.action, 'foreign', 'without a takeover flag a foreign lease stays foreign');
    assert.equal(observed.lease.sessionId, 'sess-alpha', 'the foreign lease still names the original owner');
    assert.equal(
      readFileSync(ownerLeasePath(foreignDir), 'utf-8'),
      leaseBefore,
      'no takeover flag → the (even stale) foreign lease is NOT transferred (no write)',
    );

    // 12d. Runtime enum re-validation: an invalid `kind` throws.
    assert.throws(
      () => takeOverOwnerLease(foreignDir, { kind: 'bogus' as never, command: 'story_advance' }),
      /kind must be/,
      'takeOverOwnerLease rejects an invalid kind (runtime enum re-validation)',
    );

    process.env.LATTICE_SESSION_ID = 'sess-alpha';
    resetSessionIdForTest();
  }

  // ── 13. CHK-004: formatNonOwnerError — complete Error UX field set ───────
  {
    // formatLeaseAge is the shared compact age formatter.
    assert.equal(formatLeaseAge(30 * 1000), '30s', 'formatLeaseAge: sub-minute → Ns');
    assert.equal(formatLeaseAge(8 * 60 * 1000), '8m', 'formatLeaseAge: sub-hour → Nm');
    assert.equal(formatLeaseAge(2 * 60 * 60 * 1000), '2h', 'formatLeaseAge: hours → Nh');
    assert.equal(formatLeaseAge(-1), '0s', 'formatLeaseAge: a negative age is clamped to 0s');

    const heartbeat = '2026-05-19T12:00:00.000Z';
    const baseMs = Date.parse(heartbeat);
    const foreignLease = acquireOwnerLease(join(root, 'fmt-err'), {
      command: 'checklist_update',
      cwd: '/tmp/owner-wt',
      now: () => heartbeat,
    });

    // 13a. ACTIVE foreign lease (8m old) → message names story / owner session /
    // owner cwd / heartbeat age / ACTIVE verdict / --forceTakeover next action.
    const activeMsg = formatNonOwnerError(foreignLease, {
      storyId: 'B-6974',
      command: 'checklist_update',
      ownershipClass: 'storyScopedMutating',
      currentSessionId: 'sess-intruder',
      now: baseMs + 8 * 60 * 1000,
    });
    assert.ok(activeMsg.includes('B-6974'), 'error names the owned story id');
    assert.ok(activeMsg.includes(foreignLease.sessionId), 'error names the owner sessionId');
    assert.ok(activeMsg.includes('/tmp/owner-wt'), 'error names the owner cwd');
    assert.ok(activeMsg.includes('8m ago'), 'error shows the last-heartbeat age (<n>m ago)');
    assert.ok(activeMsg.includes('ACTIVE'), 'error states the lease is ACTIVE');
    assert.ok(activeMsg.includes('checklist_update'), 'error names the rejected command');
    assert.ok(activeMsg.includes('storyScopedMutating'), 'error names the owner-gated class');
    assert.ok(activeMsg.includes('sess-intruder'), 'error names the current (rejected) session');
    assert.ok(activeMsg.includes('read-only'), 'active error suggests read-only commands');
    assert.ok(activeMsg.includes('--forceTakeover'), 'active error suggests --forceTakeover (the active-lease next action)');
    assert.ok(!activeMsg.includes('--takeover '), 'active error does NOT suggest plain --takeover for an active lease');
    const sameWorktreeMsg = formatNonOwnerError(foreignLease, {
      storyId: 'B-6974',
      command: 'checklist_update',
      ownershipClass: 'storyScopedMutating',
      currentSessionId: 'sess-intruder',
      currentCwd: '/tmp/owner-wt',
      now: baseMs + 8 * 60 * 1000,
    });
    assert.ok(sameWorktreeMsg.includes('same-worktree context switch'), 'same-cwd error explains the context-switch case');
    assert.ok(sameWorktreeMsg.includes('lattice session_brief'), 'same-cwd error tells the operator to inspect session_brief');
    assert.ok(sameWorktreeMsg.includes('not transferred unless'), 'same-cwd error states the lease is not transferred automatically');

    // 13b. STALE foreign lease (>30min old) → STALE verdict + --takeover action.
    const staleMsg = formatNonOwnerError(foreignLease, {
      storyId: 'B-6974',
      command: 'story_advance',
      ownershipClass: 'storyScopedMutating',
      currentSessionId: 'sess-intruder',
      now: baseMs + STALE_LEASE_THRESHOLD_MS + 60_000,
    });
    assert.ok(staleMsg.includes('STALE'), 'stale error states the lease is STALE');
    assert.ok(staleMsg.includes('--takeover'), 'stale error suggests --takeover');
    assert.ok(staleMsg.includes('read-only'), 'stale error still suggests read-only / wait');

    // 13c. An unparseable heartbeat → age renders as "unknown", verdict STALE
    // (an unparseable heartbeat is conservatively stale per isLeaseStale).
    const badMsg = formatNonOwnerError(
      { ...foreignLease, heartbeatAt: 'not-a-timestamp' },
      {
        storyId: 'B-6974',
        command: 'checklist_update',
        ownershipClass: 'storyScopedMutating',
        currentSessionId: 'sess-intruder',
        now: baseMs,
      },
    );
    assert.ok(badMsg.includes('unknown'), 'an unparseable heartbeat renders the age as "unknown"');
    assert.ok(badMsg.includes('STALE'), 'an unparseable heartbeat is conservatively treated as STALE');
  }

  // ── 14. CHK-004: summarizeOwnerLease — session_brief ownership view ──────
  {
    const heartbeat = '2026-05-19T12:00:00.000Z';
    const baseMs = Date.parse(heartbeat);

    // 14a. No lease on disk → hasLease:false, recommendation:proceed.
    const emptyDir = join(root, 'view-empty');
    mkdirSync(emptyDir, { recursive: true });
    const noneView = summarizeOwnerLease(emptyDir, 'sess-me', baseMs);
    assert.equal(noneView.hasLease, false, 'no lease → hasLease:false');
    assert.equal(noneView.recommendation, 'proceed', 'no lease → recommendation:proceed');
    assert.equal(noneView.ownerSessionId, null, 'no lease → ownerSessionId:null');

    // 14b. Lease owned by the CURRENT session, ACTIVE → isOwner:true, proceed.
    const ownDir = join(root, 'view-own');
    mkdirSync(ownDir, { recursive: true });
    process.env.LATTICE_SESSION_ID = 'sess-me';
    resetSessionIdForTest();
    acquireOwnerLease(ownDir, { command: 'checklist_update', cwd: '/tmp/my-wt', now: () => heartbeat });
    const ownView = summarizeOwnerLease(ownDir, 'sess-me', baseMs + 5 * 60 * 1000);
    assert.equal(ownView.hasLease, true, 'owned lease → hasLease:true');
    assert.equal(ownView.isCurrentSessionOwner, true, 'owned lease → isCurrentSessionOwner:true');
    assert.equal(ownView.ownerSessionId, 'sess-me', 'view reports the owner sessionId');
    assert.equal(ownView.ownerSessionSource, 'koala-env', 'view reports the owner sessionSource');
    assert.equal(ownView.ownerCwd, '/tmp/my-wt', 'view reports the owner cwd');
    assert.equal(ownView.heartbeatAge, '5m ago', 'view reports the last-heartbeat age');
    assert.equal(ownView.stale, false, 'a 5m-old lease is active, not stale');
    assert.equal(ownView.recommendation, 'proceed', 'an owned active lease → recommendation:proceed');
    assert.equal(ownView.currentSessionId, 'sess-me', 'view carries the inspecting session id');

    // 14c. Foreign ACTIVE lease → isOwner:false, recommendation:read-only.
    const foreignActiveView = summarizeOwnerLease(ownDir, 'sess-other', baseMs + 5 * 60 * 1000);
    assert.equal(foreignActiveView.isCurrentSessionOwner, false, 'foreign lease → isCurrentSessionOwner:false');
    assert.equal(foreignActiveView.stale, false, 'foreign 5m-old lease is active');
    assert.equal(foreignActiveView.recommendation, 'read-only', 'a foreign active lease → recommendation:read-only');
    assert.equal(foreignActiveView.ownerCwdMatchesCurrent, false, 'different cwd → no same-worktree guidance');
    const foreignSameWorktreeView = summarizeOwnerLease(ownDir, 'sess-other', baseMs + 5 * 60 * 1000, '/tmp/my-wt');
    assert.equal(foreignSameWorktreeView.ownerCwdMatchesCurrent, true, 'same owner cwd/current cwd is detected for guidance');

    // 14d. Foreign STALE lease → recommendation:takeover-available.
    const foreignStaleView = summarizeOwnerLease(
      ownDir,
      'sess-other',
      baseMs + STALE_LEASE_THRESHOLD_MS + 60_000,
    );
    assert.equal(foreignStaleView.stale, true, 'a >30min-old foreign lease is stale');
    assert.equal(foreignStaleView.recommendation, 'takeover-available', 'a foreign stale lease → recommendation:takeover-available');

    process.env.LATTICE_SESSION_ID = 'sess-alpha';
    resetSessionIdForTest();
  }

  // ── 15. CHK-004: renderOwnershipBlock — session_brief ownership lines ────
  {
    // 15a. No lease → empty block (a story nobody mutated needs no section).
    assert.deepEqual(
      renderOwnershipBlock({
        hasLease: false, ownerSessionId: null, ownerSessionSource: null, ownerCwd: null,
        heartbeatAge: null, stale: false, isCurrentSessionOwner: false,
        recommendation: 'proceed', currentSessionId: 'sess-me',
      }),
      [],
      'renderOwnershipBlock returns no lines when there is no lease',
    );

    // 15b. Owned active lease → block shows owner/cwd/heartbeat/OWNER/proceed.
    const ownerLines = renderOwnershipBlock({
      hasLease: true, ownerSessionId: 'sess-me', ownerSessionSource: 'koala-env',
      ownerCwd: '/tmp/my-wt', heartbeatAge: '3m ago', stale: false,
      isCurrentSessionOwner: true, recommendation: 'proceed', currentSessionId: 'sess-me',
    }).join('\n');
    assert.ok(ownerLines.includes('## Story ownership (active)'), 'owned block heading shows active status');
    assert.ok(ownerLines.includes('owner session: sess-me [koala-env]'), 'owned block shows owner session + source');
    assert.ok(ownerLines.includes('owner cwd: /tmp/my-wt'), 'owned block shows owner cwd');
    assert.ok(ownerLines.includes('last heartbeat: 3m ago'), 'owned block shows heartbeat age');
    assert.ok(ownerLines.includes('OWNER'), 'owned block marks this session OWNER');
    assert.ok(ownerLines.includes('recommended: proceed'), 'owned block recommends proceed');

    // 15c. Foreign STALE lease → block marks NOT owner + takeover available.
    const staleLines = renderOwnershipBlock({
      hasLease: true, ownerSessionId: 'sess-owner', ownerSessionSource: 'claude-code-env',
      ownerCwd: '/tmp/owner-wt', heartbeatAge: '45m ago', stale: true,
      isCurrentSessionOwner: false, recommendation: 'takeover-available', currentSessionId: 'sess-me',
    }).join('\n');
    assert.ok(staleLines.includes('## Story ownership (STALE)'), 'stale block heading shows STALE status');
    assert.ok(staleLines.includes('NOT owner (sess-me)'), 'stale block marks this session NOT owner + names it');
    assert.ok(staleLines.includes('takeover available'), 'stale block recommends takeover available');
    assert.ok(staleLines.includes('--takeover'), 'stale block mentions --takeover');

    // 15d. Foreign ACTIVE lease → block recommends read-only only.
    const activeForeignLines = renderOwnershipBlock({
      hasLease: true, ownerSessionId: 'sess-owner', ownerSessionSource: 'koala-env',
      ownerCwd: '/tmp/owner-wt', heartbeatAge: '2m ago', stale: false,
      isCurrentSessionOwner: false, recommendation: 'read-only', currentSessionId: 'sess-me',
    }).join('\n');
    assert.ok(activeForeignLines.includes('read-only only'), 'foreign active block recommends read-only only');
    assert.ok(activeForeignLines.includes('--forceTakeover'), 'foreign active block mentions --forceTakeover as the override');
    const sameWorktreeLines = renderOwnershipBlock({
      hasLease: true, ownerSessionId: 'sess-owner', ownerSessionSource: 'koala-env',
      ownerCwd: '/tmp/owner-wt', heartbeatAge: '2m ago', stale: false,
      isCurrentSessionOwner: false, recommendation: 'read-only', currentSessionId: 'sess-me',
      ownerCwdMatchesCurrent: true, currentCwd: '/tmp/owner-wt',
    }).join('\n');
    assert.ok(sameWorktreeLines.includes('same worktree'), 'same-worktree block labels the context-switch case');
    assert.ok(sameWorktreeLines.includes('lattice session_brief'), 'same-worktree block tells the operator to inspect session_brief');
    assert.ok(sameWorktreeLines.includes('no lease transfer happens automatically'), 'same-worktree block states there is no automatic transfer');
  }

  // ── 16. CHK-004: renderMetaAuditBlock — B-META shared audit state ────────
  {
    const metaLines = renderMetaAuditBlock('B-META-framework-audit').join('\n');
    assert.ok(metaLines.includes('## Shared audit state (B-META)'), 'B-META block is rendered as shared audit state');
    assert.ok(metaLines.includes('B-META-framework-audit'), 'B-META block names the container');
    assert.ok(metaLines.includes('NO per-story owner lease'), 'B-META block states it carries no owner lease');
    assert.ok(metaLines.includes('main write lock'), 'B-META block notes the main write lock serializes its writes');
    // The only `story_advance` mention is the explicit "Do not run lattice story_advance"
    // negative — the block never recommends advancing a B-META container.
    assert.ok(
      metaLines.includes('Do not run `lattice story_advance`'),
      'B-META block explicitly tells the agent not to run lattice story_advance',
    );
    assert.equal(
      (metaLines.match(/story_advance/g) ?? []).length, 1,
      'B-META block mentions story_advance exactly once — only in the "Do not story_advance" prohibition',
    );
  }

  // ── 17. CHK-004: reviewer read-only flow is NOT blocked by an owner lease ─
  {
    // Confirm the lease primitive itself never refuses a non-owner observation:
    // a foreign-owned story still reads cleanly (readOwnerLease / isOwnedBy /
    // summarizeOwnerLease) — these back the readOnly commands story_get /
    // checklist_get / finding_list / session_brief, which the CHK-002 gate
    // classifies readOnly and never gates. (The gate-level assertion that all
    // four commands pass on a foreign-owned story lives in
    // command-ownership-contract.ts case 5b.)
    const reviewerDir = join(root, 'reviewer-readonly');
    mkdirSync(reviewerDir, { recursive: true });
    process.env.LATTICE_SESSION_ID = 'sess-owner';
    resetSessionIdForTest();
    acquireOwnerLease(reviewerDir, { command: 'checklist_update', cwd: '/tmp/owner-wt' });

    // Act as a reviewer session (a DIFFERENT, non-owner session).
    process.env.LATTICE_SESSION_ID = 'sess-reviewer';
    resetSessionIdForTest();
    // A non-owner observation never throws and never mutates the lease.
    const leaseBefore = readFileSync(ownerLeasePath(reviewerDir), 'utf-8');
    assert.notEqual(readOwnerLease(reviewerDir), null, 'a reviewer session can still read a foreign-owned lease');
    assert.equal(isOwnedByCurrentSession(reviewerDir), false, 'the reviewer session is correctly seen as non-owner');
    const reviewerView = summarizeOwnerLease(reviewerDir, getSessionId());
    assert.equal(reviewerView.isCurrentSessionOwner, false, 'the reviewer ownership view reports non-owner');
    assert.equal(reviewerView.recommendation !== 'proceed', true, 'the reviewer view recommends read-only / takeover, never silently proceed');
    assert.equal(
      readFileSync(ownerLeasePath(reviewerDir), 'utf-8'),
      leaseBefore,
      'a reviewer read-only inspection performs NO lease write',
    );

    process.env.LATTICE_SESSION_ID = 'sess-alpha';
    resetSessionIdForTest();
  }

  // ── 18. CHK-005: doctor stale-lease scan — detects + reports a stale lease ─
  {
    // The doctor scan is driven through a real StoryStore over a tmp project
    // root; each "story" is just an actives/<id> dir with an index.json + an
    // owner-lease.json so `listStoryIds` / `storyDirPath` resolve it.
    const doctorRoot = join(root, 'doctor-scan');
    mkdirSync(doctorRoot, { recursive: true });
    const doctorStore = new StoryStore(doctorRoot);

    // Helper: materialise a story dir with a minimal index.json.
    const makeStory = (id: string, phase = 'DEV'): string => {
      const dir = doctorStore.storyDirPath(id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'index.json'), JSON.stringify({ id, phase }), 'utf-8');
      return dir;
    };

    // 18a. NO leases anywhere → scan reports nothing stale, no false positive.
    makeStory('B-no-lease-a');
    makeStory('B-no-lease-b');
    const cleanScan = scanStoryOwnerLeases(doctorStore, Date.parse('2026-05-19T12:00:00.000Z'));
    assert.equal(cleanScan.leases.length, 0, 'a story with no owner-lease.json contributes no lease entry');
    assert.equal(cleanScan.stale.length, 0, 'no leases on disk → no stale leases reported');
    assert.ok(
      renderStoryOwnerLeaseScan(cleanScan).some((l) => l.includes('No actionable stale story owner leases')),
      'the clean scan renders the healthy "No actionable stale story owner leases" line',
    );

    // 18b. One ACTIVE lease (fresh heartbeat) + one STALE lease (>30min old).
    process.env.LATTICE_SESSION_ID = 'sess-active-owner';
    resetSessionIdForTest();
    const activeDir = makeStory('B-active-lease');
    acquireOwnerLease(activeDir, {
      command: 'checklist_update',
      cwd: '/tmp/active-wt',
      now: () => '2026-05-19T11:55:00.000Z', // 5min before the reference clock
    });

    process.env.LATTICE_SESSION_ID = 'sess-dead-owner';
    resetSessionIdForTest();
    const staleDir = makeStory('B-stale-lease');
    acquireOwnerLease(staleDir, {
      command: 'story_advance',
      cwd: '/tmp/stale-wt',
      now: () => '2026-05-19T11:15:00.000Z', // 45min before the reference clock → stale
    });

    process.env.LATTICE_SESSION_ID = 'sess-terminal-owner';
    resetSessionIdForTest();
    const terminalDir = makeStory('B-terminal-lease', 'DONE');
    acquireOwnerLease(terminalDir, {
      command: 'story_advance',
      cwd: '/tmp/terminal-wt',
      now: () => '2026-05-19T10:45:00.000Z', // 75min before the reference clock → stale but terminal
    });

    const referenceNow = Date.parse('2026-05-19T12:00:00.000Z');
    const scan = scanStoryOwnerLeases(doctorStore, referenceNow);
    assert.equal(scan.leases.length, 3, 'the scan finds exactly the three stories that have a lease');
    assert.equal(scan.stale.length, 1, 'exactly one non-terminal lease is actionable stale');
    assert.equal(scan.terminalStale.length, 1, 'terminal stale leases are split into the summary bucket');
    const staleItem = scan.stale[0];
    assert.equal(staleItem.storyId, 'B-stale-lease', 'the stale entry names the stale story');
    assert.equal(staleItem.state, 'stale', 'the stale entry is classified state=stale');
    assert.equal(staleItem.terminal, false, 'the actionable stale entry is non-terminal');
    assert.equal(staleItem.ownerSessionId, 'sess-dead-owner', 'the stale entry names the owning session');
    assert.equal(staleItem.ownerCwd, '/tmp/stale-wt', 'the stale entry names the owner cwd');
    assert.equal(staleItem.heartbeatAgeLabel, '45m', 'the stale entry reports the heartbeat age (45m)');
    const terminalItem = scan.terminalStale[0];
    assert.equal(terminalItem.storyId, 'B-terminal-lease', 'the terminal stale bucket names the terminal story');
    assert.equal(terminalItem.phase, 'DONE', 'the terminal stale bucket preserves the terminal phase');
    assert.equal(terminalItem.terminal, true, 'the terminal stale bucket marks terminal=true');
    // The active lease is NOT misflagged as stale.
    const activeItem = scan.leases.find((l) => l.storyId === 'B-active-lease');
    assert.notEqual(activeItem, undefined, 'the active lease appears in the leases list');
    assert.equal(activeItem!.state, 'active', 'a 5m-old lease is classified active, not stale');

    // 18c. The doctor text report names the stale story + owner + heartbeat age.
    const reportLines = renderStoryOwnerLeaseScan(scan);
    const report = reportLines.join('\n');
    assert.ok(report.includes('Story owner leases:'), 'the report has a Story owner leases section');
    assert.ok(report.includes('stale leases : 1'), 'the report counts the stale lease');
    assert.ok(report.includes('terminal stale leases: 1'), 'the report summarizes terminal stale leases separately');
    assert.ok(report.includes('⚠ STALE owner lease for B-stale-lease'), 'the report flags the stale story by id');
    assert.equal(
      report.includes('⚠ STALE owner lease for B-terminal-lease'),
      false,
      'terminal stale leases are not rendered as per-story actionable warnings',
    );
    assert.ok(report.includes('sess-dead-owner'), 'the report names the stale lease owner session');
    assert.ok(report.includes('45m ago'), 'the report shows the stale heartbeat age');
    assert.ok(report.includes('--takeover'), 'the report points the operator at --takeover recovery');
    assert.ok(report.includes('DONE/DISCARDED stories do not need --takeover'), 'terminal stale summary avoids takeover guidance');

    process.env.LATTICE_SESSION_ID = 'sess-alpha';
    resetSessionIdForTest();
  }

  // ── 19. CHK-005: two sessions, SAME story → second is fail-closed rejected ─
  {
    // Acceptance Criteria 1: two sessions mutating the same story — the second
    // session is rejected with owner guidance.
    const gateRoot = join(root, 'multi-same-story');
    mkdirSync(gateRoot, { recursive: true });
    const gateStore = new StoryStore(gateRoot);
    const storyId = 'B-shared';
    const storyDir = gateStore.storyDirPath(storyId);
    mkdirSync(storyDir, { recursive: true });

    // Session A acquires the lease by running an owner-gated command.
    process.env.LATTICE_SESSION_ID = 'sess-A';
    resetSessionIdForTest();
    assert.doesNotThrow(
      () => enforceStoryOwnerLeaseGate('checklist_update', { storyId }, gateStore, null, gateRoot),
      'session A acquires the owner lease and proceeds on the shared story',
    );
    const leaseAfterA = readFileSync(ownerLeasePath(storyDir), 'utf-8');

    // Session B running a mutating command on the SAME story is rejected.
    process.env.LATTICE_SESSION_ID = 'sess-B';
    resetSessionIdForTest();
    assert.throws(
      () => enforceStoryOwnerLeaseGate('checklist_update', { storyId }, gateStore, null, gateRoot),
      (err: Error) =>
        err.message.includes(storyId) &&
        err.message.includes('sess-A') &&
        err.message.includes('owner-gated') &&
        err.message.includes('same-worktree context switch') &&
        err.message.includes('lattice session_brief') &&
        err.message.includes('not transferred unless'),
      'session B on the same story is fail-closed rejected with owner guidance naming session A and same-worktree recovery text',
    );
    // The rejection performed NO lease write (no silent steal by B).
    assert.equal(
      readFileSync(ownerLeasePath(storyDir), 'utf-8'),
      leaseAfterA,
      'a rejected non-owner command leaves the owner lease untouched',
    );

    process.env.LATTICE_SESSION_ID = 'sess-alpha';
    resetSessionIdForTest();
  }

  // ── 20. CHK-005: two sessions, DIFFERENT stories → both proceed ──────────
  {
    // Acceptance Criteria 2: two sessions working different stories both
    // proceed — the owner lease is per-story, so they never contend.
    const gateRoot = join(root, 'multi-diff-story');
    mkdirSync(gateRoot, { recursive: true });
    const gateStore = new StoryStore(gateRoot);
    const storyX = 'B-story-x';
    const storyY = 'B-story-y';
    mkdirSync(gateStore.storyDirPath(storyX), { recursive: true });
    mkdirSync(gateStore.storyDirPath(storyY), { recursive: true });

    // Session A owns story X.
    process.env.LATTICE_SESSION_ID = 'sess-A';
    resetSessionIdForTest();
    assert.doesNotThrow(
      () => enforceStoryOwnerLeaseGate('checklist_update', { storyId: storyX }, gateStore, null, gateRoot),
      'session A acquires story X',
    );

    // Session B owns story Y — a DIFFERENT story → no contention, B proceeds.
    process.env.LATTICE_SESSION_ID = 'sess-B';
    resetSessionIdForTest();
    assert.doesNotThrow(
      () => enforceStoryOwnerLeaseGate('checklist_update', { storyId: storyY }, gateStore, null, gateRoot),
      'session B acquires a DIFFERENT story Y — per-story leases never cross-contend',
    );
    // Session A can still re-run an owner-gated command on its own story X.
    process.env.LATTICE_SESSION_ID = 'sess-A';
    resetSessionIdForTest();
    assert.doesNotThrow(
      () => enforceStoryOwnerLeaseGate('understanding_set', { storyId: storyX }, gateStore, null, gateRoot),
      'session A keeps running owner-gated commands on story X while B works story Y',
    );
    // Each story has its own lease naming its own owner.
    const leaseX = JSON.parse(readFileSync(ownerLeasePath(gateStore.storyDirPath(storyX)), 'utf-8'));
    const leaseY = JSON.parse(readFileSync(ownerLeasePath(gateStore.storyDirPath(storyY)), 'utf-8'));
    assert.equal(leaseX.sessionId, 'sess-A', 'story X is owned by session A');
    assert.equal(leaseY.sessionId, 'sess-B', 'story Y is owned by session B');

    process.env.LATTICE_SESSION_ID = 'sess-alpha';
    resetSessionIdForTest();
  }

  // ── 21. CHK-005: stale-lease takeover allowed ONLY with --takeover + event ─
  {
    // Acceptance Criteria 5: a stale lease takeover is allowed only with an
    // explicit takeover flag, and it records an event.
    const gateRoot = join(root, 'multi-stale-takeover');
    mkdirSync(gateRoot, { recursive: true });
    const gateStore = new StoryStore(gateRoot);
    const storyId = 'B-stale-takeover';
    const storyDir = gateStore.storyDirPath(storyId);
    mkdirSync(storyDir, { recursive: true });

    // Session A owns the story with an OLD (stale) heartbeat.
    process.env.LATTICE_SESSION_ID = 'sess-A';
    resetSessionIdForTest();
    acquireOwnerLease(storyDir, {
      command: 'checklist_update',
      cwd: '/tmp/A-wt',
      now: () => new Date(Date.now() - STALE_LEASE_THRESHOLD_MS - 60_000).toISOString(),
    });

    // Session B WITHOUT a flag is rejected even though the lease is stale.
    process.env.LATTICE_SESSION_ID = 'sess-B';
    resetSessionIdForTest();
    assert.throws(
      () => enforceStoryOwnerLeaseGate('story_advance', { storyId }, gateStore, null, gateRoot),
      /owner-gated/,
      'session B without --takeover is rejected even on a STALE lease (no flag → no transfer)',
    );

    // Session B WITH --takeover seizes the stale lease and an event is logged.
    assert.doesNotThrow(
      () => enforceStoryOwnerLeaseGate('story_advance', { storyId, takeover: true }, gateStore, null, gateRoot),
      'session B with --takeover transfers the STALE lease',
    );
    const leaseAfter = JSON.parse(readFileSync(ownerLeasePath(storyDir), 'utf-8'));
    assert.equal(leaseAfter.sessionId, 'sess-B', 'the stale lease now names the taker session B');
    const takeoverEvents = readActivityLogTail(gateRoot, 50)
      .filter((e) => e.tool === 'story-owner-lease-takeover' && e.kind === 'takeover');
    assert.equal(takeoverEvents.length >= 1, true, 'a story-owner-lease-takeover event was recorded for the stale takeover');

    process.env.LATTICE_SESSION_ID = 'sess-alpha';
    resetSessionIdForTest();
  }

  // ── 22. CHK-005: active-lease takeover rejected unless --forceTakeover ────
  {
    // Acceptance Criteria 6: an active (non-stale) lease takeover is rejected
    // unless --forceTakeover is supplied.
    const gateRoot = join(root, 'multi-active-takeover');
    mkdirSync(gateRoot, { recursive: true });
    const gateStore = new StoryStore(gateRoot);
    const storyId = 'B-active-takeover';
    const storyDir = gateStore.storyDirPath(storyId);
    mkdirSync(storyDir, { recursive: true });

    // Session A owns the story with a FRESH heartbeat (active, not stale).
    process.env.LATTICE_SESSION_ID = 'sess-A';
    resetSessionIdForTest();
    enforceStoryOwnerLeaseGate('checklist_update', { storyId }, gateStore, null, gateRoot);
    const leaseBefore = readFileSync(ownerLeasePath(storyDir), 'utf-8');

    // Session B with plain --takeover is REJECTED — the lease is active.
    process.env.LATTICE_SESSION_ID = 'sess-B';
    resetSessionIdForTest();
    assert.throws(
      () => enforceStoryOwnerLeaseGate('story_advance', { storyId, takeover: true }, gateStore, null, gateRoot),
      /owner-gated|--forceTakeover/,
      'session B with plain --takeover is rejected on an ACTIVE lease',
    );
    assert.equal(
      readFileSync(ownerLeasePath(storyDir), 'utf-8'),
      leaseBefore,
      'a refused --takeover on an active lease performs no write',
    );

    // Session B with --forceTakeover succeeds (deliberate human override).
    assert.doesNotThrow(
      () => enforceStoryOwnerLeaseGate('story_advance', { storyId, forceTakeover: true }, gateStore, null, gateRoot),
      'session B with --forceTakeover seizes the ACTIVE lease (human override)',
    );
    const leaseAfter = JSON.parse(readFileSync(ownerLeasePath(storyDir), 'utf-8'));
    assert.equal(leaseAfter.sessionId, 'sess-B', 'the active lease now names the force-taker session B');
    const forceEvents = readActivityLogTail(gateRoot, 50)
      .filter((e) => e.tool === 'story-owner-lease-takeover' && e.kind === 'forceTakeover');
    assert.equal(forceEvents.length >= 1, true, 'a forceTakeover event was recorded for the active takeover');

    process.env.LATTICE_SESSION_ID = 'sess-alpha';
    resetSessionIdForTest();
  }

  // ── 23. CHK-005: session_brief guides a non-owner session (wait/read-only) ─
  {
    // Acceptance Criteria 7: session_brief clearly tells a non-owner session to
    // wait or stay read-only — exercised through the ownership block renderer
    // over a foreign-owned story.
    const briefRoot = join(root, 'multi-brief-guidance');
    mkdirSync(briefRoot, { recursive: true });
    const storyDir = join(briefRoot, 'B-foreign');
    mkdirSync(storyDir, { recursive: true });

    // Session "sess-owner" owns the story with an ACTIVE heartbeat.
    process.env.LATTICE_SESSION_ID = 'sess-owner';
    resetSessionIdForTest();
    acquireOwnerLease(storyDir, { command: 'checklist_update', cwd: '/tmp/owner-wt' });

    // A non-owner session inspecting the story sees a read-only recommendation.
    process.env.LATTICE_SESSION_ID = 'sess-bystander';
    resetSessionIdForTest();
    const foreignView = summarizeOwnerLease(storyDir, getSessionId());
    assert.equal(foreignView.isCurrentSessionOwner, false, 'the bystander session is correctly NOT the owner');
    assert.equal(foreignView.recommendation, 'read-only', 'a foreign ACTIVE lease → recommendation:read-only (wait / stay read-only)');
    const briefLines = renderOwnershipBlock(foreignView).join('\n');
    assert.ok(briefLines.includes('NOT owner'), 'session_brief ownership block marks the bystander NOT owner');
    assert.ok(briefLines.includes('read-only only'), 'session_brief ownership block tells the bystander read-only only');
    const sameCwdView = summarizeOwnerLease(storyDir, getSessionId(), Date.now(), '/tmp/owner-wt');
    const sameCwdLines = renderOwnershipBlock(sameCwdView).join('\n');
    assert.ok(sameCwdLines.includes('same worktree'), 'session_brief adds same-worktree guidance when owner cwd equals current cwd');

    process.env.LATTICE_SESSION_ID = 'sess-alpha';
    resetSessionIdForTest();
  }

  // ── 24. CHK-005: reviewer read-only flow + reviewerWrite NOT lease-blocked ─
  {
    // Acceptance Criteria 8: existing read-only reviewer workflows still work;
    // and a legitimate reviewer-lane WRITE (reviewerWrite class) is exempt from
    // the owner lease so the three-way review balance is never locked.
    const revRoot = join(root, 'multi-reviewer-flow');
    mkdirSync(revRoot, { recursive: true });
    const revStore = new StoryStore(revRoot);
    const storyId = 'B-reviewed';
    const storyDir = revStore.storyDirPath(storyId);
    mkdirSync(storyDir, { recursive: true });

    // The main agent (sess-author) owns the story.
    process.env.LATTICE_SESSION_ID = 'sess-author';
    resetSessionIdForTest();
    enforceStoryOwnerLeaseGate('checklist_update', { storyId }, revStore, null, revRoot);
    const leaseBefore = readFileSync(ownerLeasePath(storyDir), 'utf-8');

    // A reviewer runs as a DIFFERENT, non-owner session.
    process.env.LATTICE_SESSION_ID = 'sess-reviewer';
    resetSessionIdForTest();

    // 24a. Reviewer read-only commands on the foreign-owned story all pass.
    for (const roCmd of ['story_get', 'checklist_get', 'finding_list', 'session_brief']) {
      assert.equal(
        resolveEffectiveOwnershipClass(roCmd, { storyId }, storyId),
        'readOnly',
        `${roCmd} is classified readOnly`,
      );
      assert.doesNotThrow(
        () => enforceStoryOwnerLeaseGate(roCmd, { storyId }, revStore, null, revRoot),
        `${roCmd} (reviewer read-only flow) on a foreign-owned story is never lease-blocked`,
      );
    }

    // 24b. A reviewerWrite-class command (review_pass_set) is owner-lease exempt.
    assert.equal(
      resolveEffectiveOwnershipClass('review_pass_set', { storyId }, storyId),
      'reviewerWrite',
      'review_pass_set is classified reviewerWrite',
    );
    assert.doesNotThrow(
      () => enforceStoryOwnerLeaseGate('review_pass_set', { storyId }, revStore, null, revRoot),
      'review_pass_set (reviewerWrite) on a foreign-owned story is owner-lease exempt — the reviewer lane keeps its independent write right',
    );
    // None of the reviewer commands mutated the author's owner lease.
    assert.equal(
      readFileSync(ownerLeasePath(storyDir), 'utf-8'),
      leaseBefore,
      'reviewer read-only + reviewerWrite commands never rewrite the author owner lease',
    );

    process.env.LATTICE_SESSION_ID = 'sess-alpha';
    resetSessionIdForTest();
  }

  // ── 25. CHK-005: F-008-class regression — owner-lease.json never dirty ───
  {
    // F-008-class assertion: owner-lease.json is a runtime artifact (registered
    // in the runtime-artifact registry + a `**/owner-lease.json` .gitignore
    // glob). It must NEVER show up as an uncommitted change, so it cannot
    // produce a partial-DONE dirty write or block the DONE `git merge`.
    //
    // The check is run against the REAL repo working tree: a freshly written
    // owner-lease.json under a real story actives dir must be ignored by git.
    let repoRoot = '';
    try {
      repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      repoRoot = '';
    }
    assert.notEqual(repoRoot, '', 'the smoke runs inside a git repo (needed for the F-008 check)');

    // git check-ignore must report owner-lease.json as ignored at a story path.
    const sampleLeaseRel = '.lattice/story/actives/B-c55d/owner-lease.json';
    let checkIgnoreCode = 1;
    try {
      execFileSync('git', ['check-ignore', '-q', sampleLeaseRel], {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      checkIgnoreCode = 0; // exit 0 → the path IS ignored
    } catch (e: unknown) {
      const status = (e as { status?: number }).status;
      checkIgnoreCode = typeof status === 'number' ? status : 1;
    }
    assert.equal(
      checkIgnoreCode,
      0,
      'git check-ignore confirms .lattice/story/actives/<id>/owner-lease.json is gitignored — it never produces a dirty write before DONE (F-008-class prevention)',
    );

    // The runtime-artifact registry carries the matching glob — the .gitignore
    // pattern and the registry entry are the SAME source of truth.
    assert.equal(
      listRuntimeArtifactIgnorePatterns().includes('**/owner-lease.json'),
      true,
      'the runtime-artifact registry includes the **/owner-lease.json ignore pattern',
    );

    // A real owner-lease.json written into the live tree does NOT appear in
    // `git status --porcelain` (it is ignored, so it is invisible to status).
    const liveStoryDir = join(repoRoot, '.lattice', 'story', 'actives', 'B-c55d');
    if (existsSync(liveStoryDir)) {
      const leaseFile = join(liveStoryDir, OWNER_LEASE_FILE);
      const preExisted = existsSync(leaseFile);
      const savedContent = preExisted ? readFileSync(leaseFile, 'utf-8') : null;
      try {
        process.env.LATTICE_SESSION_ID = 'sess-f008-probe';
        resetSessionIdForTest();
        acquireOwnerLease(liveStoryDir, { command: 'checklist_update', cwd: liveStoryDir });
        const porcelain = execFileSync('git', ['status', '--porcelain'], {
          cwd: repoRoot,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        // B-2d6c: filter to the SPECIFIC probe path (B-c55d/owner-lease.json).
        // The old `.includes('owner-lease.json')` was brittle: it matched ANY
        // owner-lease.json in porcelain — and pre-gitignore-rule story dirs
        // (e.g. the active worktree's own owner-lease.json) can still appear
        // as M (tracked-modified) because they were committed before the
        // `**/owner-lease.json` rule existed. Only the FRESHLY WRITTEN B-c55d
        // probe file is what this assertion is supposed to check.
        const probeRel = 'B-c55d/owner-lease.json';
        assert.equal(
          porcelain.split('\n').some((l) => l.includes(probeRel)),
          false,
          'a freshly written owner-lease.json never appears in git status --porcelain (gitignored runtime artifact)',
        );
      } finally {
        // Restore the tree: remove our probe lease, or put back the original.
        if (preExisted && savedContent !== null) {
          writeFileSync(leaseFile, savedContent, 'utf-8');
        } else if (existsSync(leaseFile)) {
          rmSync(leaseFile, { force: true });
        }
        process.env.LATTICE_SESSION_ID = 'sess-alpha';
        resetSessionIdForTest();
      }
    }
  }

  console.log(
    '✓ story-owner-lease smoke passed (3-source sessionId chain: ppid-bricking regression ' +
    'guard / distinct CLAUDE_CODE ids / LATTICE_SESSION_ID wins / derive fallback + sessionSource / ' +
    'acquire schema incl. sessionSource / heartbeat refresh / release idempotent / ' +
    'acquire-or-refresh acquired+refreshed+foreign / malformed → null + legacy-lease compat / ' +
    'runtime-artifact dirty-write prevention / CHK-003 stale 30min detection + boundary / ' +
    '--takeover transfers stale + logs event / --takeover refuses active / --forceTakeover ' +
    'transfers active + logs event / no-flag no-transfer + no-lease/already-owned guards + ' +
    'invalid-kind rejection / CHK-004 formatNonOwnerError full Error UX field set (stale+active) / ' +
    'summarizeOwnerLease ownership view / renderOwnershipBlock session_brief lines / ' +
    'renderMetaAuditBlock B-META shared audit state / reviewer read-only flow not lease-blocked / ' +
    'CHK-005 doctor stale-lease scan detects+reports stale (no false positive on active) / ' +
    'multi-session: same-story 2nd rejected / different-story both proceed / stale takeover only ' +
    'with --takeover+event / active takeover rejected unless --forceTakeover / session_brief guides ' +
    'non-owner read-only / reviewer read-only + reviewerWrite not lease-blocked / F-008-class ' +
    'owner-lease.json gitignored — never a dirty write)',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
  delete process.env.LATTICE_SESSION_ID;
  resetSessionIdForTest();
}
