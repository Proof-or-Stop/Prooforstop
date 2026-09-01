#!/usr/bin/env node
/**
 * RED (repro-first) for B-74b9 CHK-002.
 *
 * field-regression-cli-smoke.ts's assertReviewRunStartCliSurface calls review_pass_set without
 * --readManifest, which command-catalog.ts now marks required (a `*` required field). The real
 * CLI error is an argument-validation failure ("readManifest: Invalid input: expected object,
 * received undefined"), but the fixture's own assertion expects a completely different message
 * pattern (/already stale|stale/i) -- so it fails on a message mismatch instead of ever
 * exercising the staleness scenario it was written to test. This is fixture staleness, not a
 * production bug: command-catalog.ts's required readManifest is correct as-is.
 *
 * Before the fix: FAILS because the captured CLI output matches the argument-validation message,
 * not the /already stale|stale/i pattern the fixture's own assertion looks for.
 * After the fix (a valid readManifest is passed): PASSES, and the assertion genuinely matches
 * real staleness output.
 *
 * Uses spawnSync with the child's stderr redirected to a real file descriptor (not a pipe) --
 * see red-B-74b9-chk001-acceptance-basis.mjs for why execFileSync's pipe-based capture is
 * unreliable for large synchronous crash dumps on macOS.
 *
 * Run from the repository root:
 *   node packages/main/tests/red/red-B-74b9-chk002-readmanifest.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let repoRoot = here;
while (!existsSync(join(repoRoot, 'proof-or-stop.config.json')) && !existsSync(join(repoRoot, 'proof-or-stop.config.json')) && repoRoot !== dirname(repoRoot)) repoRoot = dirname(repoRoot);
assert.ok(existsSync(join(repoRoot, 'proof-or-stop.config.json')) || existsSync(join(repoRoot, 'proof-or-stop.config.json')), 'could not locate repo root (proof-or-stop.config.json)');

const target = join(repoRoot, 'packages/main/dist/tasks/field-regression-cli-smoke.js');
const captureDir = mkdtempSync(join(tmpdir(), 'red-b74b9-chk002-'));
const stderrPath = join(captureDir, 'stderr.txt');

try {
  const fd = openSync(stderrPath, 'w');
  const result = spawnSync(process.execPath, [target], { cwd: repoRoot, stdio: ['ignore', 'ignore', fd] });
  closeSync(fd);

  const stderr = readFileSync(stderrPath, 'utf8');

  assert.notEqual(result.status, 0, 'RED: field-regression-cli-smoke.js is expected to fail (still exhibits the pre-fix missing --readManifest defect)');
  assert.match(stderr, /readManifest:\s*Invalid input:\s*expected object,\s*received undefined/, 'RED: expected the readManifest argument-validation error');
  assert.match(stderr, /expected:\s*\/already stale\|stale\/i/, 'RED: expected the fixture\'s own stale assertion pattern to appear as the unmet expectation');
  assert.match(stderr, /operator:\s*'match'/, 'RED: expected an assert.match failure (the real staleness scenario was never reached -- argument validation failed first)');

  console.log('RED red-B-74b9-chk002-readmanifest: confirmed pre-fix defect (readManifest argument-validation failure masquerading as a message mismatch)');
} finally {
  rmSync(captureDir, { recursive: true, force: true });
}
