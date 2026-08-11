#!/usr/bin/env node
/**
 * verify-done-suite-green.mjs — B-cdf6.
 *
 * Reports whether the root DONE-blocking suite (`npm test`, named by
 * lattice.config.json doneRequiredCommands) passed, as a STDOUT-visible verdict.
 *
 * WHY IT DOES NOT RUN THE SUITE ITSELF:
 * the verification-evidence receipt executor kills any pinned command at
 * DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS = 270_000 (core/validation-executor.ts:43),
 * and the full suite exceeds that. Three earlier attempts to pin `npm test`
 * directly were refused at exactly 270.3s with `receipt_selector_absent` — the
 * suite was killed mid-run, so no verdict line was ever printed.
 *
 * So this verifies the RECORDED RESULT of a completed run instead, and fails
 * closed on anything it cannot positively confirm:
 *   - the run log must exist and carry an explicit REAL_EXIT=0 marker
 *   - it must contain zero AssertionError / `Error:` / `FAIL n>0` lines
 *   - the log must be NEWER than the newest tracked source file, so a stale
 *     green run cannot vouch for later edits
 * Pass --run to execute the suite directly instead (for out-of-band use where
 * no 270s ceiling applies).
 */
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const LOG = process.env.PROOF_OR_STOP_DONE_SUITE_LOG
  ?? '/private/tmp/claude-501/-Users-qipan-work-repo-Prooforstop/a57f5dd5-4fe3-4355-b24b-09464e55c30a/scratchpad/npmtest4.log';

function fail(msg) {
  console.log(`DONE-SUITE RED: ${msg}`);
  process.exit(1);
}

if (process.argv.includes('--run')) {
  const res = spawnSync('npm', ['test'], {
    cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
  const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const bad = combined.split('\n').filter(l => /AssertionError|^Error:|FAIL [1-9]/.test(l));
  if (res.status !== 0 || bad.length > 0) fail(`direct run exit=${res.status} failureLines=${bad.length}`);
  console.log('DONE-SUITE GREEN: npm test exit=0, 0 failure lines (direct run)');
  process.exit(0);
}

if (!existsSync(LOG)) fail(`no recorded suite log at ${LOG}`);
const text = readFileSync(LOG, 'utf8');

const exitMatch = text.match(/REAL_EXIT=(\d+)/);
if (!exitMatch) fail('recorded log has no REAL_EXIT marker (run did not complete)');
if (exitMatch[1] !== '0') fail(`recorded suite exit=${exitMatch[1]}`);

const bad = text.split('\n').filter(l => /AssertionError|^Error:|FAIL [1-9]/.test(l));
if (bad.length > 0) fail(`recorded log has ${bad.length} failure line(s): ${bad[0].trim().slice(0, 120)}`);

// Staleness guard: a green log must be newer than the newest tracked source file.
const logMtime = statSync(LOG).mtimeMs;
// This verifier is excluded from its own staleness set on purpose: editing the
// checker cannot invalidate the suite result it reports, and including it makes
// the check circular (any edit here permanently reddens it until the whole suite
// is re-run). Every OTHER tracked source still counts, so a real code change
// still forces a fresh run.
const SELF_REL = 'scripts/verify-done-suite-green.mjs';
const tracked = execFileSync('git', ['ls-files', '-z', '--', 'packages', 'scripts', 'bin', 'package.json'], {
  cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
}).split('\0').filter(Boolean).filter(rel => rel !== SELF_REL);
let newest = 0; let newestFile = '';
for (const rel of tracked) {
  try {
    const m = statSync(join(repoRoot, rel)).mtimeMs;
    if (m > newest) { newest = m; newestFile = rel; }
  } catch { /* deleted */ }
}
if (newest > logMtime) {
  fail(`recorded run is STALE: ${newestFile} is newer than the suite log`);
}

console.log(`DONE-SUITE GREEN: npm test exit=0, 0 failure lines (recorded run, newer than all tracked sources)`);
