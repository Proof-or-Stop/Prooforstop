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
//   (F) STOP-RECORD-RESUME (F-004): a run records a verify_crash STOP at an
//       EARLIER iteration (POS_FAIL_APPEND_AT — a caught append-phase throw),
//       then hard-crashes recordless at a LATER iteration. On --resume the driver
//       must SKIP the already-recorded stop (NOT re-run it into a proof — the
//       stop record is preserved byte-identical), re-run the recordless casualty
//       + the rest, and reconcile to 0 dup / 0 gap. Proves resume's handling of
//       an ALREADY-RECORDED stop, which (A)/(B) (recordless-only) never touched.
//
//   (G) VALID-FINAL-RECORD-PRESERVED (F-002/F-003): a ledger whose LAST line is a
//       COMPLETE valid record that merely lost its trailing newline at EOF must
//       be PRESERVED on resume (its iteration counted as recorded, NOT dropped),
//       so that iteration does NOT become a spurious re-run/GAP. Reconciles to
//       0 dup / 0 gap. Proves parse-before-drop never deletes a complete record.
//
//   (H) LIVE-LOCK-NOT-BROKEN (F-001): a --resume run must REFUSE to break a lock
//       whose holder process is still ALIVE (a genuine concurrent driver). A live
//       holder is spawned holding the lock; a --resume attempt must exit nonzero
//       with precondition_failed (recorded to the blocked-ledger) and must NOT
//       remove the lock. The discrimination half then kills the holder and proves
//       a DEAD-pid stamp IS still broken. Proves resume cannot clobber a live
//       driver's lock yet still reclaims a genuinely-orphaned (dead-pid) one.
//
//   (I) NO-HOLDER-LOCK-NOT-BROKEN (F-005/F-006): the mkdir->holder ACQUIRE-WINDOW
//       race. acquireLock() wins mkdir(LOCK_DIR) BEFORE it stamps holder.json; a
//       concurrent --resume driver in that window sees the lock dir with NO
//       holder.json. The OLD code treated a missing holder as STALE and broke the
//       lock -> two writers -> ledger corruption. This sub-check creates a
//       LOCK_DIR with NO holder.json, attempts --resume, and asserts it REFUSES to
//       break it (exit nonzero, precondition_failed to the blocked-ledger, lock +
//       campaign ledger untouched). Proves the CONSERVATIVE missing-holder=LIVE
//       rule closes the acquire race (F-005 = F-006, same race).
//
// Hermeticity: each sub-check gets its own mkdtemp sandbox holding a copy of
// run-batch.mjs, lib/instrument.mjs, and the frozen protocol.json, run with
// cwd=sandbox so its ledger + lock live in the sandbox. The generate/verify CLI
// IS invoked (a live baseline per iteration) but only frozen protocol.json is
// read, never rewritten.

import { execFileSync, spawn } from 'node:child_process';
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

// ---------------------------------------------------------------------------
// (F) STOP-RECORD-RESUME (F-004): a verify_crash STOP recorded at an EARLIER
// iteration (POS_FAIL_APPEND_AT) must be SKIPPED on resume — preserved as a stop,
// NOT re-run into a proof, 0 dup / 0 gap. A LATER hard-crash halts the run
// recordless so resume has remaining work and encounters the recorded stop.
// ---------------------------------------------------------------------------
function checkStopRecordResume() {
  const label = 'F-stop-record-resume';
  const stopIndex = 3; // POS_FAIL_APPEND_AT -> verify_crash STOP recorded here
  const crashIndex = 12; // hard-crash recordless here (LATER), halts the run
  const stoppedId = `replay/small/${stopIndex}`;
  const casualtyId = `replay/small/${crashIndex}`;
  const sandbox = makeSandbox(label);
  try {
    // KILL: record a verify_crash STOP at stopIndex, then hard-crash at crashIndex.
    const killRun = runBatch(sandbox, {
      args: ['--scale=small'],
      env: { POS_FAIL_APPEND_AT: stoppedId, POS_CRASH_BEFORE_APPEND_AT: casualtyId },
    });
    if (killRun.code === 0) {
      fail(`${label}: expected a NONZERO exit from the hard-crash at ${casualtyId}, got exit 0`);
    }
    const partial = readLedger(sandbox);
    if (partial.length !== crashIndex - 1) {
      fail(
        `${label}: expected exactly ${crashIndex - 1} record(s) before the hard-crash at ` +
          `${casualtyId}, got ${partial.length}`,
      );
    }
    const stopRecs = partial.filter((r) => r.iterationId === stoppedId);
    if (stopRecs.length !== 1 || stopRecs[0].stopReason !== 'verify_crash') {
      fail(
        `${label}: ${stoppedId} must be recorded as a single verify_crash STOP before resume ` +
          `(got count=${stopRecs.length}, stopReason=${stopRecs[0] && stopRecs[0].stopReason})`,
      );
    }
    if (partial.some((r) => r.iterationId === casualtyId)) {
      fail(`${label}: the hard-crash casualty ${casualtyId} must be RECORDLESS after the kill`);
    }
    const stopDigestBefore = stopRecs[0].recordDigest;

    // RESUME: must SKIP the recorded stop (preserve it), re-run the casualty + rest.
    const resumeRun = runBatch(sandbox, { args: ['--resume', '--scale=small'] });
    if (resumeRun.code !== 0) {
      fail(
        `${label}: resume exited ${resumeRun.code} (nonzero); the strict end-of-run guard rejected ` +
          `the final ledger.\n${(resumeRun.stdout + '\n' + resumeRun.stderr).slice(-800)}`,
      );
    }
    const finalRecords = readLedger(sandbox);
    assertExactSmallMultiset(label, finalRecords);
    // CORE F-004 ASSERTION: the stop was SKIPPED — one record, still a stop, byte-
    // identical (append-only: not re-run into a proof, not rewritten).
    const finalStopRecs = finalRecords.filter((r) => r.iterationId === stoppedId);
    if (finalStopRecs.length !== 1) {
      fail(
        `${label}: after resume ${stoppedId} must have EXACTLY ONE record (the preserved stop), got ` +
          `${finalStopRecs.length} (a dup means resume re-ran an already-recorded stop)`,
      );
    }
    if (finalStopRecs[0].stopReason !== 'verify_crash' || finalStopRecs[0].verifyStatus !== undefined) {
      fail(
        `${label}: after resume ${stoppedId} must STILL be a verify_crash STOP (resume must not re-run ` +
          `an already-recorded stop into a proof), got stopReason=${finalStopRecs[0].stopReason} ` +
          `verifyStatus=${finalStopRecs[0].verifyStatus}`,
      );
    }
    if (finalStopRecs[0].recordDigest !== stopDigestBefore) {
      fail(`${label}: the preserved stop record for ${stoppedId} changed across resume (append-only violated)`);
    }
    const disp = assertCasualtyResolved(label, finalRecords, casualtyId);
    console.log(
      `  ${label} PASS: stop at ${stoppedId} recorded (verify_crash), resume SKIPPED it ` +
        `(preserved, not re-run into a proof), casualty ${casualtyId} -> ${disp}, exact 30 multiset, ` +
        `0 dup / 0 gap`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (G) VALID-FINAL-RECORD-PRESERVED (F-002/F-003): a ledger whose trailing line is
// a COMPLETE record missing only its newline must be PRESERVED on resume (its
// iteration counted as recorded, NOT dropped) — no spurious re-run / GAP.
// ---------------------------------------------------------------------------
function checkValidFinalRecordPreserved() {
  const label = 'G-valid-final-record-preserved';
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
    // The K clean records were written WITH trailing newlines. Strip the final
    // newline from the file so the LAST record's line is complete-but-unterminated
    // (a real record that merely lost its trailing \n at EOF — NOT a truncation).
    const raw = readFileSync(ledgerPath(sandbox), 'utf8');
    if (!raw.endsWith('\n')) {
      fail(`${label}: test setup error — the seeded ledger did not end with a newline`);
    }
    const withoutFinalNewline = raw.slice(0, -1);
    // Sanity: the trailing line MUST parse to a complete record (this is the whole
    // point — it is a real record, not a partial write).
    const lines = withoutFinalNewline.split('\n');
    const lastLine = lines[lines.length - 1];
    let lastRec;
    try {
      lastRec = JSON.parse(lastLine);
    } catch {
      fail(`${label}: test setup error — the trailing line is not parseable (should be a complete record)`);
    }
    if (typeof lastRec.iterationId !== 'string') {
      fail(`${label}: test setup error — the trailing line is not a ledger record`);
    }
    const preservedId = lastRec.iterationId;
    const preservedDigest = lastRec.recordDigest;
    // Write the file back WITHOUT the trailing newline (simulate the record whose
    // last append landed the bytes but the process died before the '\n').
    rmSync(ledgerPath(sandbox));
    appendFileSync(ledgerPath(sandbox), withoutFinalNewline); // no trailing newline

    // RESUME: must PRESERVE the complete trailing record (count it as recorded,
    // NOT drop it), re-run only the recordless casualty + the rest.
    const resumeRun = runBatch(sandbox, { args: ['--resume', '--scale=small'] });
    if (resumeRun.code !== 0) {
      fail(
        `${label}: resume over a complete-final-record-without-newline ledger exited ` +
          `${resumeRun.code} (nonzero).\n${(resumeRun.stdout + '\n' + resumeRun.stderr).slice(-800)}`,
      );
    }
    const finalRecords = readLedger(sandbox);
    assertExactSmallMultiset(label, finalRecords);
    // CORE F-002/F-003 ASSERTION: the preserved record is NOT dropped/re-run — it
    // still has exactly one record, byte-identical (same recordDigest).
    const preservedRecs = finalRecords.filter((r) => r.iterationId === preservedId);
    if (preservedRecs.length !== 1) {
      fail(
        `${label}: the complete trailing record ${preservedId} must have EXACTLY ONE record after ` +
          `resume (it must NOT be dropped-and-re-run), got ${preservedRecs.length}`,
      );
    }
    if (preservedRecs[0].recordDigest !== preservedDigest) {
      fail(
        `${label}: the complete trailing record ${preservedId} was NOT preserved verbatim — its ` +
          `recordDigest changed (parse-before-drop must never delete + re-run a complete record)`,
      );
    }
    console.log(
      `  ${label} PASS: a complete trailing record (${preservedId}) missing only its newline was ` +
        `PRESERVED verbatim on resume (not dropped into a GAP); exact 30 multiset, 0 dup / 0 gap`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (H) LIVE-LOCK-NOT-BROKEN (F-001): a --resume run must REFUSE to break a lock
// whose holder process is ALIVE. We create the lock dir with a holder.json whose
// pid is a LIVE long-lived child process, then attempt a --resume run and assert
// it exits nonzero (precondition_failed to the blocked-ledger) and did NOT remove
// the lock. Then we kill the holder and confirm resume DOES break the now-stale
// lock (dead pid) — proving the liveness check is discriminating, not a blanket
// refusal.
// ---------------------------------------------------------------------------
function lockDirPath(sandbox) {
  return join(sandbox, '.batch-ledger.lock');
}
function holderPath(sandbox) {
  return join(lockDirPath(sandbox), 'holder.json');
}
function blockedLedgerPath(sandbox) {
  return join(sandbox, 'batch-ledger.blocked.jsonl');
}

// Short blocking sleep for a bounded liveness poll, WITHOUT spawning a process
// and WITHOUT the banned foreground `sleep`. Uses Atomics.wait on a throwaway
// SharedArrayBuffer (blocks the current thread for `ms` with no busy-spin).
function blockMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function checkLiveLockNotBroken() {
  const label = 'H-live-lock-not-broken';
  const sandbox = makeSandbox(label);
  // Spawn a long-lived holder process; its pid is the live lock holder. Node
  // assigns child.pid synchronously once the process is spawned.
  const holder = spawn('node', ['-e', 'setInterval(() => {}, 1e9)'], {
    stdio: 'ignore',
    detached: false,
  });
  try {
    if (!(typeof holder.pid === 'number' && holder.pid > 0)) {
      fail(`${label}: holder process failed to spawn (no pid)`);
    }
    const livePid = holder.pid;
    // Manually create a lock dir with a LIVE holder pid (mimic a concurrent driver
    // that acquired the lock and stamped holder.json).
    mkdirSync(lockDirPath(sandbox), { recursive: true });
    appendFileSync(holderPath(sandbox), JSON.stringify({ pid: livePid }) + '\n');

    // ATTEMPT RESUME: must REFUSE to break the live lock.
    const resumeRun = runBatch(sandbox, { args: ['--resume', '--scale=small'] });
    if (resumeRun.code === 0) {
      fail(
        `${label}: --resume broke a LIVE lock (exit 0) — two writers could corrupt the ledger. ` +
          `The live-holder liveness check failed.\n${(resumeRun.stdout + '\n' + resumeRun.stderr).slice(-800)}`,
      );
    }
    // The lock dir + holder must still be present (NOT removed).
    if (!existsSync(lockDirPath(sandbox)) || !existsSync(holderPath(sandbox))) {
      fail(`${label}: --resume removed a LIVE lock's dir/holder — it must be left intact`);
    }
    // A precondition_failed stop must be recorded to the BLOCKED ledger, and the
    // shared campaign ledger must NOT have been touched.
    if (!existsSync(blockedLedgerPath(sandbox))) {
      fail(`${label}: --resume did not record precondition_failed to the blocked-ledger`);
    }
    const blocked = readFileSync(blockedLedgerPath(sandbox), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    if (!blocked.some((r) => r.stopReason === 'precondition_failed')) {
      fail(`${label}: blocked-ledger has no precondition_failed record after the refused resume`);
    }
    if (existsSync(ledgerPath(sandbox))) {
      fail(`${label}: --resume wrote to the shared campaign ledger while refusing a live lock`);
    }
    console.log(
      `  ${label} PASS: --resume REFUSED to break a LIVE lock (holder pid ${livePid} alive) — ` +
        `exit ${resumeRun.code}, precondition_failed to blocked-ledger, campaign ledger untouched`,
    );

    // DISCRIMINATION CHECK: kill the holder, then resume must now BREAK the stale
    // lock (dead pid) and complete cleanly — proving the check is not a blanket
    // refusal. Remove the blocked-ledger first so we assert on the fresh run only.
    // Wait for the holder to actually EXIT (Node reaps it once 'exit' fires, so
    // the pid stops responding to the liveness probe as a zombie). Bounded.
    const exited = await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve(true);
      };
      holder.once('exit', finish);
      if (holder.exitCode !== null || holder.signalCode !== null) finish();
      holder.kill('SIGKILL');
      setTimeout(() => resolve(done), 5000);
    });
    if (!exited) fail(`${label}: holder pid ${livePid} did not exit within 5s`);
    // Belt-and-suspenders: confirm the probe now sees the pid as dead. (A short
    // block covers the tiny window between the 'exit' event and OS reaping.)
    let dead = false;
    const killStart = Date.now();
    while (!dead) {
      try {
        process.kill(livePid, 0);
      } catch {
        dead = true; // ESRCH -> the holder is gone
        break;
      }
      if (Date.now() - killStart > 5000) fail(`${label}: holder pid ${livePid} still alive 5s after exit`);
      blockMs(25);
    }
    rmSync(blockedLedgerPath(sandbox), { force: true });
    const resumeAfterDeath = runBatch(sandbox, { args: ['--resume', '--scale=small'] });
    if (resumeAfterDeath.code !== 0) {
      fail(
        `${label}: after the holder DIED, --resume must break the now-stale lock and complete (exit 0), ` +
          `got ${resumeAfterDeath.code}.\n${(resumeAfterDeath.stdout + '\n' + resumeAfterDeath.stderr).slice(-800)}`,
      );
    }
    const finalRecords = readLedger(sandbox);
    assertExactSmallMultiset(label, finalRecords);
    console.log(
      `  ${label} PASS (discrimination): after the holder DIED, --resume broke the now-stale lock ` +
        `and completed the exact ${N_SMALL}-record multiset (the liveness check is discriminating)`,
    );
  } finally {
    try {
      holder.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (I) NO-HOLDER-LOCK-NOT-BROKEN (F-005/F-006): the mkdir->holder acquire-window
// race. acquireLock() wins mkdir(LOCK_DIR) BEFORE it stamps holder.json; in that
// window a concurrent --resume driver would see the lock dir with NO holder.json.
// The OLD code treated a missing holder as STALE and broke the lock, so a live
// driver's freshly-won lock could be clobbered and both would append -> ledger
// corruption. This sub-check simulates that window: create a LOCK_DIR with NO
// holder.json at all, attempt a --resume run, and assert it REFUSES to break the
// lock — it exits nonzero with precondition_failed (to the blocked-ledger) and
// leaves the lock dir + the campaign ledger untouched. This is the load-bearing
// F-005/F-006 assertion (distinct from H, which uses a live/dead PID stamp).
// ---------------------------------------------------------------------------
function checkNoHolderLockNotBroken() {
  const label = 'I-no-holder-lock-not-broken';
  const sandbox = makeSandbox(label);
  try {
    // Simulate the acquire window: a driver won mkdir(LOCK_DIR) but has NOT yet
    // written holder.json. Create the lock dir with NO holder file.
    mkdirSync(lockDirPath(sandbox), { recursive: true });
    if (existsSync(holderPath(sandbox))) {
      fail(`${label}: test setup error — holder.json should NOT exist for the acquire-window case`);
    }

    // ATTEMPT RESUME: must REFUSE to break the holder-less lock (conservative:
    // a missing holder is treated as LIVE, not stale).
    const resumeRun = runBatch(sandbox, { args: ['--resume', '--scale=small'] });
    if (resumeRun.code === 0) {
      fail(
        `${label}: --resume broke a holder-LESS lock (exit 0) — the mkdir->holder acquire-window ` +
          `race is OPEN: a concurrent driver in that window could be clobbered and both append.\n` +
          `${(resumeRun.stdout + '\n' + resumeRun.stderr).slice(-800)}`,
      );
    }
    // The lock dir must still be present (NOT removed): the conservative rule
    // must never break a lock it cannot prove stale.
    if (!existsSync(lockDirPath(sandbox))) {
      fail(`${label}: --resume removed a holder-LESS lock — the acquire-window lock must be left intact`);
    }
    // A precondition_failed stop must be recorded to the BLOCKED ledger, and the
    // shared campaign ledger must NOT have been touched.
    if (!existsSync(blockedLedgerPath(sandbox))) {
      fail(`${label}: --resume did not record precondition_failed to the blocked-ledger`);
    }
    const blocked = readFileSync(blockedLedgerPath(sandbox), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    if (!blocked.some((r) => r.stopReason === 'precondition_failed')) {
      fail(`${label}: blocked-ledger has no precondition_failed record after the refused resume`);
    }
    if (existsSync(ledgerPath(sandbox))) {
      fail(`${label}: --resume wrote to the shared campaign ledger while refusing a holder-less lock`);
    }
    console.log(
      `  ${label} PASS: --resume REFUSED to break a holder-LESS lock (the mkdir->stamp acquire ` +
        `window) — exit ${resumeRun.code}, precondition_failed to blocked-ledger, lock + campaign ` +
        `ledger untouched (missing-holder is conservatively treated as LIVE)`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

async function main() {
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
  // (F) STOP-RECORD-RESUME (F-004): resume SKIPS an already-recorded stop.
  checkStopRecordResume();
  // (G) VALID-FINAL-RECORD-PRESERVED (F-002/F-003): a complete trailing record
  //     missing only its newline is preserved (not dropped into a GAP).
  checkValidFinalRecordPreserved();
  // (H) LIVE-LOCK-NOT-BROKEN (F-001): resume refuses to break a live lock.
  await checkLiveLockNotBroken();
  // (I) NO-HOLDER-LOCK-NOT-BROKEN (F-005/F-006): resume refuses to break a
  //     holder-LESS lock (the mkdir->stamp acquire window) — conservative
  //     missing-holder=LIVE closes the acquire race.
  checkNoHolderLockNotBroken();
  console.log('selfcheck-m3 PASS');
  process.exit(0);
}

main().catch((e) => {
  console.error('selfcheck-m3 FAIL: uncaught: ' + String((e && e.stack) || e));
  process.exit(1);
});
