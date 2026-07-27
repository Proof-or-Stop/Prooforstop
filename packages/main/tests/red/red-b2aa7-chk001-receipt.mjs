#!/usr/bin/env node
/**
 * CHK-001 verification receipt (B-2aa7).
 *
 * CHK-001's three verification intents are EXECUTABLE: per B-ec67 the tool
 * refuses a caller-authored "result: pass" and instead runs a pinned command and
 * derives the verdict from its actual output. This file is that pinned command.
 *
 * It cannot BE the RED artifact, because a repro-first RED artifact exits
 * NON-ZERO by design. So this receipt RUNS
 * `red-b2aa7-artifact-validation.mjs` as a child process and derives each marker
 * from that run's real stdout/stderr and exit code. Every marker is printed ONLY
 * when its condition genuinely holds, so a failing condition yields no marker
 * and the pinned selector cannot match.
 *
 * Run from the repository root:
 *   node packages/main/tests/red/red-b2aa7-chk001-receipt.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const RED_ARTIFACT = join(here, 'red-b2aa7-artifact-validation.mjs');

const run = spawnSync(process.execPath, [RED_ARTIFACT], { encoding: 'utf8' });
const stdout = run.stdout ?? '';
const stderr = run.stderr ?? '';

// ── parse the RED artifact's own row report ─────────────────────────────────
const rows = [];
let current = null;
for (const line of stdout.split('\n')) {
  const head = /^\s*\[(RED |GREEN)\]\s+(\S+)\s+\((\S+)\s+(\S+)\)\s*(.*)$/.exec(line);
  if (head) {
    current = { state: head[1].trim(), id: head[2], block: head[3], klass: head[4], label: head[5], witness: '', observed: '', required: '' };
    rows.push(current);
    continue;
  }
  if (!current) continue;
  const field = /^\s+(witness|observed|required)\s*:\s*(.*)$/.exec(line);
  if (field) current[field[1]] = field[2];
}

const tally = /(\d+) RED \/ (\d+) GREEN of (\d+) rows/.exec(stdout);
const redCount = tally ? Number(tally[1]) : -1;
const greenCount = tally ? Number(tally[2]) : -1;
const total = tally ? Number(tally[3]) : -1;

const classesSeen = new Set(rows.filter((r) => r.state === 'RED').map((r) => r.klass));
const rowsOf = (klass) => rows.filter((r) => r.state === 'RED' && r.klass === klass);

// 1. happy — the committed RED artifact RUNS on the current tree and FAILS, and
//    the failure is the red signal (the tally of unresolved defect rows), not a
//    crash in the harness itself. All three defect classes are witnessed live.
const failedAsRed =
  run.status !== 0
  && /still exhibit the pre-fix defect/.test(stderr)
  && total > 0 && redCount === total && greenCount === 0
  && classesSeen.has('CRASH') && classesSeen.has('SILENT') && classesSeen.has('UNTYPED-THROW');
if (failedAsRed) {
  console.log(`RED_ARTIFACT_FAILS_WITH_ALL_CLASSES_LIVE (${redCount}/${total} rows red; classes: ${[...classesSeen].sort().join(',')})`);
}

// 2. edge — nothing passes vacuously. Proven two ways, both mechanical:
//    (a) ZERO rows are green on the pre-fix tree, so no row was written for a
//        defect that was already closed;
//    (b) the artifact's own exclusion guard — which asserts that the two rows
//        B-506e closed (record null / a bare string) still fail closed with a
//        typed RedEvidenceSchemaError, and therefore are rightly ABSENT from the
//        RED block — ran to completion. Had it aborted, it would have owned the
//        AssertionError instead of the row tally.
const nothingVacuous =
  greenCount === 0 && redCount === total && total > 0
  && !/exclusion guard/.test(stderr);
if (nothingVacuous) {
  console.log(`NO_ROW_PASSES_VACUOUSLY (0 green of ${total}; B-506e-closed rows excluded and that exclusion re-verified)`);
}

// 3. adversarial — the three classes carry three DIFFERENT assertion shapes.
//    CRASH asserts a bare TypeError escapes; SILENT asserts a wrong observable
//    value AND explicitly no throw; UNTYPED-THROW asserts a RAW SyntaxError
//    escapes and its requirement is a TYPED error, NOT the absence of a throw.
const crash = rowsOf('CRASH');
const silent = rowsOf('SILENT');
const untyped = rowsOf('UNTYPED-THROW');

const crashShape = crash.length > 0 && crash.every((r) =>
  /THREW TypeError\(TypeError\)/.test(r.observed) && /bare TypeError/.test(r.witness) && /no bare TypeError escapes/.test(r.required));

const silentShape = silent.length > 0 && silent.every((r) =>
  /^no throw;/.test(r.observed) && /no throw/.test(r.witness) && /byte-identical/.test(r.witness)
  && !/^THREW/.test(r.observed));

const untypedShape = untyped.length > 0 && untyped.every((r) =>
  /THREW SyntaxError\(SyntaxError\)/.test(r.observed)
  && /RAW SyntaxError/.test(r.witness)
  && /STILL THROWS/.test(r.required)
  && /absence of a throw would NOT satisfy/.test(r.required));

// The shapes must also be DISTINCT from one another, or "three shapes" is a
// label rather than a fact.
const shapesDistinct = new Set([
  crash.map((r) => r.required)[0],
  silent.map((r) => r.required)[0],
  untyped.map((r) => r.required)[0],
]).size === 3;

if (crashShape && silentShape && untypedShape && shapesDistinct) {
  console.log(`THREE_CLASSES_THREE_SHAPES (CRASH=${crash.length} asserts bare TypeError; SILENT=${silent.length} asserts wrong value + no throw; UNTYPED-THROW=${untyped.length} asserts raw SyntaxError, requires a TYPED throw)`);
}
