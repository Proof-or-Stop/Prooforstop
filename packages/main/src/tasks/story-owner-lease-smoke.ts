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
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OWNER_LEASE_FILE,
  acquireOrRefreshOwnerLease,
  acquireOwnerLease,
  getSessionId,
  isOwnedByCurrentSession,
  ownerLeasePath,
  readOwnerLease,
  refreshOwnerLease,
  releaseOwnerLease,
  resetSessionIdForTest,
} from '../core/story-owner-lease.js';
import {
  findRuntimeArtifactEntry,
  isMaterialExcludedRuntimeArtifactPath,
  isVolatileRuntimeArtifactPath,
  listRuntimeArtifactIgnorePatterns,
} from '../core/runtime-artifact-registry.js';

const root = join(tmpdir(), `koala-story-owner-lease-smoke-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });

try {
  // ── 1. sessionId — stable, process-local, env-resolved ───────────────────
  {
    process.env.KOALA_SESSION_ID = 'sess-alpha';
    resetSessionIdForTest();
    const first = getSessionId();
    const second = getSessionId();
    assert.equal(first, 'sess-alpha', 'sessionId resolves from KOALA_SESSION_ID');
    assert.equal(first, second, 'sessionId is memoized — identical on every call');
    // A changed env var does NOT change the memoized id within the process.
    process.env.KOALA_SESSION_ID = 'sess-changed';
    assert.equal(getSessionId(), 'sess-alpha', 'sessionId stays stable for the process lifetime');
    // Fallback id (no session env var) must be stable across simulated koala
    // invocations: it is anchored on the PARENT pid (process.ppid — the agent
    // shell, stable across every short-lived `koala <cmd>` process), NOT
    // process.pid. A pid-anchored fallback would change every invocation and
    // make a session unable to ever refresh its own lease.
    const savedSession = process.env.KOALA_SESSION_ID;
    const savedTerm = process.env.TERM_SESSION_ID;
    delete process.env.KOALA_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.KOALA_ACTIVITY_SESSION;
    delete process.env.TERM_SESSION_ID;
    resetSessionIdForTest();
    const fallback = getSessionId();
    assert.equal(
      fallback, `local-${hostname()}-${process.ppid}`,
      'fallback sessionId is anchored on the parent pid, not the per-invocation pid',
    );
    if (savedTerm !== undefined) process.env.TERM_SESSION_ID = savedTerm;

    // Restore the canonical owner session for the rest of the smoke.
    process.env.KOALA_SESSION_ID = savedSession ?? 'sess-alpha';
    resetSessionIdForTest();
    assert.equal(getSessionId(), process.env.KOALA_SESSION_ID, 'sessionId re-resolves after a test reset');
    process.env.KOALA_SESSION_ID = 'sess-alpha';
    resetSessionIdForTest();
    assert.equal(getSessionId(), 'sess-alpha', 'sessionId re-resolves to the canonical owner');
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

  console.log(
    '✓ story-owner-lease smoke passed (sessionId stable / acquire schema / heartbeat refresh / ' +
    'release idempotent / acquire-or-refresh acquired+refreshed+foreign / malformed → null / ' +
    'runtime-artifact dirty-write prevention)',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
  delete process.env.KOALA_SESSION_ID;
  resetSessionIdForTest();
}
