#!/usr/bin/env node

// Regression: every verification evidence row re-read and re-hashed the Node
// executable (about 100 MB) and every file of the Proof-or-Stop implementation,
// so one lifecycle_check spent about 15 of its 27 s hashing unchanged bytes.
// Unchanged files (same device, inode, size, mtime and ctime) must reuse their
// digest within a process; any change must still be observed.

import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

executionImplementationIdentity(); // warm the page cache and JIT so both measured calls are equal work
const first = timed(() => executionImplementationIdentity());
const second = timed(() => executionImplementationIdentity());
assert.equal(second.value.digest, first.value.digest, 'the identity is unchanged');
const bigDir = mkdtempSync(join(tmpdir(), 'digest-stat-cache-exe-'));
const big = join(bigDir, 'runtime-executable');
writeFileSync(big, Buffer.alloc(64 * 1024 * 1024, 7)); // a container Node binary is ~100 MB
readObservedExecutableDigest(big);
const exeFirst = timed(() => readObservedExecutableDigest(big));
const exeSecond = timed(() => readObservedExecutableDigest(big));
rmSync(bigDir, { recursive: true, force: true });
assert.equal(exeSecond.value, exeFirst.value);
assert.ok(second.ms <= first.ms * 0.6 && exeSecond.ms <= exeFirst.ms * 0.25,
  `${MARKER}: identity ${first.ms.toFixed(0)} -> ${second.ms.toFixed(0)} ms, executable ${exeFirst.ms.toFixed(0)} -> ${exeSecond.ms.toFixed(0)} ms`);

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
console.log(`digest-stat-cache-smoke: PASS (identity ${first.ms.toFixed(0)} -> ${second.ms.toFixed(0)} ms, executable ${exeFirst.ms.toFixed(0)} -> ${exeSecond.ms.toFixed(0)} ms)`);
