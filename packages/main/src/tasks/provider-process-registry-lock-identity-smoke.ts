#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyProviderRegistryLock } from '../core/provider-process-registry.js';
import { acquireMkdirLock, MKDIR_LOCK_HOLDER_FILE, type ExistingMkdirLockSnapshot } from '../core/mkdir-lock.js';

const foreignPid = process.pid + 100_000_000;
const snapshot = (processStartTimeMs?: number): ExistingMkdirLockSnapshot => ({
  lockDir: '/safe/test/lock',
  ageMs: 1,
  staleMs: 10_000,
  nowMs: 1_000_000,
  holder: {
    pid: foreignPid,
    hostname: hostname(),
    command: 'foreign provider registry holder',
    acquiredAt: '2026-08-24T00:00:00.000Z',
    lockId: 'foreign-holder-token',
    ...(processStartTimeMs === undefined ? {} : { processStartTimeMs }),
  },
});

assert.equal(
  classifyProviderRegistryLock(snapshot(100_000), {
    inspectPid: () => 'active',
    observeProcessStartTimeMs: () => 200_000,
  }),
  'stale',
  'a reused foreign PID with a different observed start identity must be reclaimed',
);
assert.equal(
  classifyProviderRegistryLock(snapshot(100_000), {
    inspectPid: () => 'active',
    observeProcessStartTimeMs: () => 101_000,
  }),
  'active',
  'the bounded ps-resolution tolerance preserves a matching foreign holder',
);
assert.equal(
  classifyProviderRegistryLock(snapshot(100_000), {
    inspectPid: () => 'active',
    observeProcessStartTimeMs: () => undefined,
  }),
  'active',
  'a live PID with an unavailable start-time observation remains non-reclaimable',
);
assert.equal(
  classifyProviderRegistryLock(snapshot(), {
    inspectPid: () => 'active',
  }),
  'active',
  'legacy holders without a recorded start identity retain the conservative active classification',
);

const root = mkdtempSync(join(tmpdir(), 'provider-registry-lock-identity-'));
const agedLockDir = join(root, 'provider-registry.lock');
try {
  mkdirSync(agedLockDir);
  writeFileSync(join(agedLockDir, MKDIR_LOCK_HOLDER_FILE), JSON.stringify(snapshot(100_000).holder));
  // The generic mkdir lock would normally reclaim an unknown holder at this age.
  utimesSync(agedLockDir, new Date(1), new Date(1));
  assert.throws(
    () => acquireMkdirLock(agedLockDir, {
      label: 'provider registry live identity smoke',
      deadlineMs: 100,
      staleMs: 1,
      pollMs: 1,
      failFastIfHeld: true,
      classifyExistingLock: (candidate) => classifyProviderRegistryLock(candidate, {
        inspectPid: () => 'active',
        observeProcessStartTimeMs: () => undefined,
      }),
    }),
    /provider registry live identity smoke lock is held/,
    'an aged live holder with an unavailable identity observation must not be reclaimed',
  );
  assert.equal(existsSync(agedLockDir), true, 'the non-reclaimable live holder must remain intact');
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
}

console.log('provider-process-registry-lock-identity-smoke PASS');
