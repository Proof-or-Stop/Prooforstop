#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.cwd());
const runtimeLock = join(root, '.lattice', 'runtime', 'full-suite-runtime-sentinel.lock');
const mainWriteLock = join(root, '.lattice', 'locks', 'full-suite-main-write-sentinel.lock');
const fixedPath = join(root, '.lattice', 'runtime', 'full-suite-fixed-sentinel');
const acquired: string[] = [];
try {
  execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, stdio: 'ignore' });
  mkdirSync(join(root, '.lattice', 'runtime'), { recursive: true });
  mkdirSync(join(root, '.lattice', 'locks'), { recursive: true });
  for (const path of [runtimeLock, mainWriteLock, fixedPath]) { mkdirSync(path, { recursive: false }); acquired.push(path); }
  writeFileSync(join(fixedPath, 'owner'), `${process.pid}\n`);
  process.stdout.write(`LATTICE_FULL_SUITE_SUMMARY=${JSON.stringify({ assertions: ['git-common-dir-read', 'fixed-path-owned', 'runtime-lock-owned', 'main-write-lock-owned', 'fixed-port-resource-key:43127'], mutations: [] })}\n`);
  process.stdout.write('full-suite-resource-sentinel: PASS\n');
} finally {
  for (const path of acquired.reverse()) rmSync(path, { recursive: true, force: true });
}
