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
  renameSync,
  rmSync,
  writeFileSync,
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
// F-007/F-008: a SECOND mkdir-based mutex that serializes the RESUME lock-break
// critical-section. Without it the break is a TOCTOU: evaluateLockForBreak()
// (CHECK) and rmSync(LOCK_DIR) (USE) are not atomic, so two --resume drivers can
// BOTH read the SAME genuinely-dead holder, BOTH decide breakable, and then B's
// unconditional rmSync deletes A's freshly-reacquired LIVE lock (both then append
// -> the 'exactly one campaign writer' invariant is violated). The conservative
// missing-holder=LIVE rule (F-005/F-006) does NOT help here (the holder is really
// dead, so both legitimately decide breakable), and an atomic holder rename does
// NOT help (B never re-reads before its rmSync). We fix it by running the ENTIRE
// break critical-section (liveness re-check + destructive rmSync) while holding
// this break-mutex, acquired via atomic mkdir. EEXIST => another resume driver is
// mid-break -> fail closed (precondition_failed, exit nonzero) rather than race.
const BREAK_LOCK_DIR = join(HERE, '.batch-ledger.break.lock');
// Holder stamp inside the lock dir: {"pid": <driver pid>} (F-001). Written by
// acquireLock() after the atomic mkdir wins the lock; read on --resume to check
// whether the lock holder is still ALIVE before breaking a pre-existing lock.
// The stamp is materialized near-atomically (write a sibling temp file then
// rename() it into place) so a concurrent --resume reader NEVER observes a
// half-written holder.json — it sees EITHER no holder yet OR the complete stamp,
// never a partial one (F-005/F-006 acquire-window minimization).
const HOLDER_PATH = join(LOCK_DIR, 'holder.json');
const HOLDER_TMP_PATH = join(LOCK_DIR, 'holder.json.tmp');
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
// RESUME SUPPORT (M3, ADDITIVE). Read the set of iterationIds already recorded
// in an existing ledger so a resumed run can SKIP them and re-run only the
// remaining expected iterations. Append-only is preserved: this NEVER rewrites
// the ledger. A SIGKILL mid-append can leave the LAST line as a truncated /
// partial JSON fragment; that trailing partial is IGNORED (not counted as a
// recorded iterationId, so its iteration is re-run) and never treated as a hard
// parse error here. All well-formed prior lines are honored. Returns a Set of
// iterationIds that already have a complete record. Only called on the resume
// path — the fresh path never invokes this, so fresh behavior is unchanged.
// ---------------------------------------------------------------------------
function readRecordedIterationIds(path = LEDGER_PATH) {
  const recorded = new Set();
  if (!existsSync(path)) return recorded;
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue; // blank / trailing newline
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      // Only tolerate an unparseable line if it is the LAST non-empty content
      // (a mid-append truncation). Its iteration is left UN-recorded so resume
      // re-runs it. A malformed line in the INTERIOR is a corrupt ledger: we do
      // not repair it here — the end-of-run strict guard re-reads the ledger and
      // fails nonzero on any unparseable line, so we simply skip counting it and
      // let the guard adjudicate the final state.
      const restNonEmpty = lines
        .slice(i + 1)
        .some((l) => l.trim());
      if (restNonEmpty) {
        // Interior unparseable line: leave it uncounted; the end-of-run guard
        // will still re-read the full ledger and decide the exit code.
        continue;
      }
      // Trailing truncated line: ignore it (repair-by-omission). Its iterationId
      // is unknown / partial, so the corresponding iteration is treated as NOT
      // recorded and will be re-run on resume.
      continue;
    }
    if (rec && typeof rec.iterationId === 'string') {
      recorded.add(rec.iterationId);
    }
  }
  return recorded;
}

// ---------------------------------------------------------------------------
// REPAIR a mid-append truncation (M3, ADDITIVE, RESUME-ONLY). A SIGKILL during
// appendFileSync can leave the ledger's LAST line as a partial JSON fragment
// with NO terminating newline. If a later append ran onto that partial line it
// would concatenate into ONE corrupt line that the end-of-run strict guard
// rejects. On resume we therefore rewrite the ledger to end at the last
// WELL-FORMED newline boundary, DROPPING ONLY the never-completed trailing
// partial write. Every COMPLETE prior record is preserved verbatim (append-only
// for real records is intact — we discard only bytes that were never a finished
// line). Returns true iff a trailing partial was dropped. Called ONLY on the
// resume path; the fresh path never rewrites the ledger.
// Does `segment` parse to a COMPLETE ledger record — a JSON object carrying a
// string iterationId (a proof or stop record)? Used by repairTruncatedTail to
// decide whether an un-terminated trailing segment is a real record that merely
// lost its newline (KEEP — real evidence) vs a genuinely-incomplete partial
// write (drop). A bare scalar / array / object without an iterationId is NOT a
// ledger record and is treated as a partial to drop. (F-002/F-003.)
function isCompleteLedgerRecordLine(segment) {
  let rec;
  try {
    rec = JSON.parse(segment);
  } catch {
    return false;
  }
  return (
    rec !== null &&
    typeof rec === 'object' &&
    !Array.isArray(rec) &&
    typeof rec.iterationId === 'string'
  );
}

function repairTruncatedTail(path = LEDGER_PATH) {
  if (!existsSync(path)) return false;
  const raw = readFileSync(path, 'utf8');
  if (raw === '') return false;
  // A complete JSONL ledger ends with '\n'. If it does NOT, the final line is an
  // unterminated (truncated) write. Additionally, even if it ends with '\n', the
  // last content line could itself be malformed — but a terminated line is a
  // completed append, so we only repair the UNTERMINATED tail case here.
  if (raw.endsWith('\n')) {
    // The tail is newline-terminated: no in-progress partial write to repair.
    // (An interior/terminated malformed line is left for the end-of-run guard to
    // adjudicate — we never silently rewrite a completed line.)
    return false;
  }
  const lastNl = raw.lastIndexOf('\n');
  if (lastNl < 0) {
    // The ENTIRE file is a single unterminated line (a SIGKILL during the very
    // first append). It is EITHER a genuinely-incomplete partial write (drop) OR
    // a COMPLETE record whose line merely lost its trailing '\n' (KEEP — real
    // evidence). F-002/F-003: parse before dropping, consistent with the
    // multi-line branch below (a complete record must NEVER become a spurious
    // GAP). Drop wholesale ONLY if it does NOT parse to a valid record.
    if (isCompleteLedgerRecordLine(raw)) {
      // A lone complete record missing only its newline: PRESERVE + re-terminate
      // so later appends land on a clean line boundary. No record dropped.
      writeFileSync(path, raw + '\n');
      console.log(
        'run-batch: [resume] the single trailing line is a COMPLETE record missing only its ' +
          'newline — preserved and re-terminated (no record dropped)',
      );
      return false;
    }
    writeFileSync(path, '');
    console.log('run-batch: [resume] repaired a truncated trailing line (dropped the partial write)');
    return true;
  }
  // The trailing segment after the last newline is un-terminated. It is EITHER a
  // genuinely-incomplete partial write (a real mid-append truncation to drop) OR
  // a COMPLETE valid record whose line merely lost its final '\n' at EOF (real
  // evidence — must NOT be dropped, or that iteration becomes a spurious GAP).
  // F-002/F-003: parse before dropping — make this multi-line branch CONSISTENT
  // with the single-line branch above. Drop the tail ONLY if it does NOT parse
  // to a valid record; if it parses, KEEP it (append the missing newline so
  // subsequent appends land on a clean line boundary). Never delete a complete
  // record.
  const tail = raw.slice(lastNl + 1);
  if (isCompleteLedgerRecordLine(tail)) {
    // Complete record missing only its trailing newline: PRESERVE it. Re-terminate
    // it so later appends resume from a clean newline boundary. This is not a
    // repair-by-omission — no record is dropped — so return false.
    writeFileSync(path, raw + '\n');
    console.log(
      'run-batch: [resume] trailing line is a COMPLETE record missing only its newline — ' +
        'preserved and re-terminated (no record dropped)',
    );
    return false;
  }
  // Genuinely incomplete partial write: keep everything up to and INCLUDING the
  // last newline; drop only the never-completed trailing fragment. The resume
  // scan treats the dropped iteration as un-recorded and re-runs it; the
  // append-only real records above are untouched.
  const repaired = raw.slice(0, lastNl + 1);
  writeFileSync(path, repaired);
  console.log('run-batch: [resume] repaired a truncated trailing line (dropped the partial write)');
  return true;
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
  // ADDITIVE (F-001): after the atomic mkdir wins the lock, stamp a holder file
  // recording THIS process's pid, so a later --resume run can distinguish a
  // STALE lock (holder pid is dead) from a LIVE concurrent driver (holder pid is
  // alive) before deciding whether to break it. This does NOT change the M2
  // precondition_failed behavior: a second driver still loses the mkdir above
  // and gets null regardless of this file.
  //
  // F-005/F-006: there is an unavoidable window between winning mkdir(LOCK_DIR)
  // and materializing holder.json. To make that window as small and as clean as
  // practical the stamp is written near-atomically: write to a sibling temp path
  // and rename() it into holder.json (rename is atomic within a directory), so a
  // concurrent --resume reader NEVER sees a half-written holder — it observes
  // EITHER no holder yet OR the complete stamp. And critically, the resume
  // lock-break decision is now CONSERVATIVE (evaluateLockForBreak returns LIVE for a
  // missing/unreadable/malformed/uncertain holder), so even if this driver is
  // still in the mkdir->stamp window OR the write failed, a concurrent resume
  // will NOT break the lock. The mkdir itself remains the real mutual-exclusion.
  try {
    writeFileSync(HOLDER_TMP_PATH, JSON.stringify({ pid: process.pid }) + '\n');
    renameSync(HOLDER_TMP_PATH, HOLDER_PATH);
  } catch {
    /* best-effort holder stamp; the mkdir lock is authoritative and resume now
       treats a missing/failed holder CONSERVATIVELY as LIVE (never broken). */
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
// Decide whether a pre-existing lock may be BROKEN on resume (F-001 + F-005/F-006
// CONSERVATIVE inversion, RESUME-ONLY). Reads LOCK_DIR/holder.json, parses .pid,
// and probes it with process.kill(pid, 0): signal 0 does not deliver a signal —
// it only performs the existence / permission check, throwing ESRCH when NO such
// process exists (dead).
//
// F-005/F-006 (the acquire-window race): acquireLock() wins mkdir(LOCK_DIR)
// BEFORE it materializes holder.json. In that tiny window a concurrent --resume
// driver would see the lock dir with NO (or, absent the rename() stamp, a
// half-written) holder.json. The OLD code treated a missing/malformed holder as
// STALE (breakable), so a resume driver could break a LIVE driver's freshly-won
// lock in that window and both would append -> ledger corruption. This is now
// INVERTED to CONSERVATIVE: the lock is breakable ONLY when we POSITIVELY prove
// a dead holder — holder.json EXISTS, parses to a valid { pid }, and that pid is
// DEAD (process.kill throws ESRCH). ANY other outcome — a missing holder, an
// unreadable/malformed/unparseable holder, a holder without a usable pid, or an
// ambiguous/uncertain liveness probe — is treated as LIVE (do NOT break).
//
// Correctness: a genuinely-orphaned prior interrupted run DID write holder.json
// (via the atomic rename) before it crashed, so its dead pid is present and the
// lock is STILL auto-broken on resume. Only a crash in the tiny mkdir->stamp
// window leaves a holder-less lock, which is now conservatively NOT auto-broken —
// a safe failure requiring manual cleanup, never corruption.
//
// Returns a verdict object { breakable, reason }:
//   - { breakable: true }  -> proven-dead holder; resume may reclaim the lock.
//   - { breakable: false } -> LIVE or UNCERTAIN; resume must refuse to break it
//                             (records precondition_failed and exits nonzero).
// An EPERM from process.kill means the pid EXISTS but is owned by another user
// -> ALIVE -> not breakable.
function evaluateLockForBreak() {
  let raw;
  try {
    raw = readFileSync(HOLDER_PATH, 'utf8');
  } catch {
    // No holder.json (or unreadable): this is the acquire-window signature (a
    // driver won mkdir but has not yet stamped) OR a genuinely unusable stamp.
    // CONSERVATIVE: treat as LIVE, do NOT break.
    return { breakable: false, reason: 'holder.json missing/unreadable (treated as LIVE)' };
  }
  let pid;
  try {
    const holder = JSON.parse(raw);
    pid = holder && holder.pid;
  } catch {
    // Malformed/unparseable holder (e.g. a partial write before the rename fix,
    // or corruption): we cannot prove a dead holder -> CONSERVATIVE LIVE.
    return { breakable: false, reason: 'holder.json malformed/unparseable (treated as LIVE)' };
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    // No usable pid: cannot prove a dead holder -> CONSERVATIVE LIVE.
    return { breakable: false, reason: 'holder.json has no usable pid (treated as LIVE)' };
  }
  try {
    process.kill(pid, 0); // existence probe; no signal actually delivered
    return { breakable: false, reason: `holder pid ${pid} is ALIVE` }; // no throw -> alive
  } catch (e) {
    if (e && e.code === 'EPERM') {
      return { breakable: false, reason: `holder pid ${pid} exists (EPERM, owned by another user) -> ALIVE` };
    }
    if (e && e.code === 'ESRCH') {
      // POSITIVELY proven dead: the ONLY case where we may break the lock.
      return { breakable: true, reason: `holder pid ${pid} is DEAD (ESRCH)` };
    }
    // Any OTHER probe error is ambiguous/uncertain -> CONSERVATIVE LIVE (do not
    // break on doubt).
    return {
      breakable: false,
      reason: `holder pid ${pid} liveness probe uncertain (${(e && e.code) || 'unknown'}) -> treated as LIVE`,
    };
  }
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

    // HARD-CRASH HOOK (M3, ADDITIVE). POS_CRASH_BEFORE_APPEND_AT=<iterationId>:
    // at that iteration, AFTER generate+verify (the workspace is written) but
    // IMMEDIATELY BEFORE appending the record, hard-exit the process WITHOUT
    // writing the record — simulating a SIGKILL mid-iteration. This leaves that
    // iterationId RECORDLESS (the deterministic mid-iteration casualty), which
    // is DISTINCT from POS_FAIL_APPEND_AT below (a caught throw that becomes a
    // verify_crash STOP record). The hard-crash writes NO record and bypasses
    // the try/catch entirely (process.exit is not catchable). Only active when
    // the env var is set, so the fresh-campaign path is byte-behavior-unchanged.
    const crashBeforeAppendAt = process.env.POS_CRASH_BEFORE_APPEND_AT || null;
    if (crashBeforeAppendAt && iterationId === crashBeforeAppendAt) {
      console.error(
        `run-batch: [hard-crash] POS_CRASH_BEFORE_APPEND_AT hard-exit at ${iterationId} ` +
          `(workspace written, record NOT appended) — simulating SIGKILL`,
      );
      // Do NOT clean up dir here: process.exit(137) mimics an external SIGKILL
      // where finally/cleanup would not run either. The mkdtemp dir is under the
      // OS tmpdir and is reaped by the sandbox teardown.
      process.exit(137);
    }

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

// RESUME mode is opt-in via --resume or POS_RESUME=1 (ADDITIVE). Absent, the
// driver behaves EXACTLY as before (a pre-existing ledger still triggers the M2
// end-of-run guard as today — resume does not change that).
function parseResume() {
  const flag = process.argv.includes('--resume');
  const env = process.env.POS_RESUME === '1';
  return flag || env;
}

function fatal(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function main() {
  const scales = parseScales();
  const budgetCapMs = resolveBudgetCapMs();
  const skipRecordAt = process.env.POS_SKIP_RECORD_AT || null; // fault injection
  const resume = parseResume(); // M3 ADDITIVE: opt-in resume mode

  // Expected cross-product of iterationIds for THIS run.
  const expectedIds = [];
  for (const scale of scales) {
    const n = N[scale];
    if (!Number.isInteger(n) || n < 1) fatal(`run-batch FATAL: protocol.N.${scale} invalid: ${n}`, 2);
    for (let i = 1; i <= n; i++) expectedIds.push(`replay/${scale}/${i}`);
  }

  // RESUME (M3, ADDITIVE): break a STALE lock left by the interrupted prior run —
  // but ONLY if its holder is POSITIVELY proven DEAD (F-001 + F-005/F-006). A
  // hard crash / SIGKILL exits without running the release() finally, so the
  // mkdir-lock dir is orphaned on disk with a holder.json whose pid is now dead.
  // That is the lock resume is meant to reclaim. But a resuming driver B must
  // NOT clobber a genuinely LIVE driver A's lock (two writers -> ledger
  // corruption): evaluateLockForBreak() reads holder.json.pid and probes liveness
  // via process.kill(pid, 0) (throws ESRCH when the process is dead, does NOT
  // signal a live one).
  //
  // F-005/F-006 CONSERVATIVE RULE: we break the lock ONLY when the holder is
  // POSITIVELY proven DEAD (holder.json exists, parses to a valid { pid }, and
  // that pid is dead). A MISSING / unreadable / malformed holder, or an ambiguous
  // liveness probe, is treated as LIVE (the acquire-window: a driver won mkdir
  // but has not yet stamped holder.json — breaking now would corrupt the ledger).
  // In every non-proven-dead case we treat it as a genuine concurrent driver:
  // record precondition_failed to the SEPARATE blocked-ledger and exit nonzero,
  // exactly like M2's concurrent-driver path. This is gated on `resume`, so the
  // non-resume lock semantics are UNCHANGED.
  if (resume) {
    // F-007/F-008: serialize the break critical-section behind a dedicated
    // break-mutex so the CHECK (evaluateLockForBreak) and the USE
    // (rmSync(LOCK_DIR)) can never interleave with ANOTHER resume driver. The
    // conservative missing-holder=LIVE rule and the atomic holder rename do not
    // close this hole because a genuinely-dead holder legitimately reads as
    // breakable for BOTH drivers, and a second breaker never re-reads before its
    // unconditional rmSync. Only mutual exclusion over the whole section fixes it.
    //
    // Acquire the break-mutex (atomic mkdir). EEXIST => another resume driver is
    // mid-break -> fail closed (never race it): precondition_failed, exit 3.
    let breakMutexHeld = false;
    try {
      mkdirSync(BREAK_LOCK_DIR); // atomic: throws EEXIST if another breaker holds it
      breakMutexHeld = true;
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        const stop = withDigest({
          iterationId: 'replay/precondition/lock',
          stopReason: 'precondition_failed',
          rawError:
            'batch-ledger break-mutex held (another resume driver is mid-break)',
          env: recordEnv(),
        });
        if (!STOP_REASONS.has(stop.stopReason)) {
          fatal(`run-batch FATAL: stopReason not in enum: ${stop.stopReason}`, 2);
        }
        appendRecord(stop, BLOCKED_LEDGER_PATH);
        fatal(
          'run-batch: [resume] a lock-break is already in progress (break-mutex held) — recorded precondition_failed',
          3,
        );
      }
      throw e;
    }
    // Holding the break-mutex: the CHECK and the rmSync now cannot interleave with
    // another breaker. Compute the decision inside the try, and ALWAYS release the
    // mutex in a finally BEFORE any process.exit. CRITICAL: process.exit() does NOT
    // run finally blocks, so we must NOT call fatal()/process.exit while inside the
    // try — we capture the decision (precondReason), release the mutex in finally,
    // then perform the exit AFTER the try/finally.
    //
    // The break-mutex is held for only a handful of SYNCHRONOUS syscalls
    // (existsSync + readFileSync + JSON.parse + process.kill + rmSync); there is no
    // subprocess spawn and no await inside the section, so it is released
    // essentially immediately on every path. The one residual failure mode: if a
    // process is SIGKILLed WHILE mid-break, BREAK_LOCK_DIR is orphaned on disk and
    // future resumes fail closed (precondition_failed) until it is manually removed
    // — the SAFE failure (a wedged resume), never ledger corruption. We accept that
    // tradeoff: a stuck break-mutex is recoverable by an operator; two campaign
    // writers is not.
    let precondReason = null;
    // F-010: capture (do NOT process.exit) a destructive-break failure so the
    // break-mutex finally still runs to release BREAK_LOCK_DIR; the explicit
    // diagnostic + exit 2 is raised AFTER the try/finally. breakError and
    // precondReason are mutually exclusive (a break is either refused, succeeds,
    // or fails to remove the lock — never two of those at once).
    let breakError = null;
    try {
      if (existsSync(LOCK_DIR)) {
        const verdict = evaluateLockForBreak();
        if (!verdict.breakable) {
          // LIVE or UNCERTAIN holder (incl. the missing-holder acquire window). Do
          // NOT break it. Capture the reason; the precondition_failed stop is
          // recorded and the process exits AFTER the mutex is released.
          precondReason =
            'batch-ledger lock not proven stale (resume refused to break it): ' + verdict.reason;
        } else {
          console.log(
            'run-batch: [resume] breaking a STALE lock left by the interrupted prior run (' +
              verdict.reason +
              ')',
          );
          // F-010: capture an rmSync failure into breakError instead of letting it
          // propagate UNCAUGHT (generic stack trace + exit 1). Do NOT process.exit
          // in here — the finally below must run first to release the break-mutex.
          try {
            // Fault injection (F-010/F-015 test): force the stale-lock break to fail so
            // the selfcheck can prove it becomes the explicit exit-2 diagnostic (and that
            // the break-mutex is still released by the finally, not orphaned).
            if (process.env.POS_FAIL_LOCK_BREAK === '1') {
              throw new Error('[fault-injection] forced lock-break failure');
            }
            rmSync(LOCK_DIR, { recursive: true, force: true });
          } catch (e) {
            breakError = e;
          }
        }
      }
    } finally {
      // Release the break-mutex on EVERY path (success, refusal, or throw) so the
      // happy path leaves NO orphaned BREAK_LOCK_DIR behind.
      if (breakMutexHeld) {
        try {
          rmSync(BREAK_LOCK_DIR, { recursive: true, force: true });
        } catch {
          /* best-effort release of the break-mutex */
        }
      }
    }
    // F-010: restore the explicit stale-lock-break diagnostic + exit 2. The
    // break-mutex finally above has already released BREAK_LOCK_DIR, so this exit
    // does not orphan it. Raised BEFORE the precondReason check (they are mutually
    // exclusive; a capture here means the break itself failed).
    if (breakError) {
      fatal(
        `run-batch FATAL: [resume] could not break the stale lock ${LOCK_DIR}: ${String((breakError && breakError.message) || breakError)}`,
        2,
      );
    }
    if (precondReason !== null) {
      // Refused to break: record a precondition_failed stop to the blocked-ledger
      // (never the campaign ledger) and exit nonzero — same disposition as M2's
      // lock-held path. Done AFTER releasing the break-mutex (see the CRITICAL note
      // above about process.exit not running finally blocks).
      const stop = withDigest({
        iterationId: 'replay/precondition/lock',
        stopReason: 'precondition_failed',
        rawError: precondReason,
        env: recordEnv(),
      });
      if (!STOP_REASONS.has(stop.stopReason)) {
        fatal(`run-batch FATAL: stopReason not in enum: ${stop.stopReason}`, 2);
      }
      appendRecord(stop, BLOCKED_LEDGER_PATH);
      fatal(
        'run-batch: [resume] refused to break a lock that is not proven stale — ' +
          precondReason +
          ' (recorded precondition_failed to the blocked-ledger)',
        3,
      );
    }
  }

  // Acquire the exclusive lock BEFORE touching the ledger. The atomic
  // mkdir(LOCK_DIR) is the FINAL arbiter for BOTH fresh and resume drivers: we do
  // NOT hold the break-mutex across this call, so the tiny window between releasing
  // BREAK_LOCK_DIR and this mkdir is safe — two concurrent mkdir(LOCK_DIR) still
  // resolve to exactly one winner, and the loser gets null -> precondition_failed.
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

  // F-009/F-011: a FRESH (non-resume) driver must never append onto a non-empty
  // pre-existing campaign ledger (that produces on-disk duplicates the end-guard
  // rejects but cannot repair — a poisoned evidence file). A stale lock normally
  // keeps a fresh driver out, but resume recovery opens a break-to-reacquire window
  // where a fresh driver can win the lock; refuse under the lock, before any append.
  // Serialized UNDER the campaign lock (release !== null here) so the ledger state
  // is stable, and BEFORE the resume/loop logic below.
  if (!resume) {
    // F-009/F-011/F-013: a FRESH (non-resume) driver must never append onto a
    // pre-existing non-empty campaign ledger. F-013 (fail-CLOSED): if the ledger
    // EXISTS but is UNREADABLE (write-only / EACCES / any read error), we cannot
    // prove it is safe to start fresh over it -> REFUSE (treat as non-empty). Only a
    // provably-absent OR provably-empty ledger permits a fresh run.
    let existingLedgerNonEmpty = false;
    try {
      if (existsSync(LEDGER_PATH)) {
        // Fault injection (F-013 test): force the read to throw so the selfcheck can
        // prove an unreadable-but-existing ledger makes a fresh run FAIL CLOSED.
        if (process.env.POS_FAIL_LEDGER_READ === '1') {
          throw new Error('[fault-injection] forced ledger read failure');
        }
        existingLedgerNonEmpty = readFileSync(LEDGER_PATH, 'utf8').trim() !== '';
      }
    } catch {
      // The ledger EXISTS (existsSync was true) but could not be read -> FAIL CLOSED.
      existingLedgerNonEmpty = true;
    }
    if (existingLedgerNonEmpty) {
      release(); // release the campaign lock before exiting
      const stop = withDigest({
        iterationId: 'replay/precondition/ledger',
        stopReason: 'precondition_failed',
        rawError:
          'fresh (non-resume) run refused: batch-ledger.jsonl already exists and is non-empty (use --resume to continue an interrupted run, or remove the ledger to start fresh)',
        env: recordEnv(),
      });
      if (!STOP_REASONS.has(stop.stopReason)) {
        fatal(`run-batch FATAL: stopReason not in enum: ${stop.stopReason}`, 2);
      }
      appendRecord(stop, BLOCKED_LEDGER_PATH);
      fatal(
        'run-batch: fresh run refused — batch-ledger.jsonl already exists and is non-empty (use --resume, or remove the ledger) — recorded precondition_failed',
        3,
      );
    }
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
  // RESUME (M3, ADDITIVE): under the lock (so no concurrent writer can race),
  // read the iterationIds already recorded in the existing ledger and SKIP them,
  // running only the remaining expected iterations. A truncated trailing line is
  // ignored/repaired by readRecordedIterationIds so its iteration is re-run.
  // Append-only is preserved (existing lines are never rewritten). With NO
  // existing ledger this Set is empty, so --resume behaves as a fresh run. When
  // resume is OFF, alreadyRecorded stays empty and the loop is byte-behavior
  // identical to before.
  let alreadyRecorded = new Set();
  if (resume) {
    // Repair a mid-append truncation FIRST so subsequent appends resume from a
    // clean newline boundary and the end-of-run guard never sees a corrupt line.
    repairTruncatedTail(LEDGER_PATH);
    alreadyRecorded = readRecordedIterationIds(LEDGER_PATH);
    const skippedCount = expectedIds.filter((id) => alreadyRecorded.has(id)).length;
    console.log(
      `run-batch: [resume] ${alreadyRecorded.size} record(s) already present; ` +
        `skipping ${skippedCount}/${expectedIds.length} expected iteration(s), ` +
        `running the remaining ${expectedIds.length - skippedCount}`,
    );
  }

  let loopError = null;
  try {
    for (const scale of scales) {
      for (let index = 1; index <= N[scale]; index++) {
        const iterationId = `replay/${scale}/${index}`;
        if (resume && alreadyRecorded.has(iterationId)) {
          // Already recorded in a prior (interrupted) run: do NOT re-run and do
          // NOT rewrite. The end-of-run strict-multiset guard reconciles the
          // FINAL ledger (pre-existing + newly-appended) for 0 dup / 0 gap.
          continue;
        }
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
