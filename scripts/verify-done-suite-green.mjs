#!/usr/bin/env node
/**
 * verify-done-suite-green.mjs — B-cdf6.
 *
 * Runs the root DONE-blocking suite (`npm test`, named by proof-or-stop.config.json
 * doneRequiredCommands) and reports a STDOUT-visible verdict, because the suite's
 * own confirmation lines go to stderr where a receipt matcher cannot see them.
 *
 * HISTORY / WHY IT IS SHAPED THIS WAY (B-cdf6:F-006, critical, raised by the
 * test-coverage reviewer against the main agent's own first version):
 *
 * The first version did NOT run the suite. It read a previously-recorded run log
 * and checked it for a `REAL_EXIT=0` marker, because the verification-evidence
 * receipt executor kills any pinned command at DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS
 * = 270_000 (core/validation-executor.ts:43) and the suite exceeds that. That
 * design had two defects the reviewer proved by direct execution:
 *
 *   1. NOT REPRODUCIBLE — the default log path was an absolute path inside the
 *      authoring session's own scratchpad, untracked and machine-local. Any other
 *      reviewer, a fresh clone, or CI running the same recorded command would get
 *      RED (missing log), not the recorded PASS.
 *   2. CONTENT-BLIND — it verified a MARKER, not a RUN. A two-line stub containing
 *      only `REAL_EXIT=0` produced an identical "DONE-SUITE GREEN" verdict. The
 *      main agent reproduced this independently and confirmed it.
 *
 * So log-reading is gone. This script now always executes the suite. That means it
 * CANNOT be used as a receipt-pinned command (it will exceed the 270s ceiling and
 * be killed); it is an out-of-band verifier, and the evidence row for the suite
 * must say so plainly rather than claim a mechanical receipt it did not earn.
 * The framework gap itself is recorded as B-META-framework-audit:F-012.
 */
import { execFileSync, spawnSync } from 'child_process';

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

// Positive-evidence guard: a genuine run emits many stage lines. A truncated or
// stubbed run must not read as green just because it lacked failure lines.
const stageLines = combined.split('\n').filter(l => /^[>✓]|smoke|PASS|assertions/.test(l)).length;
const MIN_STAGE_LINES = 20;

if (res.status !== 0) {
  console.log(`DONE-SUITE RED: npm test exit=${res.status}`);
  // Surface WHY it is red. A bare exit code is useless to the next reader: npm chains
  // ~47 steps with `&&`, so the failing step must be named. failureLines only catches
  // AssertionError / `Error:` / `FAIL n>0`, and several verifiers fail with none of those
  // (e.g. 'Process fact contract failed:' followed by bullet lines), so fall back to the
  // tail of combined output when no failure line matched.
  if (failureLines.length > 0) {
    for (const l of failureLines.slice(0, 8)) console.log(`  ${l.trim()}`);
  } else {
    const tail = combined.trimEnd().split('\n').slice(-15);
    console.log('  (no AssertionError/Error:/FAIL line matched; last 15 lines of output)');
    for (const l of tail) console.log(`  ${l}`);
  }
  process.exit(1);
}
if (failureLines.length > 0) {
  console.log(`DONE-SUITE RED: exit=0 but ${failureLines.length} failure line(s)`);
  for (const l of failureLines.slice(0, 5)) console.log(`  ${l.trim()}`);
  process.exit(1);
}
if (stageLines < MIN_STAGE_LINES) {
  console.log(`DONE-SUITE RED: only ${stageLines} stage line(s) observed (< ${MIN_STAGE_LINES}); suite did not really run`);
  process.exit(1);
}

console.log(`DONE-SUITE GREEN: npm test exit=0, 0 failure lines, ${stageLines} stage lines observed`);
