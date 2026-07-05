#!/usr/bin/env node
// M2 hermetic selfcheck (B-2a5b CHK-003).
//
// Run by: node selfcheck-m2.mjs   (exit 0 iff all FIVE guards pass)
//
// Guards run-batch.mjs's load-bearing properties WITHOUT touching the
// committed batch-ledger.jsonl (all work happens in mkdtemp sandbox copies of
// run-batch.mjs + lib/instrument.mjs + protocol.json). SMALL scale only, for
// speed:
//
//   (a) BUDGET_CAP: run run-batch.mjs --scale=small with POS_BUDGET_CAP_MS=1
//       (sub-second, so every real verify blows the cap) -> assert the sandbox
//       ledger holds >=1 record with stopReason 'budget_cap'. Proves the
//       budget_cap stop path fires (H4 mechanism), NOT a tautology.
//
//   (b) LOCKFILE: pre-acquire the lock in the sandbox (mkdir the lock dir), then
//       run run-batch.mjs -> assert it records a precondition_failed stop AND
//       exits NONZERO, AND that the stop lands in the SEPARATE blocked-ledger
//       (batch-ledger.blocked.jsonl) while the shared batch-ledger.jsonl is NOT
//       contaminated. Proves a blocked second driver cannot corrupt the campaign
//       ledger; it records precondition_failed to its own path instead.
//
//   (c) RECORDLESS: run run-batch.mjs --scale=small with POS_SKIP_RECORD_AT set
//       to a real iterationId (replay/small/1) -> assert run-batch exits NONZERO
//       and names the recordless iteration. Proves the end-of-run guard catches
//       a missing record.
//
//   (d) GENERATE-CRASH: run run-batch.mjs --scale=small with POS_FAIL_GENERATE_AT
//       set to a real iterationId (replay/small/1), forcing a GENERATE-side
//       throw for that iteration -> assert run-batch produces a verify_crash STOP
//       record for exactly that iterationId (not an uncaught crash, not
//       recordless), the ledger holds exactly one record for it, and run-batch
//       still exits 0 (a crash is a clean stop, not a recordless failure).
//       Proves a generate crash cannot bypass proof-or-stop (F-001).
//
//   (e) PRE-BODY-CRASH: force a throw BEFORE/AROUND the guarded body — either
//       POS_FAIL_MKDTEMP_AT (setup mkdtemp throws before generate) or
//       POS_FAIL_APPEND_AT (the append throws after the body) for a real
//       iterationId (replay/small/1) -> assert the driver EITHER writes a
//       verify_crash STOP record for exactly that iterationId OR exits NONZERO
//       naming the recordless iteration, and NEVER exits 0 with that iteration
//       missing. Proves the F-003/F-004 fix: the WHOLE iteration lifecycle
//       (mkdtemp/append/cleanup, not just generate+verify) is guarded, and the
//       top-level backstop guarantees no silent exit-0 with a missing record.
//
// Hermeticity: each sub-check gets its own mkdtemp sandbox holding a copy of
// run-batch.mjs, lib/instrument.mjs, and the frozen protocol.json. run-batch is
// executed with cwd=sandbox so its ledger + lock live in the sandbox, never in
// the committed experiment dir. The generate/verify CLI IS invoked (a live
// baseline is required) but only frozen protocol.json is read, never rewritten.

import { execFileSync } from 'node:child_process';
import {
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
const BLOCKED_LEDGER_NAME = 'batch-ledger.blocked.jsonl';
const LOCK_NAME = '.batch-ledger.lock';

function fail(msg) {
  console.error('selfcheck-m2 FAIL: ' + msg);
  process.exit(1);
}

/** Copy the pieces run-batch.mjs needs into a fresh sandbox dir. */
function makeSandbox(tag) {
  const sandbox = mkdtempSync(join(tmpdir(), `pos-selfcheck-m2-${tag}-`));
  mkdirSync(join(sandbox, 'lib'), { recursive: true });
  cpSync(join(HERE, 'lib', 'instrument.mjs'), join(sandbox, 'lib', 'instrument.mjs'));
  cpSync(join(HERE, 'run-batch.mjs'), join(sandbox, 'run-batch.mjs'));
  cpSync(join(HERE, 'protocol.json'), join(sandbox, 'protocol.json'));
  return sandbox;
}

/** Parse a JSONL ledger file at `path` into records (or [] if absent). */
function readLedger(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/**
 * Run run-batch.mjs in the sandbox. Returns { code, stdout, stderr, records,
 * blockedRecords } where records is the parsed shared campaign ledger and
 * blockedRecords is the parsed SEPARATE blocked-ledger (each [] if not
 * produced). Never throws on a nonzero exit — the caller inspects code.
 */
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
  const records = readLedger(join(sandbox, LEDGER_NAME));
  const blockedRecords = readLedger(join(sandbox, BLOCKED_LEDGER_NAME));
  return { code, stdout, stderr, records, blockedRecords };
}

// ---------------------------------------------------------------------------
// (a) BUDGET_CAP: an injected sub-second cap forces every verify over the cap.
// ---------------------------------------------------------------------------
function checkBudgetCap() {
  const sandbox = makeSandbox('budget');
  try {
    const { code, records } = runBatch(sandbox, {
      args: ['--scale=small'],
      env: { POS_BUDGET_CAP_MS: '1' },
    });
    const budgetStops = records.filter((r) => r.stopReason === 'budget_cap');
    if (budgetStops.length < 1) {
      fail(
        `(a) BUDGET_CAP: expected >=1 record with stopReason 'budget_cap' under ` +
          `POS_BUDGET_CAP_MS=1, got ${budgetStops.length} (ledger had ${records.length} records, exit ${code})`,
      );
    }
    // Every produced record must be exactly one per iteration (proof XOR stop).
    for (const r of records) {
      const isProof = r.verifyStatus !== undefined;
      const isStop = r.stopReason !== undefined;
      if (isProof === isStop) {
        fail(`(a) BUDGET_CAP: record ${r.iterationId} is not exactly proof XOR stop`);
      }
    }
    console.log(
      `  (a) BUDGET_CAP PASS: ${budgetStops.length}/${records.length} records are budget_cap stops`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (b) LOCKFILE: pre-hold the lock -> the driver must record precondition_failed
// to the SEPARATE blocked-ledger, exit nonzero, and leave the shared campaign
// ledger UNCONTAMINATED (a blocked second driver cannot corrupt the campaign).
// ---------------------------------------------------------------------------
function checkLockfile() {
  const sandbox = makeSandbox('lock');
  try {
    // Simulate a first driver already holding the lock by creating the lock dir.
    mkdirSync(join(sandbox, LOCK_NAME));
    const { code, records, blockedRecords } = runBatch(sandbox, { args: ['--scale=small'] });
    if (code === 0) {
      fail(`(b) LOCKFILE: expected NONZERO exit when the lock is held, got exit 0`);
    }
    // The precondition_failed stop must land in the SEPARATE blocked-ledger.
    const blockedStops = blockedRecords.filter(
      (r) => r.stopReason === 'precondition_failed',
    );
    if (blockedRecords.length !== 1 || blockedStops.length !== 1) {
      fail(
        `(b) LOCKFILE: expected exactly 1 precondition_failed record in the SEPARATE ` +
          `blocked-ledger (${BLOCKED_LEDGER_NAME}), got ${blockedRecords.length} records ` +
          `(${blockedStops.length} precondition_failed)`,
      );
    }
    // The SHARED campaign ledger must NOT be contaminated at all — a blocked
    // driver must never write to it.
    if (records.length !== 0) {
      fail(
        `(b) LOCKFILE: the shared ${LEDGER_NAME} must be UNCONTAMINATED when the driver is ` +
          `lock-blocked, but it holds ${records.length} record(s): ` +
          `${records.map((r) => r.iterationId).join(', ')} — the driver corrupted the campaign ledger`,
      );
    }
    console.log(
      `  (b) LOCKFILE PASS: driver recorded precondition_failed to the separate blocked-ledger, ` +
        `left the campaign ledger clean, and exited ${code} (nonzero)`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (c) RECORDLESS: fault-inject a skipped record -> the end-of-run guard must
// fire (nonzero exit) naming the recordless iteration.
// ---------------------------------------------------------------------------
function checkRecordless() {
  const sandbox = makeSandbox('recordless');
  const skipId = 'replay/small/1';
  try {
    const { code, stdout, stderr } = runBatch(sandbox, {
      args: ['--scale=small'],
      env: { POS_SKIP_RECORD_AT: skipId },
    });
    if (code === 0) {
      fail(
        `(c) RECORDLESS: expected NONZERO exit when ${skipId} is recordless, got exit 0`,
      );
    }
    const combined = stdout + '\n' + stderr;
    if (!combined.includes('recordless') || !combined.includes(skipId)) {
      fail(
        `(c) RECORDLESS: expected the failure message to say 'recordless' and name ${skipId}; ` +
          `got:\n${combined.slice(-600)}`,
      );
    }
    console.log(
      `  (c) RECORDLESS PASS: driver exited ${code} (nonzero) and named ${skipId} as recordless`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (d) GENERATE-CRASH: force a GENERATE-side throw for one iteration -> the
// driver must sentinel it into a verify_crash STOP record for that exact
// iterationId (not an uncaught crash, not recordless), keep exactly one record
// for it, and still exit 0 (a clean stop, not a recordless failure). Proves a
// generate crash cannot bypass proof-or-stop (F-001).
// ---------------------------------------------------------------------------
function checkGenerateCrash() {
  const sandbox = makeSandbox('generate-crash');
  const crashId = 'replay/small/1';
  try {
    const { code, stdout, stderr, records } = runBatch(sandbox, {
      args: ['--scale=small'],
      env: { POS_FAIL_GENERATE_AT: crashId },
    });
    const combined = stdout + '\n' + stderr;
    if (code !== 0) {
      fail(
        `(d) GENERATE-CRASH: expected exit 0 (a generate crash is a clean verify_crash STOP, ` +
          `not a recordless failure), got exit ${code}:\n${combined.slice(-600)}`,
      );
    }
    const forId = records.filter((r) => r.iterationId === crashId);
    if (forId.length !== 1) {
      fail(
        `(d) GENERATE-CRASH: expected EXACTLY one ledger record for ${crashId}, got ${forId.length} ` +
          `(a generate crash must be neither recordless nor duplicated)`,
      );
    }
    const rec = forId[0];
    if (rec.stopReason !== 'verify_crash') {
      fail(
        `(d) GENERATE-CRASH: expected ${crashId} to be a verify_crash STOP record, got ` +
          `${rec.stopReason ? `stop:${rec.stopReason}` : `proof:${rec.verifyStatus}`} ` +
          `(the generate crash was not sentinelled into a stop)`,
      );
    }
    // The stop must be exactly stop (not proof), i.e. no verifyStatus leaked on.
    if (rec.verifyStatus !== undefined) {
      fail(`(d) GENERATE-CRASH: ${crashId} record is not exactly a stop (verifyStatus present)`);
    }
    // Every other iteration must still have produced its own single record (the
    // crash of one iteration does not abort the run).
    if (records.length !== 30) {
      fail(
        `(d) GENERATE-CRASH: expected the full small multiset (30 records) with ${crashId} as a ` +
          `verify_crash stop, got ${records.length} records`,
      );
    }
    console.log(
      `  (d) GENERATE-CRASH PASS: forced generate throw at ${crashId} became a verify_crash STOP ` +
        `record (1 record, not recordless), run exited ${code}`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (e) PRE-BODY-CRASH: inject a throw BEFORE/AROUND the guarded body (setup
// mkdtemp via POS_FAIL_MKDTEMP_AT, and the post-body append via
// POS_FAIL_APPEND_AT). For EACH injection point, assert the driver EITHER wrote
// a verify_crash STOP record for exactly that iterationId OR exited NONZERO
// naming the recordless iteration — and NEVER exited 0 with that iteration
// missing. Proves the full-lifecycle guard + top-level backstop (F-003/F-004):
// a throw outside the old generate+verify body cannot produce a silent exit-0
// with a missing record.
// ---------------------------------------------------------------------------
function checkPreBodyCrash() {
  const crashId = 'replay/small/1';
  const injections = [
    { name: 'POS_FAIL_MKDTEMP_AT', where: 'setup (mkdtemp, BEFORE the body)' },
    { name: 'POS_FAIL_APPEND_AT', where: 'append (AFTER the body)' },
  ];
  for (const inj of injections) {
    const sandbox = makeSandbox(`prebody-${inj.name.toLowerCase()}`);
    try {
      const { code, stdout, stderr, records } = runBatch(sandbox, {
        args: ['--scale=small'],
        env: { [inj.name]: crashId },
      });
      const combined = stdout + '\n' + stderr;
      const forId = records.filter((r) => r.iterationId === crashId);
      const hasStop =
        forId.length === 1 && forId[0].stopReason === 'verify_crash' && forId[0].verifyStatus === undefined;
      const missing = forId.length === 0;

      // The hard invariant: NEVER exit 0 with that iteration missing.
      if (code === 0 && missing) {
        fail(
          `(e) PRE-BODY-CRASH [${inj.name}]: driver EXITED 0 with ${crashId} MISSING from the ledger ` +
            `— a pre-body/around-body crash produced a silent exit-0 with a missing record (F-003/F-004). ` +
            `Ledger had ${records.length} record(s).\n${combined.slice(-600)}`,
        );
      }

      // Acceptable outcome A: a verify_crash STOP was recorded for the iteration.
      if (hasStop) {
        if (code !== 0) {
          fail(
            `(e) PRE-BODY-CRASH [${inj.name}]: wrote a verify_crash stop for ${crashId} but still exited ` +
              `${code}; a fully-recorded crash should be a clean exit 0.\n${combined.slice(-600)}`,
          );
        }
        console.log(
          `  (e) PRE-BODY-CRASH [${inj.name}] PASS: ${inj.where} crash became a verify_crash STOP ` +
            `record for ${crashId} (exit 0, no silent miss)`,
        );
        continue;
      }

      // Acceptable outcome B: the iteration is recordless (the irreducible
      // append-itself-failing case) -> the top-level backstop MUST exit NONZERO
      // and name the recordless iteration.
      if (missing) {
        if (code === 0) {
          // Already covered above, but keep the belt-and-suspenders assertion.
          fail(`(e) PRE-BODY-CRASH [${inj.name}]: exited 0 with ${crashId} missing`);
        }
        if (!combined.includes('recordless') || !combined.includes(crashId)) {
          fail(
            `(e) PRE-BODY-CRASH [${inj.name}]: ${crashId} is recordless and the driver exited ${code} ` +
              `(nonzero) but the failure message did not say 'recordless' and name ${crashId}:\n${combined.slice(-600)}`,
          );
        }
        console.log(
          `  (e) PRE-BODY-CRASH [${inj.name}] PASS: ${inj.where} crash left ${crashId} recordless; ` +
            `driver exited ${code} (nonzero) and named it recordless (no silent exit-0)`,
        );
        continue;
      }

      // Anything else (e.g. a proof record, or a duplicate) is a violation.
      fail(
        `(e) PRE-BODY-CRASH [${inj.name}]: ${crashId} was neither a single verify_crash stop nor a ` +
          `named-recordless nonzero exit; got ${forId.length} record(s) for it, exit ${code}.\n${combined.slice(-600)}`,
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }
}

function main() {
  console.log('selfcheck-m2: running 5 hermetic sub-checks (small scale)...');
  checkBudgetCap();
  checkLockfile();
  checkRecordless();
  checkGenerateCrash();
  checkPreBodyCrash();
  console.log('selfcheck-m2 PASS');
  process.exit(0);
}

main();
