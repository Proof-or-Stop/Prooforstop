#!/usr/bin/env node

/**
 * Regression for the process-group safety boundary. This test performs no
 * process creation or signalling: it rejects raw negative-PID signals in
 * fixtures and proves that the runner's sole group signal is identity-gated,
 * because -1 has POSIX broadcast semantics.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { killProcessTree } from './full-suite-runner.js';

function source(relativePath: string): string {
  // Resolve from either src/tasks (TypeScript execution) or dist/tasks
  // (compiled execution) to the canonical source tree.
  return readFileSync(new URL(`../../src/${relativePath}`, import.meta.url), 'utf8');
}

function main(): void {
  const providerRegistrySmoke = source('tasks/provider-process-registry-smoke.ts');
  const managedRunSmoke = source('tasks/managed-host-run-smoke.ts');
  const validateProgressSmoke = source('tasks/validate-progress-heartbeat-smoke.ts');
  const fullSuiteRunner = source('tasks/full-suite-runner.ts');
  const hostRun = source('core/host-run.ts');

  assert.doesNotMatch(providerRegistrySmoke, /process\.kill\s*\(\s*-/,
    'provider registry smoke must not issue a negative-PID signal directly');
  assert.doesNotMatch(managedRunSmoke, /process\.kill\s*\(\s*-/,
    'managed host-run smoke must not issue a negative-PID signal directly');
  assert.doesNotMatch(validateProgressSmoke, /process\.kill\s*\(\s*-/,
    'validate progress fixture cleanup must not issue a negative-PID signal directly');
  assert.match(providerRegistrySmoke, /bounded natural exit/,
    'provider registry lifecycle fixtures use bounded natural exit rather than a process-group kill');
  assert.match(managedRunSmoke, /Natural bounded exit/,
    'post-spawn ambiguity fixture uses bounded natural exit rather than a process-group kill');
  assert.match(hostRun, /identity\.pid > 1/,
    'production process-group policy rejects PID 1');
  assert.match(hostRun, /identity\.pgid > 1/,
    'production process-group policy rejects PGID 1');
  assert.match(hostRun, /identity\.pgid === identity\.pid/,
    'production process-group policy requires the isolated leader identity');
  assert.doesNotMatch(fullSuiteRunner, /kill\s*\(\s*-pid\s*,/,
    'full-suite cleanup must not derive a process-group signal from a bare PID');
  assert.match(fullSuiteRunner, /const identityStillMatches = \(\): boolean => identity !== null\s*&& identity\.pid === pid\s*&& readStartFingerprint\(identity\.pid\) === identity\.startFingerprint/,
    'full-suite cleanup records a current PID/start-fingerprint identity predicate');
  assert.match(fullSuiteRunner, /identity\?\.pid === pid\s*&&\s*isSafeIsolatedProviderProcessGroup\(identity\)\s*&&\s*identityStillMatches\(\)/,
    'full-suite group cleanup requires matching PID, isolated PGID, and a fresh start fingerprint');
  assert.doesNotMatch(fullSuiteRunner, /leaderless|isFullSuiteProcessGroupLeaderless/,
    'full-suite cleanup never treats a vanished leader as authority for a negative-PGID signal');
  assert.match(fullSuiteRunner, /kill\(-identity\.pgid, 'SIGKILL'\)/,
    'full-suite group cleanup targets only the verified isolated PGID');
  assert.match(validateProgressSmoke, /refreshProcessStartFingerprint\(identity\.pid\) !== identity\.startFingerprint\) continue;/,
    'fixture direct cleanup revalidates its recorded process identity before signalling');

  const leaderlessCalls: number[] = [];
  const identity = {
    pid: 234,
    pgid: 234,
    spawnedAt: '2026-08-25T00:00:00.000Z',
    startFingerprint: 'safe-fixture-start-fingerprint',
    processGroupIsolated: true,
  };
  killProcessTree(234, pid => { leaderlessCalls.push(pid); }, 'darwin', undefined, identity, () => null);
  assert.deepEqual(leaderlessCalls, [],
    'injected leaderless cleanup issues neither direct nor negative-PGID signal');

  console.log('process-group-signal-safety-smoke PASS');
}

main();
