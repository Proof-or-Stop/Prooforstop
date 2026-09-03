#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
// B-cc10 F-064: derive the sentinel paths from the runtime's own resolver-backed
// helper. A fixture that hand-types the state-dir spelling can set up state at a
// path the runtime stopped reading — the dominant defect class of this migration.
import { OWNERSHIP_MARKER_FILENAME, stateDirKey } from './full-suite-runner.js';

const root = resolve(process.cwd());
const gitCwd = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const runtimeLock = join(root, ...stateDirKey('runtime', 'full-suite-runtime-sentinel.lock').split('/'));
const mainWriteLock = join(root, ...stateDirKey('locks', 'full-suite-main-write-sentinel.lock').split('/'));
const fixedPath = join(root, ...stateDirKey('runtime', 'full-suite-fixed-sentinel').split('/'));
const acquired: string[] = [];
function acquireOwnedDirectory(path: string, token: string): void {
  // B-cc10 F-064: ensure the PARENT exists, then acquire the lock directory itself
  // non-recursively. `recursive: false` on the lock is load-bearing — it is what makes
  // the mkdir an atomic test-and-set, so a second holder fails with EEXIST instead of
  // silently succeeding. Relaxing it to `true` would destroy the exclusivity this
  // sentinel exists to prove. The canonical state dir may not have every subdirectory
  // yet (the deprecated spelling had them), so only the parent is created recursively.
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(path, { recursive: false });
  acquired.push(path);
  const temporary = join(path, `.owner-${process.pid}.tmp`);
  const descriptor = openSync(temporary, 'wx');
  try { writeFileSync(descriptor, `${token}\n`); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, join(path, OWNERSHIP_MARKER_FILENAME));
}
function publishReady(path: string, token: string): void {
  // Same reason as acquireOwnedDirectory: the canonical parent may not exist yet.
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const descriptor = openSync(temporary, 'wx');
  try { writeFileSync(descriptor, `${token}\n`); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, path);
}
async function probeFixedPort(): Promise<'bound' | 'unsupported'> {
  const server = createServer();
  return await new Promise((resolveProbe, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPERM' || error.code === 'EACCES') resolveProbe('unsupported');
      else reject(error);
    });
    server.listen(43127, '127.0.0.1', () => server.close(() => resolveProbe('bound')));
  });
}

async function main(): Promise<void> {
try {
  execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: gitCwd, stdio: 'ignore' });
  // B-cc10 F-067: the parent-dir creation that used to live here hardcoded the DEPRECATED
  // spelling, so once the targets below became resolver-derived it created a stray
  // `.proof-or-stop/runtime` + `.proof-or-stop/locks` pair on every run while the real work happened
  // under the canonical dir. acquireOwnedDirectory()/publishReady() each create their own
  // parent from the resolved path, so no replacement is needed here.
  const ownershipToken = process.env.PROOF_OR_STOP_FULL_SUITE_OWNERSHIP_TOKEN ?? String(process.pid);
  for (const path of [runtimeLock, mainWriteLock, fixedPath]) acquireOwnedDirectory(path, ownershipToken);
  const markerMutation = process.env.PROOF_OR_STOP_FULL_SUITE_SENTINEL_MARKER_MUTATION;
  if (markerMutation === 'missing-runtime') unlinkSync(join(runtimeLock, OWNERSHIP_MARKER_FILENAME));
  else if (markerMutation === 'tampered-main') writeFileSync(join(mainWriteLock, OWNERSHIP_MARKER_FILENAME), 'foreign-token\n');
  const readyFile = process.env.PROOF_OR_STOP_FULL_SUITE_SENTINEL_READY_FILE;
  if (readyFile) publishReady(resolve(readyFile), ownershipToken);
  if (process.env.PROOF_OR_STOP_FULL_SUITE_SENTINEL_PAUSE_AFTER_MARKERS === '1') process.kill(process.pid, 'SIGSTOP');
  const fixedPortCapability = await probeFixedPort();
  const assertions = ['git-common-dir-read', 'fixed-path-owned', 'runtime-lock-owned', 'main-write-lock-owned'];
  if (fixedPortCapability === 'bound') assertions.push('fixed-port-os-bind:43127');
  process.stdout.write(`FULL_SUITE_FIXED_PORT_OS=${fixedPortCapability}\n`);
  process.stdout.write(`PROOF_OR_STOP_FULL_SUITE_SUMMARY=${JSON.stringify({ assertions, mutations: [] })}\n`);
  process.stdout.write('full-suite-resource-sentinel: PASS\n');
} finally {
  for (const path of acquired.reverse()) rmSync(path, { recursive: true, force: true });
}
}
void main().catch(error => { process.stderr.write(`full-suite-resource-sentinel: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
