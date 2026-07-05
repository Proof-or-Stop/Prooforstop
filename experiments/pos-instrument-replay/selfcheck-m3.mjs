#!/usr/bin/env node
// M3 hermetic selfcheck (B-f511 CHK-003).
//
// Run by: node selfcheck-m3.mjs   (exit 0 iff every guard passes)
//
// Guards the M3 resume/idempotence mechanism WITHOUT touching the committed
// batch-ledger.jsonl (all work happens in mkdtemp sandbox copies of run-batch.mjs
// + lib/instrument.mjs + protocol.json, run with cwd=sandbox). SMALL scale only,
// for speed. Asserts:
//
//   (A) BOUNDARY-KILL + RESUME: hard-crash at replay/small/(K+1) via
//       POS_CRASH_BEFORE_APPEND_AT leaves exactly K records and a RECORDLESS
//       casualty at replay/small/(K+1). A --resume restart skips the K recorded,
//       re-runs the casualty + the rest, and the strict end-of-run guard
//       reconciles the FINAL ledger: 0 dup, 0 gap, exactly one record per
//       protocol replay/small iterationId, and the casualty resolved to a
//       stop-or-clean-rerun (never a half-record). Proves resume idempotence.
//
//   (B) MID-ITERATION-CRASH + RESUME: the SAME hard-crash hook at a DIFFERENT
//       interior iteration (distinct from A) again produces a recordless
//       mid-iteration casualty; resume reconciles to 0 dup / 0 gap with exactly
//       one record per iterationId and the casualty resolved. Proves the
//       mechanism is not an artifact of one boundary.
//
//   (C) FRESH-ADDITIVITY: a FRESH run-batch (no --resume, EMPTY ledger) still
//       produces the EXACT expected small multiset (30 records, one per
//       replay/small/i, 0 dup / 0 gap, exit 0). CRITICAL: proves the resume
//       change is purely ADDITIVE — the fresh-campaign path is unchanged, so M2
//       batch-ledger.jsonl + selfcheck-m2 stay valid.
//
//   (D) RESUME-NO-LEDGER: --resume with NO existing ledger behaves as a fresh
//       run (full exact multiset, exit 0). Proves resume degrades to fresh.
//
//   (E) TRUNCATED-TAIL-REPAIR: a ledger whose LAST line is a truncated/partial
//       JSON fragment (a mid-append SIGKILL) is repaired-by-omission on resume —
//       the partial line's iteration is RE-RUN, and the final ledger reconciles
//       to 0 dup / 0 gap with exactly one record per iterationId. Proves the
//       truncated-trailing-line repair path.
//
// Hermeticity: each sub-check gets its own mkdtemp sandbox holding a copy of
// run-batch.mjs, lib/instrument.mjs, and the frozen protocol.json, run with
// cwd=sandbox so its ledger + lock live in the sandbox. The generate/verify CLI
// IS invoked (a live baseline per iteration) but only frozen protocol.json is
// read, never rewritten.

import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER_NAME = 'batch-ledger.jsonl';
const PROTOCOL_PATH = join(HERE, 'protocol.json');

const protocol = JSON.parse(readFileSync(PROTOCOL_PATH, 'utf8'));
const N_SMALL = protocol.N.small;

function fail(msg) {
  console.error('selfcheck-m3 FAIL: ' + msg);
  process.exit(1);
}

function expectedSmallIds() {
  const ids = [];
  for (let i = 1; i <= N_SMALL; i++) ids.push(`replay/small/${i}`);
  return ids;
}

/** Copy the pieces run-batch.mjs needs into a fresh sandbox dir. */
function makeSandbox(tag) {
  const sandbox = mkdtempSync(join(tmpdir(), `pos-selfcheck-m3-${tag}-`));
  mkdirSync(join(sandbox, 'lib'), { recursive: true });
  cpSync(join(HERE, 'lib', 'instrument.mjs'), join(sandbox, 'lib', 'instrument.mjs'));
  cpSync(join(HERE, 'run-batch.mjs'), join(sandbox, 'run-batch.mjs'));
  cpSync(PROTOCOL_PATH, join(sandbox, 'protocol.json'));
  return sandbox;
}

function ledgerPath(sandbox) {
  return join(sandbox, LEDGER_NAME);
}

/** Parse the sandbox JSONL ledger into records (or [] if absent). */
function readLedger(sandbox) {
  const path = ledgerPath(sandbox);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** Run run-batch synchronously in the sandbox. Never throws on nonzero exit. */
function runBatch(sandbox, { args = [], env = {} } = {}) {
  let stdout = '';
  let stderr = '';
  let code = 0;
  try {
    stdout = execFileSync('node', ['run-batch.mjs', ...args], {
      cwd: sandbox,
      encoding: 'utf8',
      maxBuffer: 1 << 27,
      env: { ...process.env, ...env },
    });
  } catch (e) {
    code = typeof e.status === 'number' ? e.status : 1;
    stdout = e.stdout ? e.stdout.toString() : '';
    stderr = e.stderr ? e.stderr.toString() : '';
  }
  return { code, stdout, stderr };
}

/** iterationId -> count over parseable records. */
function counts(records) {
  const m = new Map();
  for (const r of records) m.set(r.iterationId, (m.get(r.iterationId) || 0) + 1);
  return m;
}

/**
 * Assert the record set is EXACTLY the protocol replay/small cross-product:
 * one record per expected id (0 dup / 0 gap) and NOTHING extra. Returns the
 * count map so callers can inspect the casualty.
 */
function assertExactSmallMultiset(label, records) {
  const c = counts(records);
  const expected = new Set(expectedSmallIds());
  const dup = [];
  const gap = [];
  for (const id of expected) {
    const n = c.get(id) || 0;
    if (n === 0) gap.push(id);
    else if (n > 1) dup.push(`${id} (x${n})`);
  }
  const extra = [];
  for (const [id, n] of c) if (!expected.has(id)) extra.push(n > 1 ? `${id} (x${n})` : id);
  if (dup.length || gap.length || extra.length) {
    fail(
      `${label}: final ledger is not the exact small multiset — ` +
        `dup=[${dup.join(', ')}], gap=[${gap.join(', ')}], extra=[${extra.join(', ')}] ` +
        `(records=${records.length}, distinct=${c.size}, expected=${expected.size})`,
    );
  }
  return c;
}

/**
 * Assert the casualty iterationId resolved to EXACTLY ONE record that is a clean
 * proof XOR a stop (never a half-record), and return its disposition string.
 */
function assertCasualtyResolved(label, records, casualtyId) {
  const forId = records.filter((r) => r.iterationId === casualtyId);
  if (forId.length !== 1) {
    fail(
      `${label}: casualty ${casualtyId} must resolve to EXACTLY ONE record post-resume, got ` +
        `${forId.length} (a half-record or duplicate would break idempotence)`,
    );
  }
  const rec = forId[0];
  const isProof = rec.verifyStatus !== undefined;
  const isStop = rec.stopReason !== undefined;
  if (isProof === isStop) {
    fail(`${label}: casualty ${casualtyId} record is not exactly proof XOR stop (a half-record)`);
  }
  return isStop ? `stop:${rec.stopReason}` : `proof:${rec.verifyStatus}`;
}

// ---------------------------------------------------------------------------
// (A)/(B) generic hard-crash-kill + resume trial at replay/small/<crashIndex>.
// ---------------------------------------------------------------------------
function killResumeTrial(label, crashIndex) {
  const casualtyId = `replay/small/${crashIndex}`;
  const sandbox = makeSandbox(label);
  try {
    // KILL: hard-crash exactly at the casualty iteration (recordless).
    const killRun = runBatch(sandbox, {
      args: ['--scale=small'],
      env: { POS_CRASH_BEFORE_APPEND_AT: casualtyId },
    });
    if (killRun.code === 0) {
      fail(`${label}: expected a NONZERO exit from the hard-crash at ${casualtyId}, got exit 0`);
    }
    const partial = readLedger(sandbox);
    if (partial.length !== crashIndex - 1) {
      fail(
        `${label}: expected exactly ${crashIndex - 1} record(s) before the kill at ${casualtyId}, ` +
          `got ${partial.length}`,
      );
    }
    if (partial.some((r) => r.iterationId === casualtyId)) {
      fail(`${label}: the hard-crash casualty ${casualtyId} must be RECORDLESS after the kill`);
    }

    // RESUME: skip the recorded, re-run the casualty + the rest.
    const resumeRun = runBatch(sandbox, { args: ['--resume', '--scale=small'] });
    if (resumeRun.code !== 0) {
      fail(
        `${label}: resume exited ${resumeRun.code} (nonzero); the strict end-of-run guard rejected ` +
          `the final ledger.\n${(resumeRun.stdout + '\n' + resumeRun.stderr).slice(-800)}`,
      );
    }
    const finalRecords = readLedger(sandbox);
    assertExactSmallMultiset(label, finalRecords);
    const disp = assertCasualtyResolved(label, finalRecords, casualtyId);
    console.log(
      `  ${label} PASS: kill left ${crashIndex - 1} records + recordless ${casualtyId}; ` +
        `resume -> exact 30 multiset, 0 dup / 0 gap, casualty=${disp}`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (C) FRESH-ADDITIVITY: a fresh run (no --resume, empty ledger) still produces
// the exact expected small multiset — proves the resume change is additive.
// ---------------------------------------------------------------------------
function checkFreshAdditive() {
  const label = 'C-fresh-additive';
  const sandbox = makeSandbox(label);
  try {
    const { code, stdout, stderr } = runBatch(sandbox, { args: ['--scale=small'] });
    if (code !== 0) {
      fail(
        `${label}: a fresh --scale=small run must exit 0, got ${code}\n` +
          `${(stdout + '\n' + stderr).slice(-800)}`,
      );
    }
    const records = readLedger(sandbox);
    if (records.length !== N_SMALL) {
      fail(`${label}: expected ${N_SMALL} records from a fresh run, got ${records.length}`);
    }
    assertExactSmallMultiset(label, records);
    // Every record must be exactly proof XOR stop.
    for (const r of records) {
      if ((r.verifyStatus !== undefined) === (r.stopReason !== undefined)) {
        fail(`${label}: record ${r.iterationId} is not exactly proof XOR stop`);
      }
    }
    console.log(
      `  ${label} PASS: fresh run (no --resume, empty ledger) produced the exact ${N_SMALL}-record ` +
        `small multiset (0 dup / 0 gap) — resume change is additive`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (D) RESUME-NO-LEDGER: --resume with NO existing ledger behaves as fresh.
// ---------------------------------------------------------------------------
function checkResumeNoLedger() {
  const label = 'D-resume-no-ledger';
  const sandbox = makeSandbox(label);
  try {
    const { code, stdout, stderr } = runBatch(sandbox, { args: ['--resume', '--scale=small'] });
    if (code !== 0) {
      fail(
        `${label}: --resume with no existing ledger must behave as fresh (exit 0), got ${code}\n` +
          `${(stdout + '\n' + stderr).slice(-800)}`,
      );
    }
    const records = readLedger(sandbox);
    assertExactSmallMultiset(label, records);
    console.log(
      `  ${label} PASS: --resume with no existing ledger produced the exact ${N_SMALL}-record ` +
        `small multiset (behaves as fresh)`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (E) TRUNCATED-TAIL-REPAIR: seed a ledger with K clean records + a truncated
// trailing partial-JSON line (mid-append SIGKILL). Resume must ignore/repair the
// partial line (its iteration is re-run) and reconcile to the exact multiset.
// The seeding uses the hard-crash kill to produce K genuine records, then
// appends a hand-crafted partial JSON fragment as the trailing line.
// ---------------------------------------------------------------------------
function checkTruncatedTailRepair() {
  const label = 'E-truncated-tail';
  const K = 4;
  const casualtyId = `replay/small/${K + 1}`;
  const sandbox = makeSandbox(label);
  try {
    // Produce exactly K clean records via a hard-crash at K+1 (recordless).
    const killRun = runBatch(sandbox, {
      args: ['--scale=small'],
      env: { POS_CRASH_BEFORE_APPEND_AT: casualtyId },
    });
    if (killRun.code === 0) {
      fail(`${label}: expected NONZERO exit from the seeding hard-crash at ${casualtyId}`);
    }
    const seeded = readLedger(sandbox);
    if (seeded.length !== K) {
      fail(`${label}: seeding produced ${seeded.length} records, expected ${K}`);
    }
    // Simulate a mid-append SIGKILL: append a TRUNCATED partial-JSON fragment as
    // the trailing line (no newline terminator, invalid JSON). readLedger()
    // above already parsed only the K clean lines; now corrupt the tail on disk.
    const partialFragment = '{"iterationId":"replay/small/' + (K + 1) + '","arm":"replay","sc';
    appendFileSync(ledgerPath(sandbox), partialFragment); // NO trailing newline
    // Sanity: the raw file now ends with an unparseable fragment.
    const rawLines = readFileSync(ledgerPath(sandbox), 'utf8').split('\n').filter((l) => l.trim());
    let lastParses = true;
    try {
      JSON.parse(rawLines[rawLines.length - 1]);
    } catch {
      lastParses = false;
    }
    if (lastParses) {
      fail(`${label}: test setup error — the seeded trailing line is not actually truncated`);
    }

    // RESUME: must ignore/repair the truncated tail, re-run replay/small/(K+1)
    // and the rest, and reconcile to the exact multiset with 0 dup / 0 gap.
    const resumeRun = runBatch(sandbox, { args: ['--resume', '--scale=small'] });
    if (resumeRun.code !== 0) {
      fail(
        `${label}: resume over a truncated-tail ledger exited ${resumeRun.code} (nonzero); the ` +
          `truncated trailing line was not repaired.\n` +
          `${(resumeRun.stdout + '\n' + resumeRun.stderr).slice(-800)}`,
      );
    }
    const finalRecords = readLedger(sandbox);
    assertExactSmallMultiset(label, finalRecords);
    const disp = assertCasualtyResolved(label, finalRecords, casualtyId);
    console.log(
      `  ${label} PASS: truncated trailing line repaired-by-omission; resume re-ran ${casualtyId} ` +
        `(-> ${disp}) and reconciled to the exact ${N_SMALL}-record multiset (0 dup / 0 gap)`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function main() {
  console.log('selfcheck-m3: running hermetic resume/idempotence guards (small scale)...');
  // (A) clean-boundary kill at K+1 with K=5 (casualty replay/small/6).
  killResumeTrial('A-boundary-kill', 6);
  // (B) mid-iteration kill at a DISTINCT interior index (casualty replay/small/20).
  killResumeTrial('B-midrun-crash', 20);
  // (C) fresh additivity — the critical guard that resume did not change fresh.
  checkFreshAdditive();
  // (D) --resume with no existing ledger behaves as fresh.
  checkResumeNoLedger();
  // (E) truncated-trailing-line repair on resume.
  checkTruncatedTailRepair();
  console.log('selfcheck-m3 PASS');
  process.exit(0);
}

main();
