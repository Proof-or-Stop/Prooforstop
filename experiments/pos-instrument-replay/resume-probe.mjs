#!/usr/bin/env node
// M3 interrupt/resume idempotence probe — committed producer (B-f511 CHK-002).
//
// Run by: node resume-probe.mjs   (writes resume-reconciliation.json; prints
//                                   "H3: 0 dup / 0 gap")
//
// H3 (interrupt/resume idempotence) is about the RESUME MECHANISM, not scale, so
// this runs at SMALL scale only. Everything happens in mkdtemp SANDBOXES: each
// trial copies run-batch.mjs + lib/ + protocol.json into a fresh sandbox and
// runs run-batch with cwd=sandbox, so batch-ledger.jsonl is sandbox-local and
// the committed experiment dir is never touched. The generate/verify CLI IS
// invoked (a live baseline is required per iteration), but only the frozen
// protocol.json is read.
//
// Two deterministic kills, then a --resume restart after each, then a strict
// reconciliation against the protocol replay/small cross-product:
//
//   KILL A (clean boundary): run run-batch --scale=small with the hard-crash
//     hook POS_CRASH_BEFORE_APPEND_AT set to replay/small/(K+1). The driver
//     records iterations 1..K, then at K+1 — AFTER generate+verify (workspace
//     written) but BEFORE the ledger append — hard-exits (process.exit(137),
//     simulating SIGKILL) writing NO record. Exactly K records exist and
//     iteration K+1 is the RECORDLESS casualty at a clean boundary. Restart with
//     --resume: it skips the K recorded, re-runs K+1..N, completes. Reconcile.
//
//   KILL B (mid-iteration, distinct point): the SAME deterministic hard-crash
//     hook at a DIFFERENT iteration (an interior index), exercising the
//     mid-iteration recordless-casualty path again distinctly. This
//     deterministic hard-crash-before-append is the SCORED kill. A secondary
//     external-SIGKILL trial is ALSO attempted (best-effort, informational only)
//     to show the mechanism survives a real signal, but it does not gate H3.
//
// After each resume the final ledger's iterationId multiset is compared to the
// protocol replay/small cross-product: dup count + gap count must both be 0, and
// the casualty iterationId must resolve to EXACTLY ONE record (a clean re-run OR
// a stop) — never a half-record. The reconciliation is written to
// resume-reconciliation.json.

import { execFileSync, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER_NAME = 'batch-ledger.jsonl';
const PROTOCOL_PATH = join(HERE, 'protocol.json');
const OUT_PATH = join(HERE, 'resume-reconciliation.json');

const protocol = JSON.parse(readFileSync(PROTOCOL_PATH, 'utf8'));
const N_SMALL = protocol.N.small;

function die(msg) {
  console.error('resume-probe FAIL: ' + msg);
  process.exit(1);
}

/** The frozen protocol cross-product of replay/small iterationIds. */
function expectedSmallIds() {
  const ids = [];
  for (let i = 1; i <= N_SMALL; i++) ids.push(`replay/small/${i}`);
  return ids;
}

/** Copy the pieces run-batch.mjs needs into a fresh sandbox dir. */
function makeSandbox(tag) {
  const sandbox = mkdtempSync(join(tmpdir(), `pos-resume-probe-${tag}-`));
  mkdirSync(join(sandbox, 'lib'), { recursive: true });
  cpSync(join(HERE, 'lib', 'instrument.mjs'), join(sandbox, 'lib', 'instrument.mjs'));
  cpSync(join(HERE, 'run-batch.mjs'), join(sandbox, 'run-batch.mjs'));
  cpSync(PROTOCOL_PATH, join(sandbox, 'protocol.json'));
  return sandbox;
}

/** Parse the sandbox JSONL ledger into records (or [] if absent). */
function readLedger(sandbox) {
  const path = join(sandbox, LEDGER_NAME);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** Count how many raw (parseable) records name each iterationId. */
function iterationIdCounts(records) {
  const counts = new Map();
  for (const r of records) {
    counts.set(r.iterationId, (counts.get(r.iterationId) || 0) + 1);
  }
  return counts;
}

/**
 * Compare an actual record set to the expected replay/small cross-product.
 * dup = ids with >1 record; gap = expected ids with 0 records; extra =
 * unexpected ids present. Returns { dup, gap, extra, match }.
 */
function reconcile(records) {
  const counts = iterationIdCounts(records);
  const expected = new Set(expectedSmallIds());
  let dup = 0;
  let gap = 0;
  const dupIds = [];
  const gapIds = [];
  for (const id of expected) {
    const c = counts.get(id) || 0;
    if (c === 0) {
      gap++;
      gapIds.push(id);
    } else if (c > 1) {
      dup++;
      dupIds.push(`${id} (x${c})`);
    }
  }
  const extraIds = [];
  for (const [id, c] of counts) {
    if (!expected.has(id)) extraIds.push(c > 1 ? `${id} (x${c})` : id);
  }
  const match =
    dup === 0 && gap === 0 && extraIds.length === 0 && counts.size === expected.size;
  return { dup, gap, dupIds, gapIds, extra: extraIds.length, extraIds, match };
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

/**
 * Determine the casualty disposition after resume: the casualty iterationId must
 * have EXACTLY ONE record post-resume; return whether it is a 'proof' (clean
 * re-run) or a 'stop' (a stop record). Any count != 1 is a half-record / dup
 * violation and fails the probe.
 */
function casualtyDisposition(records, casualtyId) {
  const forId = records.filter((r) => r.iterationId === casualtyId);
  if (forId.length !== 1) {
    die(
      `casualty ${casualtyId} must have EXACTLY ONE record post-resume, got ${forId.length} ` +
        `(a half-record or duplicate would violate append-only idempotence)`,
    );
  }
  const rec = forId[0];
  const isProof = rec.verifyStatus !== undefined;
  const isStop = rec.stopReason !== undefined;
  if (isProof === isStop) {
    die(`casualty ${casualtyId} record is not exactly proof XOR stop`);
  }
  return isStop ? `stop:${rec.stopReason}` : `proof:${rec.verifyStatus}`;
}

/**
 * A deterministic hard-crash KILL trial. Crash at replay/small/<crashIndex>
 * (AFTER generate+verify, BEFORE append), so exactly (crashIndex-1) records
 * exist and replay/small/<crashIndex> is the recordless casualty. Then resume.
 * Returns the reconciliation summary object.
 */
function killTrial(tag, crashIndex) {
  const casualtyId = `replay/small/${crashIndex}`;
  const sandbox = makeSandbox(tag);
  try {
    // ---- KILL: hard-crash exactly at the casualty iteration. ----
    const killRun = runBatch(sandbox, {
      args: ['--scale=small'],
      env: { POS_CRASH_BEFORE_APPEND_AT: casualtyId },
    });
    // The hard-crash exits 137 (SIGKILL-style), so a nonzero exit is EXPECTED.
    if (killRun.code === 0) {
      die(
        `${tag}: expected a NONZERO exit from the hard-crash kill at ${casualtyId}, got exit 0 ` +
          `(the crash hook did not fire)`,
      );
    }
    const partial = readLedger(sandbox);
    const recordedBeforeKill = partial.length;
    // Exactly the iterations BEFORE the casualty should be recorded, and the
    // casualty itself must be RECORDLESS (the hard-crash wrote no record).
    if (recordedBeforeKill !== crashIndex - 1) {
      die(
        `${tag}: expected exactly ${crashIndex - 1} record(s) before the kill at ${casualtyId}, ` +
          `got ${recordedBeforeKill}`,
      );
    }
    if (partial.some((r) => r.iterationId === casualtyId)) {
      die(
        `${tag}: the hard-crash casualty ${casualtyId} must be RECORDLESS after the kill, but a ` +
          `record for it is present`,
      );
    }

    // ---- RESUME: skip the recorded, re-run the casualty + the rest. ----
    const resumeRun = runBatch(sandbox, { args: ['--resume', '--scale=small'] });
    const finalRecords = readLedger(sandbox);
    const rec = reconcile(finalRecords);

    // The resume must complete cleanly: exit 0 with a 0-dup / 0-gap exact
    // multiset. Any nonzero exit means the strict end-of-run guard rejected the
    // final ledger.
    if (resumeRun.code !== 0) {
      die(
        `${tag}: resume exited ${resumeRun.code} (nonzero); the strict end-of-run guard rejected the ` +
          `final ledger.\n${(resumeRun.stdout + '\n' + resumeRun.stderr).slice(-800)}`,
      );
    }
    if (!rec.match || rec.dup !== 0 || rec.gap !== 0) {
      die(
        `${tag}: post-resume reconciliation is not clean — dup=${rec.dup} ` +
          `[${rec.dupIds.join(', ')}], gap=${rec.gap} [${rec.gapIds.join(', ')}], ` +
          `extra=${rec.extra} [${rec.extraIds.join(', ')}]`,
      );
    }
    const casualtyDisp = casualtyDisposition(finalRecords, casualtyId);

    // Belt-and-suspenders: assert EXACTLY ONE record per expected iterationId
    // (no half-record left anywhere).
    const counts = iterationIdCounts(finalRecords);
    for (const id of expectedSmallIds()) {
      if ((counts.get(id) || 0) !== 1) {
        die(`${tag}: iteration ${id} does not have exactly one record post-resume`);
      }
    }

    console.log(
      `  ${tag}: recordedBeforeKill=${recordedBeforeKill}, casualty=${casualtyId} -> ` +
        `${casualtyDisp}; post-resume dup=${rec.dup} gap=${rec.gap}`,
    );

    return {
      recordedBeforeKill,
      casualtyId,
      postResume: {
        dup: rec.dup,
        gap: rec.gap,
        casualtyDisposition: casualtyDisp,
      },
    };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/**
 * Secondary, INFORMATIONAL external-SIGKILL trial (does not gate H3). Spawns a
 * fresh --scale=small run and sends SIGKILL after the ledger reaches K records,
 * then resumes. Records whether the resume reconciled cleanly. Best-effort:
 * timing a real signal is inherently racy, so this is reported but not scored.
 * The deterministic hard-crash killTrial above is the SCORED kill.
 */
async function externalSigkillTrial(killAfterK) {
  const tag = 'killB-sigkill';
  const sandbox = makeSandbox(tag);
  try {
    const child = spawn('node', ['run-batch.mjs', '--scale=small'], {
      cwd: sandbox,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Watch the ledger; SIGKILL once it reaches killAfterK records (bounded).
    const ledgerPath = join(sandbox, LEDGER_NAME);
    const start = Date.now();
    const TIMEOUT_MS = 120000; // bounded wait; never hang indefinitely
    let killed = false;
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        let n = 0;
        try {
          if (existsSync(ledgerPath)) {
            n = readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.trim()).length;
          }
        } catch {
          /* transient read race; retry next tick */
        }
        if (!killed && n >= killAfterK) {
          killed = true;
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }
        if (child.exitCode !== null || child.signalCode !== null || Date.now() - start > TIMEOUT_MS) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
      child.on('exit', () => {
        clearInterval(timer);
        resolve();
      });
    });

    // Resume regardless of exactly where the signal landed.
    const resumeRun = runBatch(sandbox, { args: ['--resume', '--scale=small'] });
    const finalRecords = readLedger(sandbox);
    const rec = reconcile(finalRecords);
    const clean = resumeRun.code === 0 && rec.match && rec.dup === 0 && rec.gap === 0;
    console.log(
      `  ${tag} (informational): killed=${killed}, post-resume dup=${rec.dup} gap=${rec.gap}, ` +
        `resumeExit=${resumeRun.code}, cleanReconcile=${clean}`,
    );
    return { attempted: true, killed, cleanReconcile: clean, dup: rec.dup, gap: rec.gap };
  } catch (e) {
    console.log(`  killB-sigkill (informational): trial errored (non-gating): ${String(e && e.message)}`);
    return { attempted: true, error: String((e && e.message) || e), cleanReconcile: null };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

async function main() {
  console.log('resume-probe: H3 interrupt/resume idempotence (small scale, mkdtemp sandboxes)...');

  // KILL A (clean boundary): crash at K+1 with K = 5 (a clean boundary well
  // inside the run) so exactly 5 records exist and replay/small/6 is recordless.
  const K_A = 5;
  const killA = killTrial('killA-boundary', K_A + 1);

  // KILL B (mid-iteration, DISTINCT index): the SAME deterministic hard-crash
  // hook at a DIFFERENT interior iteration (index 18), exercising the recordless
  // mid-iteration casualty path again distinctly. This is the SCORED second kill.
  const killB = killTrial('killB-crash', 18);

  // Secondary informational external-SIGKILL trial (non-gating).
  const killBSigkill = await externalSigkillTrial(3);

  const dupTotal = killA.postResume.dup + killB.postResume.dup;
  const gapTotal = killA.postResume.gap + killB.postResume.gap;
  const finalMultisetMatch = dupTotal === 0 && gapTotal === 0;

  if (!finalMultisetMatch) {
    die(`H3 reconciliation not clean: dupTotal=${dupTotal}, gapTotal=${gapTotal}`);
  }

  const out = {
    hypothesis: 'H3',
    description:
      'interrupt/resume idempotence — a deterministic mid-iteration kill leaves a recordless ' +
      'casualty; a --resume restart skips the already-recorded iterations, re-runs the casualty ' +
      'and the rest, and the strict exact-multiset guard reconciles the final ledger to the ' +
      'protocol replay/small cross-product with 0 dup / 0 gap and exactly one record per iterationId.',
    scale: 'small',
    protocolReplaySmallCount: N_SMALL,
    killA,
    killB,
    killBSigkill,
    finalMultisetMatch,
    dupTotal,
    gapTotal,
  };
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');

  console.log(`resume-probe: wrote ${OUT_PATH}`);
  console.log('H3: 0 dup / 0 gap');
  process.exit(0);
}

main().catch((e) => {
  die(`uncaught: ${String((e && e.stack) || e)}`);
});
