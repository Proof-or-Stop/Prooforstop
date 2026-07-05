#!/usr/bin/env node
// M2 hermetic selfcheck (B-2a5b CHK-003).
//
// Run by: node selfcheck-m2.mjs   (exit 0 iff all three guards pass)
//
// Guards run-batch.mjs's three load-bearing properties WITHOUT touching the
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
//       run run-batch.mjs -> assert it appends a precondition_failed stop record
//       AND exits NONZERO. Proves a concurrent second driver cannot corrupt the
//       ledger; it records precondition_failed instead.
//
//   (c) RECORDLESS: run run-batch.mjs --scale=small with POS_SKIP_RECORD_AT set
//       to a real iterationId (replay/small/1) -> assert run-batch exits NONZERO
//       and names the recordless iteration. Proves the end-of-run guard catches
//       a missing record.
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

/**
 * Run run-batch.mjs in the sandbox. Returns { code, stdout, stderr, records }
 * where records is the parsed sandbox ledger (or [] if not produced). Never
 * throws on a nonzero exit — the caller inspects code.
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
  const ledgerPath = join(sandbox, LEDGER_NAME);
  let records = [];
  if (existsSync(ledgerPath)) {
    records = readFileSync(ledgerPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  }
  return { code, stdout, stderr, records };
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
// and exit nonzero (a concurrent second driver cannot corrupt the ledger).
// ---------------------------------------------------------------------------
function checkLockfile() {
  const sandbox = makeSandbox('lock');
  try {
    // Simulate a first driver already holding the lock by creating the lock dir.
    mkdirSync(join(sandbox, LOCK_NAME));
    const { code, records } = runBatch(sandbox, { args: ['--scale=small'] });
    if (code === 0) {
      fail(`(b) LOCKFILE: expected NONZERO exit when the lock is held, got exit 0`);
    }
    const preconditionStops = records.filter(
      (r) => r.stopReason === 'precondition_failed',
    );
    if (preconditionStops.length !== 1) {
      fail(
        `(b) LOCKFILE: expected exactly 1 precondition_failed stop record, got ` +
          `${preconditionStops.length} (ledger had ${records.length} records)`,
      );
    }
    // The lock-held path must NOT run any iterations (no proof/other records).
    if (records.length !== 1) {
      fail(
        `(b) LOCKFILE: expected ONLY the precondition_failed record (no iteration ran), ` +
          `got ${records.length} records — the driver may have corrupted the ledger`,
      );
    }
    console.log(
      `  (b) LOCKFILE PASS: driver recorded precondition_failed and exited ${code} (nonzero)`,
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

function main() {
  console.log('selfcheck-m2: running 3 hermetic sub-checks (small scale)...');
  checkBudgetCap();
  checkLockfile();
  checkRecordless();
  console.log('selfcheck-m2 PASS');
  process.exit(0);
}

main();
