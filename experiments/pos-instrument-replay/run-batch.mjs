#!/usr/bin/env node
// M2 replay campaign driver (B-2a5b CHK-001/002).
//
// Run by: node run-batch.mjs [--scale=small|full]
//
// For each scale in {small, full} and index 1..N[scale] (from the FROZEN
// protocol.json), this driver runs one INDEPENDENT generate+verify cycle in a
// fresh mkdtemp dir and appends EXACTLY ONE proof-or-stop record (proof XOR
// stop) to batch-ledger.jsonl. The ledger is append-only: an existing line is
// never rewritten. The records are the H1 (replay determinism) and H4
// (budget-cap discipline) EVIDENCE — this driver does NOT adjudicate the
// hypotheses (that is M4); it only produces and shape-guards the evidence.
//
// Proof-or-stop discipline:
//   - proof record  <- verify status is a normal verdict (pass|fail) AND the
//                      verify elapsedMs is within the budget cap.
//   - stop record   <- verify crashed (stopReason 'verify_crash'), OR verify
//                      elapsedMs exceeded the budget cap (stopReason 'budget_cap'),
//                      OR the lock could not be acquired (stopReason
//                      'precondition_failed', recorded before exit).
//
// Every iteration ends in exactly one record. An END-OF-RUN GUARD asserts the
// ledger holds exactly the protocol cross-product of iterationIds for the run's
// scales, one record each; a recordless OR duplicate iteration exits NONZERO.
//
// The instrument (packages/**, via the lattice memory_playbook_baseline_* CLI)
// is READ / CALLED ONLY through lib/instrument.mjs. Nothing here mutates it.

import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256, canonicalJson, verifyDir } from './lib/instrument.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = join(HERE, 'batch-ledger.jsonl');
const LOCK_DIR = join(HERE, '.batch-ledger.lock');
const PROTOCOL_PATH = join(HERE, 'protocol.json');

// ---------------------------------------------------------------------------
// Protocol (FROZEN by M0). Read-only.
// ---------------------------------------------------------------------------
const protocol = JSON.parse(readFileSync(PROTOCOL_PATH, 'utf8'));
const N = protocol.N; // { small: 30, full: 3 }
const ENV_PINS = protocol.envPins; // { instrumentCommit, nodeVersion, platform }
const STOP_REASONS = new Set(protocol.stopReasonEnum);

// Budget cap for a single verify (ms). The frozen cap is budgetCaps.msPerVerify;
// tolerate a legacy budgetCapMsPerVerify spelling. POS_BUDGET_CAP_MS overrides
// it (the selfcheck injects a sub-second cap to exercise the budget_cap path).
function resolveBudgetCapMs() {
  const injected = process.env.POS_BUDGET_CAP_MS;
  if (injected !== undefined && injected !== '') {
    const v = Number(injected);
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error(`POS_BUDGET_CAP_MS is not a positive number: ${injected}`);
    }
    return v;
  }
  const caps = protocol.budgetCaps || {};
  const cap = caps.msPerVerify ?? caps.budgetCapMsPerVerify;
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new Error('protocol.budgetCaps.msPerVerify is missing or not positive');
  }
  return cap;
}

// ---------------------------------------------------------------------------
// Env stamp pinned onto every record (from the frozen protocol.envPins, not the
// live host: the pin is the claim under test, and the record must carry it).
// ---------------------------------------------------------------------------
function recordEnv() {
  return {
    nodeVersion: ENV_PINS.nodeVersion,
    platform: ENV_PINS.platform,
    instrumentCommit: ENV_PINS.instrumentCommit,
  };
}

// recordDigest = sha256(canonicalJson(record without the recordDigest field)),
// exactly per protocol.recordDigestPreimageRule.
function withDigest(record) {
  const { recordDigest, ...preimage } = record; // eslint-disable-line no-unused-vars
  return { ...record, recordDigest: sha256(canonicalJson(preimage)) };
}

// Append one record as a single JSONL line. Append-only: never rewrites.
function appendRecord(record) {
  appendFileSync(LEDGER_PATH, JSON.stringify(record) + '\n');
}

// ---------------------------------------------------------------------------
// Exclusive lock via mkdir (atomic, fails if the dir already exists). Returned
// releaser is idempotent; the driver releases it in a finally.
// ---------------------------------------------------------------------------
function acquireLock() {
  try {
    mkdirSync(LOCK_DIR); // atomic: throws EEXIST if held
  } catch (e) {
    if (e && e.code === 'EEXIST') return null; // held by another driver
    throw e;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      rmSync(LOCK_DIR, { recursive: true, force: true });
    } catch {
      /* best-effort release */
    }
  };
}

// ---------------------------------------------------------------------------
// Generate a fresh baseline into `dir` (profile=scale, seed=42) and return the
// GENERATION-SIDE manifest (its recordsDigest/goldDigest/manifestDigest are the
// digests we pin on the proof record — sourced from generation, not re-derived).
// ---------------------------------------------------------------------------
function generateBaseline(dir, scale) {
  execFileSync(
    'lattice',
    [
      'memory_playbook_baseline_generate',
      `--profile=${scale}`,
      `--outputDir=${dir}`,
      '--seed=42',
      '--json',
    ],
    { encoding: 'utf8', maxBuffer: 1 << 27 },
  );
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
}

// The full boolean flag vector, honestly named, sourced from the verify result
// (top-level flags) + correctness sub-object.
function verifyFlagVector(v) {
  const c = v.correctness || {};
  return {
    recordsDigestStable: v.recordsDigestStable,
    goldDigestStable: v.goldDigestStable,
    manifestDigestStable: v.manifestDigestStable,
    staleDetected: v.staleDetected,
    requestedProfileMatches: v.requestedProfileMatches,
    profileRecordCountMatches: v.profileRecordCountMatches,
    fullProfileExactMillionMatches: v.fullProfileExactMillionMatches,
    partitionContractPass: c.partitionContractPass,
    sourceDigestMutationMatrixPass: c.sourceDigestMutationMatrixPass,
  };
}

// The gold correctness metric vector from the verify result.
function verifyGoldMetrics(v) {
  const c = v.correctness || {};
  return {
    expectedIdsFoundRate: c.expectedIdsFoundRate,
    goldQueryPresenceRate: c.goldQueryPresenceRate,
    goldRecordPresenceRate: c.goldRecordPresenceRate,
    expectedSuppressedIdsFoundRate: c.expectedSuppressedIdsFoundRate,
    expectedDeprecatedTermHitsFoundRate: c.expectedDeprecatedTermHitsFoundRate,
    currentOverSupersededPreferenceRate: c.currentOverSupersededPreferenceRate,
    candidateFalseSurfaceRate: c.candidateFalseSurfaceRate,
    supersededFalseSurfaceRate: c.supersededFalseSurfaceRate,
    deprecatedFalseSurfaceRate: c.deprecatedFalseSurfaceRate,
    malformedRowsSkipped: c.malformedRowsSkipped,
  };
}

// ---------------------------------------------------------------------------
// Run one replay iteration -> build exactly one record (NOT yet appended, so
// the fault-injection SKIP can decide to drop it). Returns { iterationId,
// record }.
// ---------------------------------------------------------------------------
function runIteration(scale, index, budgetCapMs) {
  const iterationId = `replay/${scale}/${index}`;
  const env = recordEnv();
  const dir = mkdtempSync(join(tmpdir(), `pos-replay-${scale}-${index}-`));
  try {
    const manifest = generateBaseline(dir, scale);
    const v = verifyDir(dir);

    // Crash -> verify_crash stop.
    if (v.status === 'crash') {
      return {
        iterationId,
        record: withDigest({
          iterationId,
          arm: 'replay',
          scale,
          index,
          stopReason: 'verify_crash',
          rawError: String(v.error || 'verify crashed').slice(0, 400),
          env,
        }),
      };
    }

    const elapsedMs = v.performance ? v.performance.elapsedMs : undefined;
    const peakRssBytes = v.performance ? v.performance.peakRssBytes : undefined;

    // Over the budget cap -> budget_cap stop (H4 evidence).
    if (!Number.isFinite(elapsedMs) || elapsedMs > budgetCapMs) {
      return {
        iterationId,
        record: withDigest({
          iterationId,
          arm: 'replay',
          scale,
          index,
          stopReason: 'budget_cap',
          rawError: `verify elapsedMs ${elapsedMs} > budgetCapMs ${budgetCapMs}`,
          env,
        }),
      };
    }

    // Normal verdict within cap -> proof record (H1 evidence).
    return {
      iterationId,
      record: withDigest({
        iterationId,
        arm: 'replay',
        scale,
        index,
        verifyStatus: v.status,
        verifyFlags: verifyFlagVector(v),
        digests: {
          records: manifest.recordsDigest,
          gold: manifest.goldDigest,
          manifest: manifest.manifestDigest,
        },
        goldMetrics: verifyGoldMetrics(v),
        elapsedMs,
        endOfRunRss: peakRssBytes,
        env,
      }),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// H1 / H4 operator summaries (NOT adjudication — that is M4). Reads the proof
// and stop records produced THIS run.
// ---------------------------------------------------------------------------
function printH1Summary(proofRecords) {
  console.log('--- H1 (replay determinism) — operator summary (evidence only) ---');
  const byScale = new Map();
  for (const r of proofRecords) {
    if (!byScale.has(r.scale)) byScale.set(r.scale, []);
    byScale.get(r.scale).push(r);
  }
  for (const [scale, recs] of byScale) {
    if (recs.length < 2) {
      console.log(`  ${scale}: ${recs.length} proof record(s) — need >=2 for a pairwise check`);
      continue;
    }
    const first = recs[0];
    const key = (r) =>
      canonicalJson({
        digests: r.digests,
        goldMetrics: r.goldMetrics,
      });
    const k0 = key(first);
    const allEqual = recs.every((r) => key(r) === k0);
    console.log(
      `  ${scale}: ${recs.length} proof records; pairwise digest+metric equal = ${allEqual}`,
    );
  }
}

function printH4Summary(allRecords) {
  console.log('--- H4 (budget-cap discipline) — operator summary (evidence only) ---');
  const budgetStops = allRecords.filter((r) => r.stopReason === 'budget_cap');
  const proofs = allRecords.filter((r) => r.verifyStatus !== undefined);
  const elapsed = proofs.map((r) => r.elapsedMs);
  const maxElapsed = elapsed.length ? Math.max(...elapsed) : 0;
  console.log(
    `  proof records: ${proofs.length}, max verify elapsedMs = ${maxElapsed}; ` +
      `budget_cap stops = ${budgetStops.length}` +
      (budgetStops.length
        ? ` (${budgetStops.map((r) => r.iterationId).join(', ')})`
        : ' (all within cap)'),
  );
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
function parseScales() {
  const arg = process.argv.find((a) => a.startsWith('--scale='));
  if (!arg) return ['small', 'full'];
  const s = arg.slice('--scale='.length);
  if (s !== 'small' && s !== 'full') {
    console.error(`run-batch FATAL: --scale must be small|full, got '${s}'`);
    process.exit(2);
  }
  return [s];
}

function fatal(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function main() {
  const scales = parseScales();
  const budgetCapMs = resolveBudgetCapMs();
  const skipRecordAt = process.env.POS_SKIP_RECORD_AT || null; // fault injection

  // Expected cross-product of iterationIds for THIS run.
  const expectedIds = [];
  for (const scale of scales) {
    const n = N[scale];
    if (!Number.isInteger(n) || n < 1) fatal(`run-batch FATAL: protocol.N.${scale} invalid: ${n}`, 2);
    for (let i = 1; i <= n; i++) expectedIds.push(`replay/${scale}/${i}`);
  }

  // Acquire the exclusive lock BEFORE touching the ledger.
  const release = acquireLock();
  if (release === null) {
    // Lock held by another driver: record a precondition_failed stop and exit
    // nonzero. This append is the ONLY ledger write on this path.
    const stop = withDigest({
      iterationId: 'replay/precondition/lock',
      stopReason: 'precondition_failed',
      rawError: 'batch-ledger lock held by another driver',
      env: recordEnv(),
    });
    if (!STOP_REASONS.has(stop.stopReason)) {
      fatal(`run-batch FATAL: stopReason not in enum: ${stop.stopReason}`, 2);
    }
    appendRecord(stop);
    fatal('run-batch: could not acquire batch-ledger lock (another driver holds it)', 3);
  }

  const producedThisRun = [];
  try {
    for (const scale of scales) {
      for (let index = 1; index <= N[scale]; index++) {
        const { iterationId, record } = runIteration(scale, index, budgetCapMs);

        // Validate stopReason against the frozen enum (never emit off-enum).
        if (record.stopReason !== undefined && !STOP_REASONS.has(record.stopReason)) {
          fatal(`run-batch FATAL: ${iterationId} produced off-enum stopReason ${record.stopReason}`, 2);
        }

        // Fault injection (recordless test): deliberately DO NOT append the
        // record for the matching iterationId, to simulate a recordless
        // iteration. The end-of-run guard must then catch it.
        if (skipRecordAt && iterationId === skipRecordAt) {
          console.log(`run-batch: [fault-injection] SKIPPING record for ${iterationId}`);
          continue;
        }

        appendRecord(record);
        producedThisRun.push(record);
        const kind = record.stopReason ? `stop:${record.stopReason}` : `proof:${record.verifyStatus}`;
        console.log(`  ${iterationId} -> ${kind}`);
      }
    }
  } finally {
    release();
  }

  // -----------------------------------------------------------------------
  // END-OF-RUN GUARD: the ledger must contain exactly the expected set of
  // iterationIds for this run's scales, one record each. Zero (recordless) OR
  // duplicate => nonzero exit naming the offender.
  // -----------------------------------------------------------------------
  const counts = new Map();
  if (existsSync(LEDGER_PATH)) {
    const lines = readFileSync(LEDGER_PATH, 'utf8').split('\n').filter((l) => l.trim());
    for (const line of lines) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch (e) {
        fatal(`run-batch FATAL: unparseable ledger line: ${String(e.message || e)}`, 1);
      }
      counts.set(rec.iterationId, (counts.get(rec.iterationId) || 0) + 1);
    }
  }

  const recordless = [];
  const duplicated = [];
  for (const id of expectedIds) {
    const c = counts.get(id) || 0;
    if (c === 0) recordless.push(id);
    else if (c > 1) duplicated.push(`${id} (x${c})`);
  }

  // Print evidence summaries regardless (operator visibility), then decide exit.
  const proofRecords = producedThisRun.filter((r) => r.verifyStatus !== undefined);
  printH1Summary(proofRecords);
  printH4Summary(producedThisRun);

  if (recordless.length > 0) {
    fatal(
      `run-batch FAIL: ${recordless.length} recordless iteration(s): ${recordless.join(', ')}`,
      1,
    );
  }
  if (duplicated.length > 0) {
    fatal(
      `run-batch FAIL: ${duplicated.length} duplicated iteration(s): ${duplicated.join(', ')}`,
      1,
    );
  }

  console.log(`campaign complete: ${expectedIds.length} records, 0 recordless`);
  process.exit(0);
}

main();
