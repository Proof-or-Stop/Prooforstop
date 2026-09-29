#!/usr/bin/env node

// Regression: every CLI call recompiled the whole ESM module graph (about
// 1.7 s of a 2 s `--version` inside the x86 benchmark container), and a Story
// owner makes hundreds of sequential calls. The entry must enable Node's
// on-disk compile cache before loading that graph.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const MARKER = 'CLI does not enable the Node compile cache';
const tmp = mkdtempSync(join(tmpdir(), 'cli-compile-cache-'));
try {
  const env = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  delete (env as Record<string, string | undefined>).NODE_COMPILE_CACHE;
  delete (env as Record<string, string | undefined>).NODE_DISABLE_COMPILE_CACHE;
  const version = execFileSync(process.execPath, [CLI, '--version'], { env, encoding: 'utf8' });
  assert.match(version, /Proof-or-Stop \d+\.\d+\.\d+/);
  const cacheDir = join(tmp, 'node-compile-cache');
  assert.ok(existsSync(cacheDir) && readdirSync(cacheDir).length > 0, `${MARKER}: ${cacheDir} was not populated`);
  const again = execFileSync(process.execPath, [CLI, '--version'], { env, encoding: 'utf8' });
  assert.equal(again, version, 'a cached start prints the same version');
  const disabled = mkdtempSync(join(tmpdir(), 'cli-compile-cache-off-'));
  try {
    execFileSync(process.execPath, [CLI, '--version'], { env: { ...env, TMPDIR: disabled, NODE_DISABLE_COMPILE_CACHE: '1' }, encoding: 'utf8' });
    assert.ok(!existsSync(join(disabled, 'node-compile-cache')), 'NODE_DISABLE_COMPILE_CACHE keeps the cache off');
  } finally {
    rmSync(disabled, { recursive: true, force: true });
  }
  console.log('cli-compile-cache-smoke: PASS');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
