#!/usr/bin/env node
/**
 * B-c55d CHK-001: unit smoke for core/story-owner-lease.ts.
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
  takeOverOwnerLease,
} from '../core/story-owner-lease.js';
import { readActivityLogTail } from '../core/activity-log.js';
import {
  findRuntimeArtifactEntry,
  isMaterialExcludedRuntimeArtifactPath,
  isVolatileRuntimeArtifactPath,
  listRuntimeArtifactIgnorePatterns,
} from '../core/runtime-artifact-registry.js';

const root = join(tmpdir(), `koala-story-owner-lease-smoke-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });

try {
  // ── 1. sessionId — 3-source chain (KOALA_SESSION_ID / CLAUDE_CODE / derive) ─
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

    // 1c. KOALA_SESSION_ID WINS over CLAUDE_CODE_SESSION_ID — it is the
    // highest-priority canonical override; sessionSource = koala-env.
    const rBoth = resolveSessionIdentity(
      { KOALA_SESSION_ID: 'koala-override-1', CLAUDE_CODE_SESSION_ID: 'claude-sess-AAA' },
      inA,
    );
    assert.equal(rBoth.sessionId, 'koala-override-1', 'KOALA_SESSION_ID wins over CLAUDE_CODE_SESSION_ID');
    assert.equal(rBoth.sessionSource, 'koala-env', 'sessionSource is koala-env when KOALA_SESSION_ID drives the id');
    // Empty / whitespace-only env values are treated as absent (fall through).
    const rEmptyKoala = resolveSessionIdentity(
      { KOALA_SESSION_ID: '   ', CLAUDE_CODE_SESSION_ID: 'claude-sess-AAA' },
      inA,
    );
    assert.equal(rEmptyKoala.sessionSource, 'claude-code-env', 'a whitespace-only KOALA_SESSION_ID is treated as absent');

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
    // process. Set KOALA_SESSION_ID so sections 2+ have a deterministic owner.
    process.env.KOALA_SESSION_ID = 'sess-alpha';
    delete process.env.CLAUDE_CODE_SESSION_ID;
    resetSessionIdForTest();
    assert.equal(getSessionId(), 'sess-alpha', 'getSessionId() wraps the resolver over real process.env');
    assert.equal(getSessionIdentity().sessionSource, 'koala-env', 'getSessionIdentity() reports the resolved source');
    process.env.KOALA_SESSION_ID = 'changed-after';
    assert.equal(getSessionId(), 'sess-alpha', 'getSessionId() stays memoized for the process lifetime');
    process.env.KOALA_SESSION_ID = 'sess-alpha';
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
    assert.equal(lease.sessionSource, 'koala-env', 'lease records sessionSource (koala-env for the KOALA_SESSION_ID owner)');
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
    process.env.KOALA_SESSION_ID = 'sess-bravo';
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
    process.env.KOALA_SESSION_ID = 'sess-alpha';
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
    const sampleLeasePath = '.koala/story/actives/B-c55d/owner-lease.json';
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
    process.env.KOALA_SESSION_ID = 'sess-takeover';
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

    process.env.KOALA_SESSION_ID = 'sess-alpha';
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

    process.env.KOALA_SESSION_ID = 'sess-takeover';
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

    process.env.KOALA_SESSION_ID = 'sess-alpha';
    resetSessionIdForTest();
  }

  // ── 11. CHK-003: --forceTakeover transfers an ACTIVE lease + logs event ──
  {
    const storyDir = join(root, 'forcetakeover-active');
    mkdirSync(storyDir, { recursive: true });

    // Owner = sess-alpha with a FRESH heartbeat (active).
    const freshHeartbeat = '2026-05-19T12:00:00.000Z';
    acquireOwnerLease(storyDir, { command: 'checklist_update', now: () => freshHeartbeat });

    process.env.KOALA_SESSION_ID = 'sess-takeover';
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

    process.env.KOALA_SESSION_ID = 'sess-alpha';
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
    process.env.KOALA_SESSION_ID = 'sess-other';
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

    process.env.KOALA_SESSION_ID = 'sess-alpha';
    resetSessionIdForTest();
  }

  console.log(
    '✓ story-owner-lease smoke passed (3-source sessionId chain: ppid-bricking regression ' +
    'guard / distinct CLAUDE_CODE ids / KOALA_SESSION_ID wins / derive fallback + sessionSource / ' +
    'acquire schema incl. sessionSource / heartbeat refresh / release idempotent / ' +
    'acquire-or-refresh acquired+refreshed+foreign / malformed → null + legacy-lease compat / ' +
    'runtime-artifact dirty-write prevention / CHK-003 stale 30min detection + boundary / ' +
    '--takeover transfers stale + logs event / --takeover refuses active / --forceTakeover ' +
    'transfers active + logs event / no-flag no-transfer + no-lease/already-owned guards + ' +
    'invalid-kind rejection)',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
  delete process.env.KOALA_SESSION_ID;
  resetSessionIdForTest();
}
