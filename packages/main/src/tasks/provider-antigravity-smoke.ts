#!/usr/bin/env node
/**
 * Focused smoke for REAL bounded `provider.antigravity` execution (B-fbb6).
 *
 * Contract-parallel to provider-codex-smoke.ts, exercising the REAL spawn seam:
 * `antigravityCliAvailable` + `runBoundedAntigravityProvider` against an actual
 * temp `agy` binary on PATH. Proves the parts a stub can never prove:
 *
 *   - availability preflight actually resolves the binary on PATH;
 *   - a real spawn captures stdout/stderr as digests + byte counts, exit code,
 *     and duration, and NEVER surfaces raw output (no credential/transcript
 *     leakage);
 *   - stdin is closed so a bounded action cannot hang on an interactive prompt;
 *   - a non-zero exit, a missing binary, and a timeout each classify correctly;
 *   - reportedUsage is NEVER set (agy --print surfaces no per-call token usage).
 *
 * Run: npm run test:legacy -- provider-antigravity
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { antigravityCliAvailable, runBoundedAntigravityProvider } from '../providers/antigravity-cli.js';

const sha256Json = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

const work = mkdtempSync(join(tmpdir(), 'lattice-provider-antigravity-'));
const binDir = join(work, 'bin');
const emptyBinDir = join(work, 'empty-bin');
const projectRoot = join(work, 'project');
for (const dir of [binDir, emptyBinDir, projectRoot]) mkdirSync(dir, { recursive: true });

/** Install a fake `agy` executable that behaves per the embedded script body. */
function installFakeAgy(body: string): void {
  const path = join(binDir, 'agy');
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
}

const STDOUT_MARKER = 'AGY_STDOUT_MARKER_a1b2c3';
const STDERR_MARKER = 'AGY_STDERR_MARKER_d4e5f6';

try {
  // 1. antigravityCliAvailable preflight resolves the real binary on PATH.
  installFakeAgy('exit 0');
  assert.equal(antigravityCliAvailable({ PATH: binDir }), true, 'agy on PATH is available');
  assert.equal(antigravityCliAvailable({ PATH: emptyBinDir }), false, 'agy absent from PATH is unavailable');
  assert.equal(antigravityCliAvailable({}), false, 'no PATH at all is unavailable, never throws');

  // 2. runBoundedAntigravityProvider: REAL spawn capture — digests/bytes/exit/duration.
  installFakeAgy(`printf '%s' '${STDOUT_MARKER}'\nprintf '%s' '${STDERR_MARKER}' 1>&2\nexit 0`);
  const ok = runBoundedAntigravityProvider({
    provider: 'antigravity',
    argv: ['--print', 'implement the task', '--print-timeout', '600s'],
    cwd: projectRoot,
    timeoutMs: 10_000,
    maxAttempts: 1,
    env: { PATH: binDir },
  });
  assert.equal(ok.provider, 'antigravity');
  assert.equal(ok.exitCode, 0, 'clean exit is captured');
  assert.equal(ok.spawnError, false);
  assert.equal(ok.timedOut, false);
  assert.equal(ok.attempts, 1);
  // agy --print surfaces no per-call usage -> reportedUsage must never be set.
  assert.equal(ok.reportedUsage, undefined, 'antigravity never sets reportedUsage (no usageMetadata)');
  assert.equal(ok.stdoutBytes, Buffer.byteLength(STDOUT_MARKER, 'utf8'), 'stdout byte count is captured');
  assert.equal(ok.stderrBytes, Buffer.byteLength(STDERR_MARKER, 'utf8'), 'stderr byte count is captured');
  assert.equal(ok.stdoutDigest, sha256Json(STDOUT_MARKER), 'stdout digest matches sha256(JSON(stdout))');
  assert.equal(ok.stderrDigest, sha256Json(STDERR_MARKER), 'stderr digest matches sha256(JSON(stderr))');
  assert.equal(ok.argvDigest, sha256Json(['--print', 'implement the task', '--print-timeout', '600s']), 'argv digest is over the argv array');
  assert.equal(typeof ok.durationMs, 'number');
  assert.ok(ok.durationMs >= 0, 'duration is recorded');
  // Leakage invariant: raw transcript never escapes.
  const okSerialized = JSON.stringify(ok);
  assert.ok(!okSerialized.includes(STDOUT_MARKER), 'raw stdout must never appear in the provider result');
  assert.ok(!okSerialized.includes(STDERR_MARKER), 'raw stderr must never appear in the provider result');

  // 2b. A best-effort model label on stderr is attributed; otherwise model stays absent.
  installFakeAgy(`printf 'response text only\\n'\nprintf 'label="antigravity-1.0"\\n' 1>&2\nexit 0`);
  const withLabel = runBoundedAntigravityProvider({
    provider: 'antigravity',
    argv: ['--print', 'hi'],
    cwd: projectRoot,
    timeoutMs: 5_000,
    maxAttempts: 1,
    env: { PATH: binDir },
  });
  assert.equal(withLabel.model, 'antigravity-1.0', 'a label="..." token on stderr is parsed as the model');
  assert.equal(withLabel.reportedUsage, undefined, 'still no reportedUsage even with a model label');

  // 3. stdin is closed: a script that blocks on stdin must still terminate.
  installFakeAgy('read LINE\nexit 0');
  const stdinClosed = runBoundedAntigravityProvider({
    provider: 'antigravity',
    argv: ['--print', 'hi'],
    cwd: projectRoot,
    timeoutMs: 5_000,
    maxAttempts: 1,
    env: { PATH: binDir },
  });
  assert.equal(stdinClosed.timedOut, false, 'stdin-closed bounded action does not hang on a prompt');
  assert.equal(stdinClosed.spawnError, false);

  // 4. Non-zero exit is captured terminally (not retried, not promoted to success).
  installFakeAgy(`printf 'boom' 1>&2\nexit 3`);
  const failed = runBoundedAntigravityProvider({
    provider: 'antigravity',
    argv: ['--print', 'hi'],
    cwd: projectRoot,
    timeoutMs: 5_000,
    maxAttempts: 3,
    env: { PATH: binDir },
  });
  assert.equal(failed.exitCode, 3, 'non-zero exit code is captured');
  assert.equal(failed.timedOut, false);
  assert.equal(failed.spawnError, false);
  assert.equal(failed.reportedUsage, undefined, 'error path still sets no reportedUsage');
  assert.equal(failed.attempts, 1, 'a definite non-zero exit is terminal — retries are not burned');

  // 5. Missing binary -> spawnError, exitCode null (fail-closed signal upstream).
  const missing = runBoundedAntigravityProvider({
    provider: 'antigravity',
    argv: ['--print', 'hi'],
    cwd: projectRoot,
    timeoutMs: 5_000,
    maxAttempts: 2,
    env: { PATH: emptyBinDir },
  });
  assert.equal(missing.spawnError, true, 'a missing agy binary is a spawnError');
  assert.equal(missing.exitCode, null, 'spawnError yields a null exit code');
  assert.equal(missing.attempts, 1, 'a missing binary is not retryable');

  // 6. Timeout -> timedOut true (bounded wall-clock is enforced via the kill signal).
  installFakeAgy('while :; do :; done');
  const timed = runBoundedAntigravityProvider({
    provider: 'antigravity',
    argv: ['--print', 'hi'],
    cwd: projectRoot,
    timeoutMs: 250,
    maxAttempts: 1,
    env: { PATH: binDir },
  });
  assert.equal(timed.timedOut, true, 'a bounded timeout is detected from the kill signal');
  assert.equal(timed.attempts, 1);

  console.log('✓ provider antigravity smoke passed: real antigravityCliAvailable preflight; bounded spawn capture (digest/bytes/exit/duration, no raw transcript leakage, no reportedUsage); stdin-closed no-hang; non-zero/missing/timeout classification');
} finally {
  rmSync(work, { recursive: true, force: true });
}
