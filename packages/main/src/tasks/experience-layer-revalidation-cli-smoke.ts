#!/usr/bin/env node
/**
 * B-a2e3 CHK-003/CHK-004: CLI smoke for the Experience Layer referential
 * re-validation command (`learning_validate`).
 *
 * The leaf smoke (experience-layer-revalidation-smoke.ts) is hermetic and never
 * touches the CLI; this smoke closes that gap by driving the REAL user-facing
 * path — `node bin/lattice.js learning_validate ...` from the repo root — and
 * asserting:
 *   - the human report prints both "valid-rate" and "drift-rate" lines;
 *   - `--json` emits a parseable ValidRateReport (numeric counters + rates + a
 *     staleSignals array);
 *   - `--story <real DONE id>` restricts derivation without crashing;
 *   - `--story <nonexistent>` yields an empty report (total/validRate/driftRate 0)
 *     without crashing;
 *   - NOTHING is written: no `.lattice/learning` path or `activity.jsonl` appears
 *     in `git status --porcelain` (the read-only contract this story is about).
 *
 * The lattice CLI prints leading log lines to stderr, so stdout is the clean
 * report/JSON; for JSON we still slice from the first `{` defensively. Prints
 * `cli smoke passed` on success; exits non-zero on any failed assertion.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** A real DONE/closed story id used to exercise the --story restriction path. */
const REAL_STORY_ID = 'B-7561';
const NONEXISTENT_STORY_ID = 'B-zzzz';

let total = 0;
let passed = 0;
function check(label: string, fn: () => void): void {
  total += 1;
  try {
    fn();
    passed += 1;
    console.log(`check: ${label} — PASS`);
  } catch (err) {
    console.error(`check: ${label} — FAIL`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  }
}

/** Locate the repo root robustly (independent of the dist/ run cwd). */
function repoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
}

const ROOT = repoRoot();
const CLI = join(ROOT, 'bin', 'lattice.js');

/** Run `node bin/lattice.js <command> [jsonArgs]` from the repo root; return stdout. */
function runCli(command: string, jsonArgs?: string): string {
  const argv = [CLI, command];
  if (jsonArgs !== undefined) argv.push(jsonArgs);
  return execFileSync('node', argv, {
    cwd: ROOT,
    encoding: 'utf-8',
    // stdout = clean report/JSON; the CLI's leading log lines go to stderr.
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Slice a JSON object out of stdout defensively (first `{` .. last `}`). */
function parseJsonObject(out: string): Record<string, unknown> {
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  assert.ok(start >= 0 && end > start, `no JSON object in output: ${out.slice(0, 200)}`);
  return JSON.parse(out.slice(start, end + 1)) as Record<string, unknown>;
}

/** `git status --porcelain` from the repo root (the set of dirty/new paths). */
function porcelain(): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf-8' });
}

/** Paths newly introduced (or changed) between two porcelain snapshots. */
function newDirtyLines(before: string, after: string): string[] {
  const beforeSet = new Set(before.split('\n').map((l) => l.trim()).filter(Boolean));
  return after.split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !beforeSet.has(l));
}

function run(): void {
  assert.ok(existsSync(CLI), `bin/lattice.js not found at ${CLI}`);

  // Snapshot the working tree BEFORE any CLI run (read-only assertion baseline).
  const before = porcelain();

  // ─── HUMAN: report prints valid-rate + drift-rate ───────────────────────────
  check('cli: learning_validate human output has valid-rate and drift-rate lines', () => {
    const out = runCli('learning_validate');
    assert.match(out, /valid-rate/, 'human output mentions valid-rate');
    assert.match(out, /drift-rate/, 'human output mentions drift-rate');
    assert.match(out, /Experience Layer — referential validity/, 'human header present');
  });

  // ─── JSON: parseable ValidRateReport with numeric fields + staleSignals array ─
  check('cli: learning_validate --json emits a numeric ValidRateReport', () => {
    const report = parseJsonObject(runCli('learning_validate', '{"json":true}'));
    for (const field of ['total', 'anchored', 'valid', 'stale', 'unanchored', 'validRate', 'driftRate']) {
      assert.equal(typeof report[field], 'number', `${field} is numeric`);
      assert.ok(!Number.isNaN(report[field] as number), `${field} not NaN`);
    }
    assert.ok(Array.isArray(report.staleSignals), 'staleSignals is an array');
    // Internal consistency: anchored = valid + stale; total = anchored + unanchored.
    assert.equal(report.anchored, (report.valid as number) + (report.stale as number), 'anchored = valid + stale');
    assert.equal(report.total, (report.anchored as number) + (report.unanchored as number), 'total = anchored + unanchored');
  });

  // ─── --story <real DONE id>: restriction path does not crash; total numeric ──
  check(`cli: learning_validate --story ${REAL_STORY_ID} restricts without crashing`, () => {
    const report = parseJsonObject(runCli('learning_validate', `{"json":true,"story":"${REAL_STORY_ID}"}`));
    assert.equal(typeof report.total, 'number', 'total numeric for restricted derivation');
    assert.ok(!Number.isNaN(report.total as number), 'total not NaN');
  });

  // ─── --story <nonexistent>: empty derivation edge (no crash, all-zero) ───────
  check(`cli: learning_validate --story ${NONEXISTENT_STORY_ID} => empty report, no crash`, () => {
    const report = parseJsonObject(runCli('learning_validate', `{"json":true,"story":"${NONEXISTENT_STORY_ID}"}`));
    assert.equal(report.total, 0, 'nonexistent story => total 0');
    assert.equal(report.validRate, 0, 'nonexistent story => validRate 0');
    assert.equal(report.driftRate, 0, 'nonexistent story => driftRate 0');
  });

  // ─── READ-ONLY: nothing written (no .lattice/learning, no activity.jsonl) ────
  check('cli: learning_validate writes nothing (no .lattice/learning / activity.jsonl)', () => {
    const after = porcelain();
    const introduced = newDirtyLines(before, after);
    const offending = introduced.filter((l) => /\.lattice[\\/]learning|activity\.jsonl/.test(l));
    assert.deepEqual(offending, [], `read-only violated; new write(s): ${introduced.join(' | ')}`);
  });

  console.log(`TOTAL ${total} | PASS ${passed} | FAIL ${total - passed}`);
  if (passed !== total) {
    process.exitCode = 1;
    return;
  }
  console.log('cli smoke passed');
}

run();
