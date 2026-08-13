#!/usr/bin/env node
/**
 * CHK-010 verification receipt (B-2aa7).
 *
 * CHK-010's three verification intents are EXECUTABLE: per B-ec67 the tool
 * refuses a caller-authored "result: pass" and instead runs a pinned command and
 * derives the verdict from its actual output. This file is that pinned command.
 *
 * It cannot BE the artifact it reports on: `red-b2aa7-artifact-validation.mjs`
 * exits NON-ZERO by design while CHK-001's BLOCK A rows are still red. So this
 * receipt RUNS the artifact as a child process (same solution as
 * `red-b2aa7-chk001-receipt.mjs`) and derives each marker from that run's real
 * stdout / stderr and exit code.
 *
 * ── WHAT MAKES THESE MARKERS CONDITION-GATED ────────────────────────────────
 *
 * BLOCK B rows are FATAL on failure: the runner calls `row.check(ctx)` directly,
 * so a failed invariant throws and the process dies BEFORE the BLOCK A row
 * report is ever printed. Every marker below therefore requires all three of:
 *
 *   1. the row printed its own `proof <id>: …` line — and that line's OBSERVED
 *      FACTS are re-checked here, not just its presence;
 *   2. all three BLOCK B rows reported `[PASS]`, so the block ran to completion;
 *   3. the run reached the BLOCK A report, proving execution continued PAST
 *      BLOCK B rather than aborting inside it.
 *
 * A single failed BLOCK B assertion kills 2 and 3 at once, so no marker can be
 * printed by an artifact whose invariants did not actually hold.
 *
 * Run from the repository root:
 *   node packages/main/tests/red/red-b2aa7-chk010-receipt.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const ARTIFACT = join(here, 'red-b2aa7-artifact-validation.mjs');

const run = spawnSync(process.execPath, [ARTIFACT], { encoding: 'utf8' });
const stdout = run.stdout ?? '';
const stderr = run.stderr ?? '';

// ── parse BLOCK B's own output ──────────────────────────────────────────────
const passed = new Set();
for (const line of stdout.split('\n')) {
  const m = /^\s*\[PASS\]\s+(\S+)\s/.exec(line);
  if (m) passed.add(m[1]);
}
const proofs = {};
for (const line of stdout.split('\n')) {
  const m = /^\s*proof (B\d+):\s*(.*)$/.exec(line);
  if (m) proofs[m[1]] = m[2];
}

const B1 = 'B1-v2-record-skipped-unchanged';
const B2 = 'B2-records-key-absent-stays-not-configured';
const B3 = 'B3-absent-side-not-reclassified-as-corruption';

// Structural gate shared by all three markers (conditions 2 and 3 above).
const blockBRanToCompletion =
  passed.has(B1) && passed.has(B2) && passed.has(B3)
  && /BLOCK A \(CHK-001\), pre-fix expectation: MUST FAIL/.test(stdout);

// BLOCK A must still be RED. If it were green the tree is post-fix, and
// "these invariants held BEFORE the fix" is no longer what was observed — the
// markers would be making a claim this run cannot support.
const tally = /(\d+) RED \/ (\d+) GREEN of (\d+) rows/.exec(stdout);
const redCount = tally ? Number(tally[1]) : -1;
const total = tally ? Number(tally[2]) + Number(tally[1]) : -1;
const preFixTree =
  run.status !== 0
  && /still exhibit the pre-fix defect/.test(stderr)
  && redCount > 0 && redCount === total;

// 1. happy — V2. A valid v2 record loads byte-identically, is not quarantined,
//    and is still SKIPPED by the v1 predicate. "Skipped" is proven by a verdict
//    FLIP driven by the `schemaVersion` member ALONE: the same record satisfies
//    the gate without the discriminator and is skipped with it.
const b1 = proofs.B1 ?? '';
const v2Unchanged =
  blockBRanToCompletion && preFixTree
  && /v2Loads=byte-identical/.test(b1)
  && /v2Quarantined=false/.test(b1)
  && /skipFlip=\[\]->\["missing_red_evidence"\] on schemaVersion alone/.test(b1)
  && /nonInterference=2\/2 orders/.test(b1)
  && /negControl\(schemaVersion=v3\)=discriminated/.test(b1);
if (v2Unchanged) {
  console.log(`V2_RECORD_SKIPPED_UNCHANGED (loads byte-identically, never quarantined, verdict flips [] -> ["missing_red_evidence"] on the schemaVersion member alone, 2/2 mixed orders unperturbed; observed while BLOCK A is ${redCount}/${total} RED)`);
}

// 2. edge — E4. An artifact whose `records` key is ABSENT stays on the ORDINARY
//    not-configured path: no throw, the ordinary `missing_red_evidence` gap, no
//    quarantine surface, and a report byte-identical to an ABSENT artifact — it
//    is NOT reclassified as corruption.
const b2 = proofs.B2 ?? '';
const e4NotConfigured =
  blockBRanToCompletion && preFixTree
  && /recordsKeyPresent=false/.test(b2)
  && /readThrew=false/.test(b2)
  && /codes=\["missing_red_evidence"\]/.test(b2)
  && /report==ABSENT=true/.test(b2)
  && /quarantined=false/.test(b2)
  && /recordsAbsent==recordsEmpty=true/.test(b2)
  && /negControl\(records:\{\}\)=discriminated/.test(b2);
if (e4NotConfigured) {
  console.log(`RECORDS_KEY_ABSENT_STAYS_NOT_CONFIGURED (UNSATISFIED via the ordinary missing_red_evidence gap, report byte-identical to an ABSENT artifact, never quarantined; a corrupt \`records: {}\` envelope is discriminated from it on this same predicate)`);
}

// 3. adversarial — the ABSENT side of the distinction is pinned. The whole
//    not-configured family (no artifact / `records` absent / `records: []` /
//    v2-only) reports identically and distinctly from SATISFIED, so the fix
//    cannot turn BLOCK A green by moving "absent" instead of "corrupt".
const b3 = proofs.B3 ?? '';
const absentSidePinned =
  blockBRanToCompletion && preFixTree
  && /absentReadsNull=true/.test(b3)
  && /family=4\/4 on the ordinary not-configured path/.test(b3)
  && /notConfigured!=satisfied=true/.test(b3)
  && /negControl\(records:\{\}\)=discriminated/.test(b3);
if (absentSidePinned) {
  console.log(`ABSENT_NOT_RECLASSIFIED_AS_CORRUPTION (4/4 not-configured shapes on one path, distinct from SATISFIED, corrupt envelope discriminated; the corrupt half of the distinction is BLOCK A's ${redCount} still-RED rows, deliberately not claimed here)`);
}
