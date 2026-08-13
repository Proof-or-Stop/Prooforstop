#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { OWNERSHIP_MARKER_FILENAME } from './full-suite-runner.js';

const root = resolve(process.cwd());
const gitCwd = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const runtimeLock = join(root, '.lattice', 'runtime', 'full-suite-runtime-sentinel.lock');
const mainWriteLock = join(root, '.lattice', 'locks', 'full-suite-main-write-sentinel.lock');
const fixedPath = join(root, '.lattice', 'runtime', 'full-suite-fixed-sentinel');
const acquired: string[] = [];
function acquireOwnedDirectory(path: string, token: string): void {
  mkdirSync(path, { recursive: false });
  acquired.push(path);
  const temporary = join(path, `.owner-${process.pid}.tmp`);
  const descriptor = openSync(temporary, 'wx');
  try { writeFileSync(descriptor, `${token}\n`); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, join(path, OWNERSHIP_MARKER_FILENAME));
}
function publishReady(path: string, token: string): void {
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
  mkdirSync(join(root, '.lattice', 'runtime'), { recursive: true });
  mkdirSync(join(root, '.lattice', 'locks'), { recursive: true });
  const ownershipToken = process.env.LATTICE_FULL_SUITE_OWNERSHIP_TOKEN ?? String(process.pid);
  for (const path of [runtimeLock, mainWriteLock, fixedPath]) acquireOwnedDirectory(path, ownershipToken);
  const markerMutation = process.env.LATTICE_FULL_SUITE_SENTINEL_MARKER_MUTATION;
  if (markerMutation === 'missing-runtime') unlinkSync(join(runtimeLock, OWNERSHIP_MARKER_FILENAME));
  else if (markerMutation === 'tampered-main') writeFileSync(join(mainWriteLock, OWNERSHIP_MARKER_FILENAME), 'foreign-token\n');
  const readyFile = process.env.LATTICE_FULL_SUITE_SENTINEL_READY_FILE;
  if (readyFile) publishReady(resolve(readyFile), ownershipToken);
  if (process.env.LATTICE_FULL_SUITE_SENTINEL_PAUSE_AFTER_MARKERS === '1') process.kill(process.pid, 'SIGSTOP');
  const fixedPortCapability = await probeFixedPort();
  const assertions = ['git-common-dir-read', 'fixed-path-owned', 'runtime-lock-owned', 'main-write-lock-owned'];
  if (fixedPortCapability === 'bound') assertions.push('fixed-port-os-bind:43127');
  process.stdout.write(`FULL_SUITE_FIXED_PORT_OS=${fixedPortCapability}\n`);
  process.stdout.write(`LATTICE_FULL_SUITE_SUMMARY=${JSON.stringify({ assertions, mutations: [] })}\n`);
  process.stdout.write('full-suite-resource-sentinel: PASS\n');
} finally {
  for (const path of acquired.reverse()) rmSync(path, { recursive: true, force: true });
}
}
void main().catch(error => { process.stderr.write(`full-suite-resource-sentinel: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
