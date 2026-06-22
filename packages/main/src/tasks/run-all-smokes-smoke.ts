#!/usr/bin/env node

/**
 * B-6efb (B1 of test-runner consolidation): self-smoke for run-all-smokes.
 *
 * Verifies the in-house parallel smoke runner correctly:
 *   (a) reports a deliberate-PASS fixture as PASS,
 *   (b) reports a deliberate-FAIL fixture as FAIL with non-zero exit,
 *   (c) honors `--tag <tag>` filtering (no matching tag → 0 smokes),
 *   (d) honors `--select <pattern>` filtering,
 *   (e) honors `--jobs N` (both --jobs 1 and --jobs 4 yield the same result),
 *   (f) honors `skip: true` in the manifest.
 *
 * Strategy: write 2 fixture smoke .js files + a fixture manifest into a tmpdir,
 * then invoke run-all-smokes.js with --smokes-dir + --manifest pointed at the
 * fixtures. The PASS fixture exits 0; the FAIL fixture exits 1.
 *
 * Exit code: 0 on all-assertions-pass, 1 on any assertion failure.
 */

import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RUNNER = resolve(__dirname, 'run-all-smokes.js');

interface RunResult { stdout: string; stderr: string; code: number | null; }

function runRunner(args: string[]): RunResult {
  const r = spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

function setupFixtures(): { root: string; smokesDir: string; manifestPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'run-all-smokes-fixtures-'));
  const smokesDir = join(root, 'smokes');
  mkdirSync(smokesDir, { recursive: true });
  // PASS fixture
  writeFileSync(
    join(smokesDir, 'fixture-pass-smoke.js'),
    `console.log('fixture-pass: ok'); process.exit(0);\n`,
  );
  // FAIL fixture
  writeFileSync(
    join(smokesDir, 'fixture-fail-smoke.js'),
    `console.error('fixture-fail: deliberate failure'); process.exit(1);\n`,
  );
  // SKIP fixture (will be marked skip:true in manifest)
  writeFileSync(
    join(smokesDir, 'fixture-skip-smoke.js'),
    `console.log('fixture-skip: should not run'); process.exit(0);\n`,
  );
  // TAGGED fixture (only runs with --tag selftest)
  writeFileSync(
    join(smokesDir, 'fixture-tagged-smoke.js'),
    `console.log('fixture-tagged: ok'); process.exit(0);\n`,
  );
  const manifestPath = join(root, 'manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      smokes: [
        { name: 'fixture-pass' },
        { name: 'fixture-fail' },
        { name: 'fixture-skip', skip: true },
        { name: 'fixture-tagged', tags: ['selftest'] },
      ],
    }, null, 2),
  );
  return { root, smokesDir, manifestPath };
}

interface Check { name: string; ok: boolean; details?: string; }
const checks: Check[] = [];

function assert(name: string, condition: boolean, details?: string): void {
  checks.push({ name, ok: condition, details });
}

function main(): void {
  const { root, smokesDir, manifestPath } = setupFixtures();
  try {
    // (1) Without filters: 3 smokes run (fixture-skip excluded by manifest),
    //     fixture-fail makes the run non-zero.
    const passOnly = runRunner([
      '--smokes-dir', smokesDir,
      '--manifest', manifestPath,
      '--select', 'fixture-pass',
    ]);
    assert(
      'fixture-pass selected alone exits 0',
      passOnly.code === 0,
      `code=${passOnly.code}, stdout=${passOnly.stdout.trim()}, stderr=${passOnly.stderr.trim()}`,
    );
    assert(
      'fixture-pass output contains "PASS fixture-pass"',
      passOnly.stdout.includes('PASS fixture-pass'),
      `stdout was: ${passOnly.stdout.trim()}`,
    );

    // (2) fixture-fail alone → non-zero exit + FAIL line
    const failOnly = runRunner([
      '--smokes-dir', smokesDir,
      '--manifest', manifestPath,
      '--select', 'fixture-fail',
    ]);
    assert(
      'fixture-fail selected alone exits non-zero (fail-loudly guarantee)',
      failOnly.code !== 0,
      `code=${failOnly.code}, stdout=${failOnly.stdout.trim()}`,
    );
    assert(
      'fixture-fail output contains "FAIL fixture-fail"',
      failOnly.stdout.includes('FAIL fixture-fail'),
      `stdout was: ${failOnly.stdout.trim()}`,
    );

    // (3) --tag missing-tag returns 0 smokes
    const missingTag = runRunner([
      '--smokes-dir', smokesDir,
      '--manifest', manifestPath,
      '--tag', 'no-such-tag',
    ]);
    assert(
      '--tag with no match returns 0 smokes (exit 0)',
      missingTag.code === 0 && missingTag.stdout.includes('0 smokes matched filters'),
      `code=${missingTag.code}, stdout=${missingTag.stdout.trim()}`,
    );

    // (4) --tag selftest selects exactly fixture-tagged
    const tagged = runRunner([
      '--smokes-dir', smokesDir,
      '--manifest', manifestPath,
      '--tag', 'selftest',
    ]);
    assert(
      '--tag selftest selects fixture-tagged only (exit 0)',
      tagged.code === 0 && tagged.stdout.includes('PASS fixture-tagged') && !tagged.stdout.includes('fixture-pass') && !tagged.stdout.includes('fixture-fail'),
      `code=${tagged.code}, stdout=${tagged.stdout.trim()}`,
    );

    // (5) --jobs 1 and --jobs 4 produce the same final code on the PASS fixture
    const jobs1 = runRunner([
      '--smokes-dir', smokesDir,
      '--manifest', manifestPath,
      '--select', 'fixture-pass',
      '--jobs', '1',
    ]);
    const jobs4 = runRunner([
      '--smokes-dir', smokesDir,
      '--manifest', manifestPath,
      '--select', 'fixture-pass',
      '--jobs', '4',
    ]);
    assert(
      '--jobs 1 and --jobs 4 produce the same exit code',
      jobs1.code === jobs4.code,
      `jobs1.code=${jobs1.code}, jobs4.code=${jobs4.code}`,
    );

    // (6) skip:true is honored — fixture-skip never runs even without filters
    const noFilter = runRunner([
      '--smokes-dir', smokesDir,
      '--manifest', manifestPath,
    ]);
    assert(
      'fixture-skip is skipped via skip:true manifest entry',
      !noFilter.stdout.includes('PASS fixture-skip') && !noFilter.stdout.includes('FAIL fixture-skip'),
      `stdout was: ${noFilter.stdout.trim()}`,
    );

    // (7) Directory-scan fallback: a smoke on disk but NOT in manifest is still discovered.
    //     Our fixtures-dir contains fixture-pass/fail/skip/tagged. fixture-tagged is in
    //     manifest. Add an unlisted fixture and verify it runs without filters.
    writeFileSync(
      join(smokesDir, 'fixture-unlisted-smoke.js'),
      `console.log('fixture-unlisted: ok'); process.exit(0);\n`,
    );
    const unlisted = runRunner([
      '--smokes-dir', smokesDir,
      '--manifest', manifestPath,
      '--select', 'unlisted',
    ]);
    assert(
      'directory-scan discovers smokes missing from manifest',
      unlisted.code === 0 && unlisted.stdout.includes('PASS fixture-unlisted'),
      `code=${unlisted.code}, stdout=${unlisted.stdout.trim()}`,
    );

    // ──────────────────────────────────────────────────────────────────────
    // B-2941: 4 fixture cases for two-pass retry behavior.
    // ──────────────────────────────────────────────────────────────────────
    // Flaky fixture: times out on first run (sleeps past 500ms timeout), passes on
    // second run (sees a lock file left by the first attempt and exits 0). This
    // simulates a parallel-load race that resolves under serial retry.
    const lockA = join(root, 'flaky-A.lock');
    writeFileSync(
      join(smokesDir, 'fixture-flaky-A-smoke.js'),
      `const fs=require('fs'); if(fs.existsSync(${JSON.stringify(lockA)})){ fs.unlinkSync(${JSON.stringify(lockA)}); process.exit(0); } fs.writeFileSync(${JSON.stringify(lockA)},'1'); setTimeout(()=>process.exit(0), 60000);\n`,
    );
    // noRetry fixture: same flaky pattern but manifest noRetry=true blocks pass 2.
    const lockB = join(root, 'flaky-B.lock');
    writeFileSync(
      join(smokesDir, 'fixture-flaky-B-smoke.js'),
      `const fs=require('fs'); if(fs.existsSync(${JSON.stringify(lockB)})){ fs.unlinkSync(${JSON.stringify(lockB)}); process.exit(0); } fs.writeFileSync(${JSON.stringify(lockB)},'1'); setTimeout(()=>process.exit(0), 60000);\n`,
    );
    // Always-fails fixture: times out on every run (no lock dance).
    writeFileSync(
      join(smokesDir, 'fixture-always-timeout-smoke.js'),
      `setTimeout(()=>process.exit(0), 60000);\n`,
    );
    // B-348d FAIL-flaky fixture: exit 1 (a FAIL, NOT a timeout) on the first run,
    // exit 0 on the second (lock dance). Manifest flags it retryOnAnyFailure:true,
    // so pass 2 must retry it on the FAIL and it then passes.
    const lockC = join(root, 'flaky-C.lock');
    writeFileSync(
      join(smokesDir, 'fixture-failflaky-C-smoke.js'),
      `const fs=require('fs'); if(fs.existsSync(${JSON.stringify(lockC)})){ fs.unlinkSync(${JSON.stringify(lockC)}); process.exit(0); } fs.writeFileSync(${JSON.stringify(lockC)},'1'); console.error('flaky-C: deliberate first-run FAIL'); process.exit(1);\n`,
    );
    // B-348d hard-fail fixture: exit 1 on EVERY run, NOT flagged retryOnAnyFailure.
    // This is the anti-masking safety case: a FAIL without the flag must stay
    // terminal (never retried), so a genuine regression always surfaces.
    writeFileSync(
      join(smokesDir, 'fixture-hardfail-D-smoke.js'),
      `console.error('hard-fail-D: deliberate FAIL on every run'); process.exit(1);\n`,
    );
    // B-348d hard-fail-flagged fixture: exit 1 on EVERY run, flagged retryOnAnyFailure:true.
    // Proves the invariant "flagged smoke that FAILs BOTH passes still ends in a final FAIL":
    // it IS retried in pass 2 (because flagged), but the retry also fails → terminal FAIL.
    writeFileSync(
      join(smokesDir, 'fixture-hardfail-flagged-E-smoke.js'),
      `console.error('hard-fail-flagged-E: deliberate FAIL on every run'); process.exit(1);\n`,
    );
    const retryManifestPath = join(root, 'retry-manifest.json');
    writeFileSync(
      retryManifestPath,
      JSON.stringify({
        smokes: [
          { name: 'fixture-flaky-A', timeoutMs: 500 },
          { name: 'fixture-flaky-B', timeoutMs: 500, noRetry: true },
          { name: 'fixture-always-timeout', timeoutMs: 500 },
          { name: 'fixture-failflaky-C', timeoutMs: 5000, retryOnAnyFailure: true },
          { name: 'fixture-hardfail-D', timeoutMs: 5000 },
          { name: 'fixture-hardfail-flagged-E', timeoutMs: 5000, retryOnAnyFailure: true },
        ],
      }, null, 2),
    );

    // (8) B-2941 case (a): flaky smoke times out in pass 1, retried in pass 2, passes.
    const retryPass = runRunner([
      '--smokes-dir', smokesDir,
      '--manifest', retryManifestPath,
      '--select', 'fixture-flaky-A',
    ]);
    assert(
      'B-2941 (a): pass 1 timeout → pass 2 retry → PASS, Final 1/1 exit 0',
      retryPass.code === 0
        && retryPass.stdout.includes('Pass 1:')
        && retryPass.stdout.includes('retrying serially')
        && retryPass.stdout.includes('Final:')
        && /Final:\s*1\/1/.test(retryPass.stdout),
      `code=${retryPass.code}, stdout=${retryPass.stdout.trim()}`,
    );

    // (9) B-2941 case (b): noRetry=true smoke that times out stays TIMEOUT (no pass 2 for it).
    const noRetryFlag = runRunner([
      '--smokes-dir', smokesDir,
      '--manifest', retryManifestPath,
      '--select', 'fixture-flaky-B',
    ]);
    assert(
      'B-2941 (b): noRetry=true smoke that times out stays TIMEOUT, exit 1',
      noRetryFlag.code === 1
        && noRetryFlag.stdout.includes('TIMEOUT fixture-flaky-B')
        && !noRetryFlag.stdout.includes('Final:'),
      `code=${noRetryFlag.code}, stdout=${noRetryFlag.stdout.trim()}`,
    );

    // (10) B-2941 case (c): --no-retry CLI flag disables pass 2 entirely.
    // The flaky-A fixture writes a lock if absent (first run will timeout),
    // recreating the cycle. After case 8 consumed the lock, this run starts
    // fresh and will time out without retry under --no-retry.
    const cliNoRetry = runRunner([
      '--smokes-dir', smokesDir,
      '--manifest', retryManifestPath,
      '--select', 'fixture-flaky-A',
      '--no-retry',
    ]);
    assert(
      'B-2941 (c): --no-retry CLI flag → pass 1 only, exit 1 on timeout',
      cliNoRetry.code === 1
        && cliNoRetry.stdout.includes('TIMEOUT fixture-flaky-A')
        && !cliNoRetry.stdout.includes('Pass 2:')
        && !cliNoRetry.stdout.includes('Final:'),
      `code=${cliNoRetry.code}, stdout=${cliNoRetry.stdout.trim()}`,
    );

    // (11) B-2941 case (d): smoke fails BOTH passes → Final FAIL exit 1.
    const failBoth = runRunner([
      '--smokes-dir', smokesDir,
      '--manifest', retryManifestPath,
      '--select', 'fixture-always-timeout',
    ]);
    assert(
      'B-2941 (d): smoke that times out BOTH passes → Final 0/1, exit 1',
      failBoth.code === 1
        && failBoth.stdout.includes('Pass 1:')
        && failBoth.stdout.includes('retrying serially')
        && failBoth.stdout.includes('Final:')
        && /Final:\s*0\/1/.test(failBoth.stdout),
      `code=${failBoth.code}, stdout=${failBoth.stdout.trim()}`,
    );

    // (12) B-348d (a): a FAIL (exit 1, not timeout) on a retryOnAnyFailure-flagged
    //      smoke is retried in pass 2 and passes → Final 1/1 exit 0.
    const failFlakyRetry = runRunner([
      '--smokes-dir', smokesDir,
      '--manifest', retryManifestPath,
      '--select', 'fixture-failflaky-C',
    ]);
    assert(
      'B-348d (a): retryOnAnyFailure smoke FAILs pass 1 → retried → PASS, Final 1/1 exit 0',
      failFlakyRetry.code === 0
        && failFlakyRetry.stdout.includes('retrying serially')
        && failFlakyRetry.stdout.includes('Final:')
        && /Final:\s*1\/1/.test(failFlakyRetry.stdout),
      `code=${failFlakyRetry.code}, stdout=${failFlakyRetry.stdout.trim()}`,
    );

    // (13) B-348d (b) — ANTI-MASKING SAFETY: a FAIL on a smoke WITHOUT the flag is
    //      NOT retried (stays terminal), so a genuine regression always surfaces.
    const hardFailNoRetry = runRunner([
      '--smokes-dir', smokesDir,
      '--manifest', retryManifestPath,
      '--select', 'fixture-hardfail-D',
    ]);
    assert(
      'B-348d (b): unflagged FAIL is NOT retried (terminal) → exit 1, no pass 2',
      hardFailNoRetry.code === 1
        && hardFailNoRetry.stdout.includes('FAIL fixture-hardfail-D')
        && !hardFailNoRetry.stdout.includes('retrying serially')
        && !hardFailNoRetry.stdout.includes('Final:'),
      `code=${hardFailNoRetry.code}, stdout=${hardFailNoRetry.stdout.trim()}`,
    );

    // (14) B-348d (c) — ANTI-MASKING SAFETY (flagged both-passes): a FAIL on a smoke
    //      WITH the flag IS retried in pass 2, but when the retry also FAILs the suite
    //      stays terminal (Final 0/1, exit 1). Retry must never mask a genuine regression.
    const flaggedFailBoth = runRunner([
      '--smokes-dir', smokesDir,
      '--manifest', retryManifestPath,
      '--select', 'fixture-hardfail-flagged-E',
    ]);
    assert(
      'B-348d (c): flagged FAIL retried but fails both passes → Final 0/1, exit 1',
      flaggedFailBoth.code === 1
        && flaggedFailBoth.stdout.includes('retrying serially')
        && flaggedFailBoth.stdout.includes('Final:')
        && /Final:\s*0\/1/.test(flaggedFailBoth.stdout),
      `code=${flaggedFailBoth.code}, stdout=${flaggedFailBoth.stdout.trim()}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  let failed = 0;
  for (const c of checks) {
    if (c.ok) {
      process.stdout.write(`✓ ${c.name}\n`);
    } else {
      failed++;
      process.stdout.write(`✗ ${c.name}\n`);
      if (c.details) process.stdout.write(`  ${c.details}\n`);
    }
  }
  process.stdout.write(`\n${checks.length - failed}/${checks.length} checks passed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
