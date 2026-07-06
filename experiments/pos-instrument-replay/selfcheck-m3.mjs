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
//   (J) BREAK-MUTEX-SERIALIZES (F-007/F-008): the multi-resumer break TOCTOU. The
//       break was CHECK (evaluateLockForBreak) then USE (rmSync(LOCK_DIR)), NOT
//       atomic, so two --resume drivers reading the SAME genuinely-dead holder
//       could BOTH decide breakable and B's unconditional rmSync could delete A's
//       freshly-reacquired LIVE lock. The fix serializes the whole break
//       critical-section behind a dedicated mkdir break-mutex. J.1: with a stale
//       lock PLUS a pre-existing break-mutex, --resume must FAIL CLOSED (exit
//       nonzero, precondition_failed mentioning the break-mutex, campaign ledger
//       untouched). J.2: remove the break-mutex and the still-stale lock stays
//       reclaimable (exact 30 multiset).
//
//   (K) FRESH-REFUSES-NONEMPTY-LEDGER (F-009/F-011): a FRESH (non-resume) driver
//       must FAIL CLOSED if the campaign batch-ledger.jsonl already exists and is
//       non-empty, BEFORE any append (a fresh driver that won the lock in the
//       resume break-to-reacquire window would otherwise re-run + re-append every
//       iteration, producing on-disk duplicates the end-guard rejects but cannot
//       repair — a poisoned evidence file). Given a sandbox whose ledger already
//       holds valid records, a FRESH run must exit 3, append a precondition_failed
//       record to the blocked-ledger whose rawError mentions the non-empty ledger,
//       and leave the campaign ledger BYTE-IDENTICAL (no duplicate/extra records).
//
//   (L) FRESH-FAILS-CLOSED-ON-UNREADABLE-LEDGER (F-013/F-014/F-016): the FRESH
//       fresh-mode guard (K) must also FAIL CLOSED when the pre-existing ledger
//       EXISTS but is UNREADABLE (write-only / EACCES / any read error). We cannot
//       prove an unreadable ledger is safe to start fresh over, so REFUSE (treat as
//       non-empty) rather than fail OPEN and re-append onto it. Given a sandbox
//       whose ledger already holds valid records, a FRESH run with the read forced
//       to throw (POS_FAIL_LEDGER_READ=1) must exit 3, append a precondition_failed
//       record to the blocked-ledger, and leave the campaign ledger BYTE-IDENTICAL
//       (no records appended — fail closed, not open). Deterministic via the fault
//       hook (INERT unless the env var === '1').
//
//   (M) RESUME-BREAK-FAILURE-DIAGNOSTIC (F-010/F-015): the stale-lock-break
//       failure path (rmSync(LOCK_DIR) throwing -> breakError -> explicit exit-2
//       diagnostic) is otherwise untestable because rmSync(force:true) essentially
//       never throws. With a genuinely-STALE lock (holder.json with a dead pid) and
//       the destructive break forced to throw (POS_FAIL_LOCK_BREAK=1), a --resume
//       run must exit 2 (NOT 3), print the 'could not break the stale lock'
//       diagnostic, leave NO orphaned break-mutex (.batch-ledger.break.lock —
//       released by the finally, not by the failing rmSync), and leave the campaign
//       ledger untouched. Deterministic via the fault hook (INERT unless '1').
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

// ---------------------------------------------------------------------------
// (J) BREAK-MUTEX-SERIALIZES (F-007/F-008): the multi-resumer break TOCTOU. The
// break was CHECK (evaluateLockForBreak) then USE (rmSync(LOCK_DIR)), NOT atomic.
// With a GENUINELY-DEAD holder, two --resume drivers can BOTH read the same dead
// holder, BOTH decide breakable, and B's unconditional rmSync then deletes A's
// freshly-reacquired LIVE lock -> two campaign writers. The fix serializes the
// whole break critical-section behind a dedicated mkdir break-mutex
// (.batch-ledger.break.lock). This sub-check proves BOTH directions
// DETERMINISTICALLY (no timing race):
//   J.1: a STALE lock (holder.json with a genuinely-DEAD pid) PLUS a pre-existing
//        break-mutex (simulating 'a breaker is mid-break') -> --resume must FAIL
//        CLOSED: exit nonzero, precondition_failed to the blocked-ledger with
//        rawError mentioning the break-mutex, and the campaign ledger UNTOUCHED.
//   J.2: remove the break-mutex (the break completed) -> --resume must now BREAK
//        the still-stale lock and complete the EXACT 30-record small multiset.
// The break-mutex is what a second concurrent breaker would be holding; J.1
// proves the second breaker fails closed, J.2 proves a genuinely-stale lock stays
// reclaimable once the mutex is free.
// ---------------------------------------------------------------------------
function breakLockDirPath(sandbox) {
  return join(sandbox, '.batch-ledger.break.lock');
}

// Obtain a genuinely-DEAD pid: spawn a trivial child, kill it, and poll the
// liveness probe until it reports ESRCH (dead). Same technique sub-check H uses
// to reach its post-death discrimination step. Returns the now-dead pid.
async function spawnDeadPid(label) {
  const child = spawn('node', ['-e', 'process.exit(0)'], { stdio: 'ignore', detached: false });
  if (!(typeof child.pid === 'number' && child.pid > 0)) {
    fail(`${label}: helper child failed to spawn (no pid)`);
  }
  const pid = child.pid;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    child.once('exit', finish);
    if (child.exitCode !== null || child.signalCode !== null) finish();
    child.kill('SIGKILL');
    setTimeout(finish, 5000);
  });
  // Confirm the OS now reports the pid as dead (bounded poll covers the tiny
  // window between the 'exit' event and OS reaping).
  const start = Date.now();
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      break; // ESRCH -> genuinely dead
    }
    if (Date.now() - start > 5000) fail(`${label}: helper pid ${pid} still alive 5s after kill`);
    blockMs(25);
  }
  return pid;
}

async function checkBreakMutexSerializes() {
  const label = 'J-break-mutex-serializes';
  const sandbox = makeSandbox(label);
  try {
    const deadPid = await spawnDeadPid(label);

    // Set up a STALE lock: LOCK_DIR with holder.json pointing at the dead pid.
    mkdirSync(lockDirPath(sandbox), { recursive: true });
    appendFileSync(holderPath(sandbox), JSON.stringify({ pid: deadPid }) + '\n');

    // ---- J.1: a break is already in progress (pre-create the break-mutex). ----
    // Simulate 'another resume driver is mid-break' by pre-creating BREAK_LOCK_DIR.
    mkdirSync(breakLockDirPath(sandbox), { recursive: true });

    const blocked1 = runBatch(sandbox, { args: ['--resume', '--scale=small'] });
    if (blocked1.code === 0) {
      fail(
        `${label} (J.1): --resume proceeded (exit 0) while the break-mutex was held — a second ` +
          `breaker must FAIL CLOSED to avoid racing the in-progress break.\n` +
          `${(blocked1.stdout + '\n' + blocked1.stderr).slice(-800)}`,
      );
    }
    // The stale lock must NOT have been removed by the fail-closed driver.
    if (!existsSync(lockDirPath(sandbox))) {
      fail(`${label} (J.1): the fail-closed driver removed the lock dir — it must leave it intact`);
    }
    // The break-mutex we planted must still be present (the loser must not remove
    // a break-mutex it does not own).
    if (!existsSync(breakLockDirPath(sandbox))) {
      fail(`${label} (J.1): the fail-closed driver removed a break-mutex it does not hold`);
    }
    // A precondition_failed stop mentioning the break-mutex must be in the BLOCKED
    // ledger, and the campaign ledger must NOT exist / be untouched.
    if (!existsSync(blockedLedgerPath(sandbox))) {
      fail(`${label} (J.1): --resume did not record precondition_failed to the blocked-ledger`);
    }
    const blockedRecs = readFileSync(blockedLedgerPath(sandbox), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const mutexStop = blockedRecs.find(
      (r) => r.stopReason === 'precondition_failed' && /break-mutex/i.test(r.rawError || ''),
    );
    if (!mutexStop) {
      fail(
        `${label} (J.1): blocked-ledger has no precondition_failed record whose rawError mentions ` +
          `the break-mutex (got: ${JSON.stringify(blockedRecs.map((r) => r.rawError))})`,
      );
    }
    if (existsSync(ledgerPath(sandbox))) {
      fail(`${label} (J.1): --resume wrote to the campaign ledger while the break-mutex was held`);
    }
    console.log(
      `  ${label} PASS (J.1): break-mutex held -> --resume FAILED CLOSED (exit ${blocked1.code}, ` +
        `precondition_failed 'break-mutex' to blocked-ledger, stale lock + campaign ledger untouched)`,
    );

    // ---- J.2: the break completed (remove the mutex) -> lock is reclaimable. ----
    // Clear the blocked-ledger so we assert on the fresh run, and free the mutex.
    rmSync(blockedLedgerPath(sandbox), { force: true });
    rmSync(breakLockDirPath(sandbox), { recursive: true, force: true });

    const reclaim = runBatch(sandbox, { args: ['--resume', '--scale=small'] });
    if (reclaim.code !== 0) {
      fail(
        `${label} (J.2): with the break-mutex free, --resume must break the still-stale lock and ` +
          `complete (exit 0), got ${reclaim.code}.\n${(reclaim.stdout + '\n' + reclaim.stderr).slice(-800)}`,
      );
    }
    const finalRecords = readLedger(sandbox);
    assertExactSmallMultiset(label, finalRecords);
    // The happy path must leave NO orphaned break-mutex behind (the finally cleans
    // it up).
    if (existsSync(breakLockDirPath(sandbox))) {
      fail(`${label} (J.2): the successful break left the break-mutex orphaned (finally cleanup failed)`);
    }
    console.log(
      `  ${label} PASS (J.2): break-mutex free -> --resume broke the still-stale lock and completed the ` +
        `exact ${N_SMALL}-record multiset (0 dup / 0 gap); no orphaned break-mutex`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (K) FRESH-REFUSES-NONEMPTY-LEDGER (F-009/F-011): a FRESH (non-resume) driver
// must FAIL CLOSED when the campaign batch-ledger.jsonl already exists and is
// non-empty, BEFORE any append — otherwise a fresh driver that won the lock in
// the resume break-to-reacquire window would re-run + re-append every iteration
// onto the already-non-empty ledger, producing on-disk duplicates the end-guard
// rejects but cannot repair (a poisoned evidence file). This sub-check seeds a
// sandbox ledger with a couple of syntactically-valid record lines (distinct
// iterationIds), runs the driver in FRESH mode (NO --resume), and asserts:
// exit 3, a precondition_failed record appended to the blocked-ledger whose
// rawError mentions the non-empty ledger, and the campaign ledger left
// BYTE-IDENTICAL (no duplicate/extra records appended). Deterministic; no crash
// hook, no timing race.
// ---------------------------------------------------------------------------
function checkFreshRefusesNonemptyLedger() {
  const label = 'K-fresh-refuses-nonempty-ledger';
  const sandbox = makeSandbox(label);
  try {
    // Seed the campaign ledger with a few syntactically-valid record lines with
    // distinct iterationIds (the exact record shape is irrelevant to the guard —
    // it only checks the ledger is non-empty; these are valid proof/stop-shaped
    // JSON objects carrying a string iterationId).
    const seededLines = [
      JSON.stringify({ iterationId: 'replay/small/1', arm: 'replay', scale: 'small', index: 1, verifyStatus: 'pass' }),
      JSON.stringify({ iterationId: 'replay/small/2', arm: 'replay', scale: 'small', index: 2, verifyStatus: 'pass' }),
      JSON.stringify({ iterationId: 'replay/small/3', arm: 'replay', scale: 'small', index: 3, stopReason: 'budget_cap' }),
    ];
    const seededContent = seededLines.join('\n') + '\n';
    appendFileSync(ledgerPath(sandbox), seededContent);
    // Snapshot the seeded ledger bytes so we can prove it stays UNCHANGED.
    const ledgerBefore = readFileSync(ledgerPath(sandbox), 'utf8');

    // FRESH run (NO --resume) over a non-empty pre-existing ledger: must FAIL CLOSED.
    const freshRun = runBatch(sandbox, { args: ['--scale=small'] });
    if (freshRun.code !== 3) {
      fail(
        `${label}: a FRESH (no --resume) run over a non-empty pre-existing ledger must exit 3 ` +
          `(fail closed), got ${freshRun.code} — a fresh driver re-appending onto a non-empty ledger ` +
          `would poison it with on-disk duplicates.\n${(freshRun.stdout + '\n' + freshRun.stderr).slice(-800)}`,
      );
    }
    // The campaign ledger must be BYTE-IDENTICAL to the seed — no re-run/re-append.
    const ledgerAfter = readFileSync(ledgerPath(sandbox), 'utf8');
    if (ledgerAfter !== ledgerBefore) {
      fail(
        `${label}: the campaign ledger was MODIFIED by the refused fresh run — it must stay ` +
          `byte-identical (no duplicate/extra records appended). before=${ledgerBefore.length}B, ` +
          `after=${ledgerAfter.length}B`,
      );
    }
    // A precondition_failed record must be appended to the BLOCKED ledger, and its
    // rawError must mention the non-empty ledger.
    if (!existsSync(blockedLedgerPath(sandbox))) {
      fail(`${label}: the refused fresh run did not record precondition_failed to the blocked-ledger`);
    }
    const blocked = readFileSync(blockedLedgerPath(sandbox), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const precondStop = blocked.find(
      (r) => r.stopReason === 'precondition_failed' && /non-empty|already exists/i.test(r.rawError || ''),
    );
    if (!precondStop) {
      fail(
        `${label}: blocked-ledger has no precondition_failed record whose rawError mentions the ` +
          `non-empty pre-existing ledger (got: ${JSON.stringify(blocked.map((r) => r.rawError))})`,
      );
    }
    console.log(
      `  ${label} PASS: a FRESH (no --resume) run over a non-empty pre-existing ledger FAILED CLOSED ` +
        `(exit ${freshRun.code}, precondition_failed 'non-empty ledger' to blocked-ledger, campaign ` +
        `ledger left byte-identical — no duplicate/extra records)`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (L) FRESH-FAILS-CLOSED-ON-UNREADABLE-LEDGER (F-013/F-014/F-016): the fresh-mode
// guard must FAIL CLOSED not only on a readable non-empty ledger (K) but also when
// the pre-existing ledger EXISTS yet is UNREADABLE (write-only / EACCES / any read
// error). A fresh driver cannot prove an unreadable ledger is safe to start fresh
// over, so it must REFUSE (treat as non-empty) rather than fail OPEN and re-append
// onto it. We seed the sandbox ledger with valid records, run the driver in FRESH
// mode (NO --resume) with POS_FAIL_LEDGER_READ=1 (which forces readFileSync of the
// existing ledger to throw), and assert: exit 3, a precondition_failed record
// appended to the blocked-ledger, and the campaign ledger left BYTE-IDENTICAL (no
// records appended — fail closed, not open). Deterministic via the fault hook.
// ---------------------------------------------------------------------------
function checkFreshFailsClosedOnUnreadableLedger() {
  const label = 'L-fresh-fails-closed-on-unreadable-ledger';
  const sandbox = makeSandbox(label);
  try {
    // Seed the campaign ledger with a few syntactically-valid record lines with
    // distinct iterationIds (the exact shape is irrelevant — the guard would read
    // the ledger, but the fault hook forces that read to throw before it can).
    const seededLines = [
      JSON.stringify({ iterationId: 'replay/small/1', arm: 'replay', scale: 'small', index: 1, verifyStatus: 'pass' }),
      JSON.stringify({ iterationId: 'replay/small/2', arm: 'replay', scale: 'small', index: 2, verifyStatus: 'pass' }),
      JSON.stringify({ iterationId: 'replay/small/3', arm: 'replay', scale: 'small', index: 3, stopReason: 'budget_cap' }),
    ];
    const seededContent = seededLines.join('\n') + '\n';
    appendFileSync(ledgerPath(sandbox), seededContent);
    // Snapshot the seeded ledger bytes so we can prove it stays UNCHANGED.
    const ledgerBefore = readFileSync(ledgerPath(sandbox), 'utf8');

    // FRESH run (NO --resume) over an EXISTING-but-UNREADABLE ledger: the fault hook
    // forces the guard's readFileSync to throw, so it must FAIL CLOSED (not open).
    const freshRun = runBatch(sandbox, {
      args: ['--scale=small'],
      env: { POS_FAIL_LEDGER_READ: '1' },
    });
    if (freshRun.code !== 3) {
      fail(
        `${label}: a FRESH (no --resume) run over an EXISTING-but-UNREADABLE ledger must exit 3 ` +
          `(fail closed), got ${freshRun.code} — an unreadable ledger cannot be proven safe to start ` +
          `fresh over, so the guard must refuse rather than fail open.\n` +
          `${(freshRun.stdout + '\n' + freshRun.stderr).slice(-800)}`,
      );
    }
    // The campaign ledger must be BYTE-IDENTICAL to the seed — no re-run/re-append.
    const ledgerAfter = readFileSync(ledgerPath(sandbox), 'utf8');
    if (ledgerAfter !== ledgerBefore) {
      fail(
        `${label}: the campaign ledger was MODIFIED by the refused fresh run — it must stay ` +
          `byte-identical (fail closed, not open — no records appended). before=${ledgerBefore.length}B, ` +
          `after=${ledgerAfter.length}B`,
      );
    }
    // A precondition_failed record must be appended to the BLOCKED ledger.
    if (!existsSync(blockedLedgerPath(sandbox))) {
      fail(`${label}: the refused fresh run did not record precondition_failed to the blocked-ledger`);
    }
    const blocked = readFileSync(blockedLedgerPath(sandbox), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    if (!blocked.some((r) => r.stopReason === 'precondition_failed')) {
      fail(
        `${label}: blocked-ledger has no precondition_failed record after the refused fresh run ` +
          `(got: ${JSON.stringify(blocked.map((r) => r.stopReason))})`,
      );
    }
    console.log(
      `  ${label} PASS: a FRESH (no --resume) run over an EXISTING-but-UNREADABLE ledger FAILED CLOSED ` +
        `(exit ${freshRun.code}, precondition_failed to blocked-ledger, campaign ledger left ` +
        `byte-identical — no records appended, fail closed not open)`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (M) RESUME-BREAK-FAILURE-DIAGNOSTIC (F-010/F-015): the stale-lock-break failure
// path (rmSync(LOCK_DIR) throwing -> breakError -> the explicit exit-2 'could not
// break the stale lock' diagnostic) is otherwise untestable because
// rmSync(force:true) essentially never throws. We set up a genuinely-STALE lock
// (holder.json with a dead pid — same technique as sub-checks H/J), run --resume
// with POS_FAIL_LOCK_BREAK=1 (which forces the destructive break to throw), and
// assert: exit 2 (NOT 3), the 'could not break the stale lock' diagnostic in the
// output, NO orphaned break-mutex (.batch-ledger.break.lock — released by the
// finally, not by the failing rmSync), and the campaign ledger untouched (the
// exit-2 fatal fires BEFORE the lock is acquired / any ledger append). Deterministic
// via the fault hook (INERT unless the env var === '1').
// ---------------------------------------------------------------------------
async function checkResumeBreakFailureDiagnostic() {
  const label = 'M-resume-break-failure-diagnostic';
  const sandbox = makeSandbox(label);
  try {
    const deadPid = await spawnDeadPid(label);

    // Set up a STALE lock: LOCK_DIR with holder.json pointing at the dead pid. This
    // is breakable (dead holder), so the driver ENTERS the break critical-section —
    // where the fault hook then forces the destructive rmSync to throw.
    mkdirSync(lockDirPath(sandbox), { recursive: true });
    appendFileSync(holderPath(sandbox), JSON.stringify({ pid: deadPid }) + '\n');

    // --resume with the break forced to fail: must hit the explicit exit-2 diagnostic.
    const breakRun = runBatch(sandbox, {
      args: ['--resume', '--scale=small'],
      env: { POS_FAIL_LOCK_BREAK: '1' },
    });
    if (breakRun.code !== 2) {
      fail(
        `${label}: a --resume run whose stale-lock break FAILS must exit 2 (the explicit break-failure ` +
          `diagnostic), NOT ${breakRun.code} (3 would mean it fell through to a precondition/lock path ` +
          `instead of the break-failure path).\n${(breakRun.stdout + '\n' + breakRun.stderr).slice(-800)}`,
      );
    }
    const combined = breakRun.stdout + '\n' + breakRun.stderr;
    if (!/could not break the stale lock/i.test(combined)) {
      fail(
        `${label}: the exit-2 run did not print the 'could not break the stale lock' diagnostic ` +
          `(got: ${combined.slice(-800)})`,
      );
    }
    // The break-mutex must NOT be left orphaned — the finally releases it even when
    // the break itself throws (a SIGKILL-orphaned mutex is a different failure mode).
    if (existsSync(breakLockDirPath(sandbox))) {
      fail(
        `${label}: the break-mutex (.batch-ledger.break.lock) was left ORPHANED after the break ` +
          `failed — the finally must release it on the throw path, not leave it for the rmSync`,
      );
    }
    // The campaign ledger must be UNTOUCHED — the exit-2 fatal fires before the lock
    // is acquired and before any campaign-ledger append.
    if (existsSync(ledgerPath(sandbox))) {
      fail(`${label}: the failed-break run wrote to the campaign ledger — it must be left untouched`);
    }
    console.log(
      `  ${label} PASS: a --resume run whose stale-lock break FAILED became the explicit exit-2 ` +
        `diagnostic ('could not break the stale lock'), left NO orphaned break-mutex (released by the ` +
        `finally), and left the campaign ledger untouched`,
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
  // (J) BREAK-MUTEX-SERIALIZES (F-007/F-008): the multi-resumer break TOCTOU is
  //     closed by serializing the break critical-section behind a mkdir
  //     break-mutex. J.1 proves a second breaker fails closed while a break is in
  //     progress; J.2 proves a genuinely-stale lock stays reclaimable once free.
  await checkBreakMutexSerializes();
  // (K) FRESH-REFUSES-NONEMPTY-LEDGER (F-009/F-011): a FRESH (no --resume) driver
  //     must FAIL CLOSED on a non-empty pre-existing campaign ledger, before any
  //     append (the resume break-to-reacquire window otherwise lets a fresh driver
  //     re-append duplicates the end-guard rejects but cannot repair).
  checkFreshRefusesNonemptyLedger();
  // (L) FRESH-FAILS-CLOSED-ON-UNREADABLE-LEDGER (F-013/F-014/F-016): the fresh-mode
  //     guard must also FAIL CLOSED when the pre-existing ledger EXISTS but is
  //     UNREADABLE (write-only / EACCES / any read error) — refuse rather than fail
  //     open and re-append onto an unprovable ledger.
  checkFreshFailsClosedOnUnreadableLedger();
  // (M) RESUME-BREAK-FAILURE-DIAGNOSTIC (F-010/F-015): the stale-lock-break failure
  //     path (rmSync(LOCK_DIR) throwing -> the explicit exit-2 diagnostic) is made
  //     testable via a fault hook; the break-mutex is still released by the finally.
  await checkResumeBreakFailureDiagnostic();
  console.log('selfcheck-m3 PASS');
  process.exit(0);
}

main().catch((e) => {
  console.error('selfcheck-m3 FAIL: uncaught: ' + String((e && e.stack) || e));
  process.exit(1);
});
