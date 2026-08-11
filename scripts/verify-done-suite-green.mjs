#!/usr/bin/env node
/**
 * verify-done-suite-green.mjs — B-cdf6.
 *
 * Runs the root DONE-blocking suite (`npm test`, named by lattice.config.json
 * doneRequiredCommands) and reports its verdict on STDOUT.
 *
 * Why this wrapper exists: the suite's own final confirmation lines are written to
 * STDERR, which the verification-evidence receipt matcher does not capture, so a
 * selector pinned to those lines is refused as absent even on a green run. This
 * wrapper turns the suite's EXIT CODE — the authoritative signal — into a
 * stdout-visible marker, so the evidence receipt is mechanical rather than a
 * caller-authored claim.
 */
import { spawnSync } from 'child_process';
import { execFileSync } from 'child_process';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

const res = spawnSync('npm', ['test'], {
  cwd: repoRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  maxBuffer: 256 * 1024 * 1024,
});

const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`;
const failureLines = combined
  .split('\n')
  .filter(l => /AssertionError|^Error:|FAIL [1-9]/.test(l));

if (res.status !== 0 || failureLines.length > 0) {
  console.log(`DONE-SUITE RED: exit=${res.status} failureLines=${failureLines.length}`);
  for (const l of failureLines.slice(0, 5)) console.log(`  ${l.trim()}`);
  process.exit(1);
}
console.log(`DONE-SUITE GREEN: npm test exit=0, 0 failure lines`);
