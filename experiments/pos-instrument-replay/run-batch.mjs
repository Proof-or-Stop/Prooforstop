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
//   - stop record   <- generate OR verify threw/crashed (stopReason
//                      'verify_crash'), OR verify elapsedMs exceeded the budget
//                      cap (stopReason 'budget_cap'), OR the lock could not be
//                      acquired (stopReason 'precondition_failed').
//
// A crash at ANY point in the iteration is NOT bypassed: the ENTIRE per-iteration
// LIFECYCLE — setup (mkdtemp), generate, verify, build-record, APPEND, and
// cleanup — is guarded, so ANY thrown error (setup / generate / verify / append /
// cleanup: e.g. ENOSPC / EMFILE / permission / disk-full) becomes a best-effort
// verify_crash stop record — a crash never propagates uncaught out of the loop and
// never leaves an iteration recordless-and-silent. The single irreducible case
// (the crash-stop append ITSELF throwing) is caught by a TOP-LEVEL BACKSTOP: the
// end-of-run strict-multiset guard ALWAYS runs, so a recordless iteration still
// forces a named NONZERO exit and the driver NEVER exits 0 with a missing record.
//
// A lock-blocked driver records its precondition_failed stop to a SEPARATE
// blocked-ledger (batch-ledger.blocked.jsonl), NOT the shared campaign ledger,
// so a blocked concurrent driver can never contaminate the campaign evidence.
//
// Every iteration ends in exactly one record. An END-OF-RUN STRICT-MULTISET
// GUARD asserts the ledger holds EXACTLY the protocol cross-product of
// iterationIds for the run's scales, one record each and nothing else; any
// recordless, duplicate, OR extra/unexpected iterationId exits NONZERO.
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
// A lock-blocked driver records its precondition_failed stop HERE, never to the
// shared campaign ledger (F-002b: 'records precondition_failed instead of
// corrupting the ledger', plan section 6.3). Deterministic, sibling path.
const BLOCKED_LEDGER_PATH = join(HERE, 'batch-ledger.blocked.jsonl');
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

// Append one record as a single JSONL line to a given path. Append-only: never
// rewrites. Defaults to the shared campaign ledger.
function appendRecord(record, path = LEDGER_PATH) {
  appendFileSync(path, JSON.stringify(record) + '\n');
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
function generateBaseline(dir, scale, iterationId) {
  // Fault injection (generate-crash test): force an uncaught generate-side
  // failure for the matching iterationId, so the selfcheck can prove a generate
  // crash becomes a verify_crash STOP record (not a raw uncaught crash, not a
  // recordless iteration). The per-iteration try/catch below sentinels it.
  const failGenerateAt = process.env.POS_FAIL_GENERATE_AT || null;
  if (failGenerateAt && iterationId === failGenerateAt) {
    throw new Error(`[fault-injection] forced generate failure at ${iterationId}`);
  }
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
// Build the ONE record for a replay iteration from a fresh sandbox dir. May
// THROW (generate-side / setup faults propagate) — the caller's full-lifecycle
// guard converts any throw into a verify_crash STOP record. Never appends.
// ---------------------------------------------------------------------------
function buildIterationRecord(scale, index, budgetCapMs, dir, iterationId, env) {
  let manifest;
  try {
    manifest = generateBaseline(dir, scale, iterationId);
  } catch (e) {
    // Re-throw tagged so the full-lifecycle guard names the generate phase.
    e.posPhase = 'generate';
    throw e;
  }

  const v = verifyDir(dir);

  // Verify crash sentinel -> verify_crash stop.
  if (v.status === 'crash') {
    return withDigest({
      iterationId,
      arm: 'replay',
      scale,
      index,
      stopReason: 'verify_crash',
      rawError: `[verify] ${String(v.error || 'verify crashed')}`.slice(0, 400),
      env,
    });
  }

  const elapsedMs = v.performance ? v.performance.elapsedMs : undefined;
  const peakRssBytes = v.performance ? v.performance.peakRssBytes : undefined;

  // Over the budget cap -> budget_cap stop (H4 evidence).
  if (!Number.isFinite(elapsedMs) || elapsedMs > budgetCapMs) {
    return withDigest({
      iterationId,
      arm: 'replay',
      scale,
      index,
      stopReason: 'budget_cap',
      rawError: `verify elapsedMs ${elapsedMs} > budgetCapMs ${budgetCapMs}`,
      env,
    });
  }

  // Normal verdict within cap -> proof record (H1 evidence).
  return withDigest({
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
  });
}

// ---------------------------------------------------------------------------
// Run ONE replay iteration through its ENTIRE lifecycle — setup (mkdtemp),
// generate, verify, build-record, APPEND, and cleanup — under a SINGLE
// full-lifecycle guard (F-003/F-004). Returns { iterationId, record, appended }.
//
// The prior F-001 fix guarded only the generate+verify BODY: mkdtemp ran BEFORE
// the try and the append/cleanup ran OUTSIDE it, so a setup/append/cleanup throw
// (ENOSPC / EMFILE / permission / disk-full) escaped uncaught, crashing the
// driver MID-LOOP with NEITHER a stop record NOR the end-of-run guard. Now the
// WHOLE iteration lifecycle is guarded: on ANY throw we best-effort append a
// verify_crash STOP record (tagged with the [phase]) so a crash still becomes
// exactly one record. The single irreducible case — the append ITSELF throwing —
// cannot be recorded here; the top-level backstop in main() (strict-multiset
// guard in a finally) still forces a named NONZERO exit for that recordless
// iteration, so the driver NEVER exits 0 with a missing record.
//
// `appendOne` is injected by main() so the SKIP fault-injection (recordless
// test) can drop the append for one iterationId while the guard stays intact.
// ---------------------------------------------------------------------------
function runIteration(scale, index, budgetCapMs, appendOne) {
  const iterationId = `replay/${scale}/${index}`;
  const env = recordEnv();

  // A stop record for a thrown fault. `phase` names where it threw (setup |
  // generate | verify | append | cleanup). Uses the frozen 'verify_crash'
  // reason (cycle-execution-failure) — do NOT invent a new stopReason; the enum
  // is frozen in protocol.json.
  const crashStop = (err, phase) =>
    withDigest({
      iterationId,
      arm: 'replay',
      scale,
      index,
      stopReason: 'verify_crash',
      rawError: `[${phase}] ${String((err && err.message) || err)}`.slice(0, 400),
      env,
    });

  let dir = null;
  try {
    // SETUP (mkdtemp) is now INSIDE the guard. Fault injection: force a setup
    // throw BEFORE the guarded body so the selfcheck can prove a pre-body crash
    // still becomes a verify_crash stop (or a named nonzero exit).
    const failMkdtempAt = process.env.POS_FAIL_MKDTEMP_AT || null;
    if (failMkdtempAt && iterationId === failMkdtempAt) {
      throw Object.assign(new Error(`[fault-injection] forced mkdtemp failure at ${iterationId}`), {
        posPhase: 'setup',
      });
    }
    dir = mkdtempSync(join(tmpdir(), `pos-replay-${scale}-${index}-`));

    const record = buildIterationRecord(scale, index, budgetCapMs, dir, iterationId, env);

    // APPEND is now INSIDE the guard. Fault injection: force an append-side
    // throw so the selfcheck can prove a post-body/append crash cannot leave the
    // iteration recordless-and-silent.
    const failAppendAt = process.env.POS_FAIL_APPEND_AT || null;
    if (failAppendAt && iterationId === failAppendAt) {
      throw Object.assign(new Error(`[fault-injection] forced append failure at ${iterationId}`), {
        posPhase: 'append',
      });
    }
    const appended = appendOne(record);
    return { iterationId, record, appended };
  } catch (e) {
    // ANY throw in the FULL lifecycle (setup | generate | verify | build |
    // append) becomes a best-effort verify_crash STOP record, never an uncaught
    // propagation. If the append itself threw, we try once more to append the
    // crash stop; if THAT also throws, the record cannot be written here — the
    // top-level backstop guard in main() will still force a named nonzero exit.
    const phase = (e && e.posPhase) || 'verify';
    const stop = crashStop(e, phase);
    let appended = false;
    try {
      appended = appendOne(stop);
    } catch {
      /* irreducible: append itself is failing; main()'s finally-guard catches
         the resulting recordless iteration and exits nonzero. */
    }
    return { iterationId, record: stop, appended };
  } finally {
    // CLEANUP is now INSIDE the guard region. A cleanup throw can no longer
    // escape uncaught (best-effort rm); the record is already appended above.
    if (dir !== null) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup; the iteration is already recorded. */
      }
    }
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
    // Lock held by another driver: record a precondition_failed stop to the
    // SEPARATE blocked-ledger (F-002b) and exit nonzero. This blocked driver
    // must NEVER touch the shared campaign ledger — appending here would
    // contaminate it with an unexpected iterationId. It records
    // precondition_failed to its own deterministic path instead.
    const stop = withDigest({
      iterationId: 'replay/precondition/lock',
      stopReason: 'precondition_failed',
      rawError: 'batch-ledger lock held by another driver',
      env: recordEnv(),
    });
    if (!STOP_REASONS.has(stop.stopReason)) {
      fatal(`run-batch FATAL: stopReason not in enum: ${stop.stopReason}`, 2);
    }
    appendRecord(stop, BLOCKED_LEDGER_PATH);
    fatal('run-batch: could not acquire batch-ledger lock (another driver holds it)', 3);
  }

  // appendOne: the per-iteration append closure injected into runIteration so
  // the whole iteration lifecycle (append INCLUDED) is guarded. Honors the
  // recordless fault injection (SKIP) by deliberately not writing for the
  // matching iterationId, and returns whether the record was actually appended.
  const producedThisRun = [];
  const appendOne = (record) => {
    if (record.stopReason !== undefined && !STOP_REASONS.has(record.stopReason)) {
      fatal(`run-batch FATAL: ${record.iterationId} produced off-enum stopReason ${record.stopReason}`, 2);
    }
    if (skipRecordAt && record.iterationId === skipRecordAt) {
      console.log(`run-batch: [fault-injection] SKIPPING record for ${record.iterationId}`);
      return false;
    }
    appendRecord(record);
    producedThisRun.push(record);
    const kind = record.stopReason ? `stop:${record.stopReason}` : `proof:${record.verifyStatus}`;
    console.log(`  ${record.iterationId} -> ${kind}`);
    return true;
  };

  // -----------------------------------------------------------------------
  // TOP-LEVEL BACKSTOP (F-003/F-004). The campaign loop is wrapped so the
  // end-of-run STRICT-MULTISET guard ALWAYS runs — even if an iteration throws
  // UNCAUGHT (the one irreducible case: the crash-stop append itself failing).
  // We capture any escaped error, ALWAYS release the lock, ALWAYS run the guard,
  // and GUARANTEE the driver never exits 0 with a missing/recordless iteration:
  // a recordless iteration forces a named NONZERO exit and the original error is
  // surfaced (not swallowed). The guard is written defensively so it cannot
  // itself throw and mask the exit code.
  // -----------------------------------------------------------------------
  let loopError = null;
  try {
    for (const scale of scales) {
      for (let index = 1; index <= N[scale]; index++) {
        runIteration(scale, index, budgetCapMs, appendOne);
      }
    }
  } catch (e) {
    // An iteration escaped its full-lifecycle guard (e.g. crash-stop append also
    // threw). Do NOT swallow it — record it and let the end-of-run guard force a
    // named nonzero exit for the resulting recordless iteration.
    loopError = e;
    console.error(`run-batch: iteration threw uncaught: ${String((e && e.stack) || e)}`);
  } finally {
    release();
  }

  runEndOfRunGuard(expectedIds, producedThisRun, loopError);
}

// ---------------------------------------------------------------------------
// END-OF-RUN GUARD (F-002a STRICT EXACT-MULTISET + F-003/F-004 backstop). The
// ledger must contain EXACTLY the expected identity multiset for this run's
// scales — one record per expected iterationId, and NOTHING ELSE. Any MISSING
// (recordless), DUPLICATE, OR EXTRA/unexpected iterationId => NONZERO exit
// naming the offenders. Runs ALWAYS (via main()'s finally-style call), so an
// iteration that escaped uncaught still forces a named nonzero exit — the driver
// NEVER exits 0 with a missing record. Computed defensively so a read/parse
// hiccup cannot mask the exit code (it exits nonzero on any doubt).
// ---------------------------------------------------------------------------
function runEndOfRunGuard(expectedIds, producedThisRun, loopError) {
  const counts = new Map();
  let readError = null;
  try {
    if (existsSync(LEDGER_PATH)) {
      const lines = readFileSync(LEDGER_PATH, 'utf8').split('\n').filter((l) => l.trim());
      for (const line of lines) {
        let rec;
        try {
          rec = JSON.parse(line);
        } catch (e) {
          // A single unparseable line makes the whole ledger untrustworthy: exit
          // nonzero rather than silently miscount.
          fatal(`run-batch FATAL: unparseable ledger line: ${String((e && e.message) || e)}`, 1);
        }
        counts.set(rec.iterationId, (counts.get(rec.iterationId) || 0) + 1);
      }
    }
  } catch (e) {
    // Any unexpected read failure => treat as an incomplete ledger, never a
    // silent success. Fall through with whatever we counted and force nonzero.
    readError = e;
  }

  const expectedSet = new Set(expectedIds);
  const recordless = [];
  const duplicated = [];
  for (const id of expectedIds) {
    const c = counts.get(id) || 0;
    if (c === 0) recordless.push(id);
    else if (c > 1) duplicated.push(`${id} (x${c})`);
  }
  // EXTRA: any observed iterationId that is not in the expected multiset.
  const extra = [];
  for (const [id, c] of counts) {
    if (!expectedSet.has(id)) extra.push(c > 1 ? `${id} (x${c})` : id);
  }

  // Print evidence summaries regardless (operator visibility), then decide exit.
  // Wrapped so a summary bug cannot throw and mask the exit code.
  try {
    const proofRecords = producedThisRun.filter((r) => r.verifyStatus !== undefined);
    printH1Summary(proofRecords);
    printH4Summary(producedThisRun);
  } catch (e) {
    console.error(`run-batch: summary print failed (non-fatal): ${String((e && e.message) || e)}`);
  }

  // If an iteration escaped uncaught, surface it — but only AFTER the guard has
  // decided the exit code, so an incomplete ledger always exits nonzero.
  if (loopError) {
    console.error(
      `run-batch FAIL: an iteration escaped its full-lifecycle guard: ` +
        `${String((loopError && loopError.message) || loopError)}`,
    );
  }
  if (readError) {
    fatal(`run-batch FATAL: could not read the ledger for the end-of-run guard: ${String((readError && readError.message) || readError)}`, 1);
  }

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
  if (extra.length > 0) {
    fatal(
      `run-batch FAIL: ${extra.length} extra/unexpected iteration(s) in ledger: ${extra.join(', ')}`,
      1,
    );
  }

  // Ledger is complete/exact. If an iteration nonetheless escaped uncaught, the
  // ledger being complete means the crash-stop WAS recorded — but do not exit 0
  // on a swallowed error unless the multiset is genuinely exact (it is here).
  if (loopError) {
    fatal(
      `run-batch FAIL: an iteration threw uncaught (see above); refusing to exit 0`,
      1,
    );
  }

  console.log(
    `campaign complete: ${expectedIds.length} records (exact multiset), 0 recordless, 0 extra`,
  );
  process.exit(0);
}

main();
