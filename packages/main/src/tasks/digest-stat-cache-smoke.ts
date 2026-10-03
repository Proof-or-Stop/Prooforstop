#!/usr/bin/env node

// Regression: every verification evidence row re-read and re-hashed the Node
// executable (about 100 MB) and every file of the Proof-or-Stop implementation,
// so one lifecycle_check spent about 15 of its 27 s hashing unchanged bytes.
// Unchanged files (same device, inode, size, mtime and ctime) must reuse their
// digest within a process; any change must still be observed.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readObservedExecutableDigest } from '../core/executable-digest-observation.js';
import { executionImplementationIdentity } from '../core/execution-implementation.js';

const MARKER = 'unchanged files are re-hashed on every identity observation';

function timed<T>(fn: () => T): { value: T; ms: number } {
  const started = process.hrtime.bigint();
  const value = fn();
  return { value, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

function hashTree(dir: string): number {
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) bytes += hashTree(path);
    else if (entry.isFile()) { const data = readFileSync(path); createHash('sha256').update(data).digest(); bytes += data.length; }
  }
  return bytes;
}

// Warm the page cache and JIT, then time the plain cost of hashing the
// implementation tree once, with no digest reuse, as the yardstick.
const warm = executionImplementationIdentity();
hashTree(warm.implementationRoot);
const plainHash = timed(() => hashTree(warm.implementationRoot));
const observed = timed(() => executionImplementationIdentity());
assert.equal(observed.value.digest, warm.digest, 'the identity is unchanged');
const bigDir = mkdtempSync(join(tmpdir(), 'digest-stat-cache-exe-'));
const big = join(bigDir, 'runtime-executable');
writeFileSync(big, Buffer.alloc(64 * 1024 * 1024, 7)); // a container Node binary is ~100 MB
readObservedExecutableDigest(big);
const exePlain = timed(() => createHash('sha256').update(readFileSync(big)).digest('hex'));
const exeObserved = timed(() => readObservedExecutableDigest(big));
rmSync(bigDir, { recursive: true, force: true });
assert.equal(exeObserved.value, exePlain.value);
assert.ok(observed.ms <= plainHash.ms * 0.6 && exeObserved.ms <= exePlain.ms * 0.25,
  `${MARKER}: identity ${observed.ms.toFixed(0)} ms vs ${plainHash.ms.toFixed(0)} ms to hash the tree; executable ${exeObserved.ms.toFixed(0)} ms vs ${exePlain.ms.toFixed(0)} ms to hash it`);

const dir = mkdtempSync(join(tmpdir(), 'digest-stat-cache-'));
try {
  const file = join(dir, 'tool');
  writeFileSync(file, 'aaaa');
  const before = readObservedExecutableDigest(file);
  writeFileSync(file, 'bbbb');
  const rewritten = readObservedExecutableDigest(file);
  assert.notEqual(rewritten, before, 'a same-size rewrite is observed');
  appendFileSync(file, 'c');
  assert.notEqual(readObservedExecutableDigest(file), rewritten, 'an append is observed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`digest-stat-cache-smoke: PASS (identity ${observed.ms.toFixed(0)} ms vs ${plainHash.ms.toFixed(0)} ms plain hash; executable ${exeObserved.ms.toFixed(0)} ms vs ${exePlain.ms.toFixed(0)} ms)`);
