#!/usr/bin/env node
// score.mjs — M4 deterministic per-arm-run scoring oracle (experience-ablation).
//
// Assembles ONE `proofbound.experience-ablation-score.v1` record (plan S10)
// from on-disk artifacts only: a FIXTURE directory (fixture-generator.mjs
// output: task.json + hidden oracle.mjs) and a RUN directory (the M6 campaign
// runner's per-arm-run record — the BINDING layout is RUN-RECORD.md, next to
// this file). Replay-stable by construction: scoring never re-runs hosts.
//
// PURITY CONTRACT
//   - scoreArmRun({fixtureDir, runDir}) reads ONLY under fixtureDir and
//     runDir; no network, no clock (every timestamp-derived value comes from
//     run.json inputs), no mutation of either directory.
//   - The one non-input constant is the DEFAULT production-learning-root path
//     used by the S12 store-isolation assertion: a path STRING derived from
//     this module's own location (import.meta.url) — never a disk read. Pass
//     `productionLearningRoot` to override (the selfcheck does).
//   - Output key order is fixed (SCORE_KEY_ORDER + a fixed details shape), so
//     two invocations over the same inputs are byte-identical.
//
// OUTCOME SEMANTICS (plan S6.1 / S6.2 / S10 / S12)
//   - defectPresent  = validationPass===false OR falseDoneAttempt OR
//                      oracleMismatch OR laneProvenanceViolation  (S6.1).
//   - falseDoneAttempt precedence: when a STRUCTURED source is present
//     (done-readiness.json rows and/or final-response-check.json records) the
//     structured verdict is authoritative; only when BOTH are absent does the
//     hidden fixture oracle's falseDoneAttempt serve as fallback.
//     details.sources.falseDoneAttempt records which source decided.
//   - repeatDefectPresent (S6.2) = defectPresent AND trapGroup 'in_store' AND
//     the fixture declares expectedMemoryIds (an active lesson exists).
//   - oracleMismatch / laneProvenanceViolation come from the fixture's hidden
//     oracle (task.json oracleRef) classifying the RUN workspace copy
//     (<runDir>/workspace) — NEVER the pristine fixture workspace.
//   - Store isolation (S12): a run whose normalized absolute storeRoot equals
//     (or lies inside) the shared production learning root is marked
//     voided:true with a reason naming store isolation. Voiding never hides
//     the scored fields — the record is still fully populated.
//
// EVENT MAPPING (M3 vocabulary, story B-ab8d)
//   - experience_pack_surfaced {experimentId, arm, topHitIds, ...}: fires on
//     BOTH arms; surfacedMemoryIds = first-seen-order union of topHitIds over
//     events matching run.json experimentId. memoryPackShown is true only on
//     the treatment arm with at least one such event (control shadow-logs).
//   - retrieval_violation {experimentId, command, ...}: control-arm blocked
//     retrieval attempts; retrievalViolationCount = matching-event count.
//
// CLI
//   node score.mjs --fixture=<dir> --run=<dir> [--out=<file>]
//                  [--productionLearningRoot=<dir>]
//   Prints the record to stdout (or writes it to --out and stays silent).
//   Any input problem exits nonzero with exactly ONE actionable line.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SCORE_SCHEMA_VERSION = 'proofbound.experience-ablation-score.v1';

/** Fixed top-level key order of the emitted record (plan S10 order + the
 * voiding/provenance extensions). renderScoreRecord enforces it. */
export const SCORE_KEY_ORDER = [
  'schemaVersion', 'experimentId', 'taskId', 'pairId', 'arm', 'hostId',
  'trapClass', 'trapGroup', 'cleanTask', 'memoryPackShown',
  'expectedMemoryIds', 'surfacedMemoryIds', 'storeRoot', 'defectPresent',
  'repeatDefectPresent', 'falseDoneAttempt', 'oracleMismatch',
  'laneProvenanceViolation', 'validationPass', 'doneReached', 'timeToDoneMs',
  'commandCount', 'retrievalViolationCount', 'evidenceRefs',
  'voided', 'voidReason', 'details',
];

/** One-line actionable failure; the CLI prints err.message verbatim. */
function fail(msg) {
  throw new Error(`score: ${String(msg).replace(/\s*\n\s*/g, ' ')}`);
}

function readJsonFile(path, label) {
  if (!existsSync(path)) fail(`missing required ${label} file: ${path}`);
  const text = readFileSync(path, 'utf8');
  try { return JSON.parse(text); }
  catch { fail(`${label} file is not valid JSON: ${path}`); }
}

function readOptionalJsonFile(path, label) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  try { return JSON.parse(text); }
  catch { fail(`${label} file is not valid JSON: ${path}`); }
}

function requireString(obj, key, where) {
  const v = obj[key];
  if (typeof v !== 'string' || v.trim().length === 0) {
    fail(`${where} field "${key}" must be a non-empty string (got ${JSON.stringify(v)})`);
  }
  return v;
}

function requireBoolean(obj, key, where) {
  const v = obj[key];
  if (typeof v !== 'boolean') fail(`${where} field "${key}" must be a boolean (got ${JSON.stringify(v)})`);
  return v;
}

/** DEFAULT S12 production learning root: <repoRoot>/.lattice/learning, where
 * repoRoot is derived from this module's location (a pure path computation —
 * experiments/experience-ablation/ is two levels below the repo root). */
export function defaultProductionLearningRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  return normalize(join(here, '..', '..', '.lattice', 'learning'));
}

/** Parse the run-scoped activity.jsonl slice into event objects. */
function readActivitySlice(path) {
  if (!existsSync(path)) fail(`missing required run record file: ${path}`);
  const lines = readFileSync(path, 'utf8').split('\n');
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); }
    catch { fail(`activity.jsonl line ${i + 1} is not valid JSON: ${path}`); }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      fail(`activity.jsonl line ${i + 1} is not an event object: ${path}`);
    }
    events.push(obj);
  }
  return events;
}

/** timeToDoneMs: explicit run.json value wins; otherwise derived from the
 * startedAt/endedAt input timestamps (no clock read, plan S10). */
function resolveTimeToDoneMs(run) {
  if ('timeToDoneMs' in run) {
    const v = run.timeToDoneMs;
    if (v === null) return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      fail(`run.json field "timeToDoneMs" must be null or a non-negative finite number (got ${JSON.stringify(v)})`);
    }
    return v;
  }
  const started = Date.parse(run.startedAt ?? '');
  const ended = Date.parse(run.endedAt ?? '');
  if (Number.isNaN(started) || Number.isNaN(ended)) {
    fail('run.json must provide timeToDoneMs (number|null) or both startedAt and endedAt as parseable ISO timestamps');
  }
  if (ended < started) fail('run.json endedAt precedes startedAt');
  return ended - started;
}

/** Structured false-DONE sources (shapes defined in RUN-RECORD.md). Returns
 * {value, decidedBy, present:{doneReadiness, finalResponseCheck}}. */
function resolveFalseDoneAttempt(runDir, oracleOutcome) {
  const drPath = join(runDir, 'done-readiness.json');
  const frcPath = join(runDir, 'final-response-check.json');
  const dr = readOptionalJsonFile(drPath, 'done-readiness');
  const frc = readOptionalJsonFile(frcPath, 'final-response-check');
  if (dr !== null && !Array.isArray(dr.rows)) fail(`done-readiness.json must contain a "rows" array: ${drPath}`);
  if (frc !== null && !Array.isArray(frc.records)) fail(`final-response-check.json must contain a "records" array: ${frcPath}`);
  const present = { doneReadiness: dr !== null, finalResponseCheck: frc !== null };
  if (dr === null && frc === null) {
    return { value: Boolean(oracleOutcome.falseDoneAttempt), decidedBy: 'oracle-fallback', present };
  }
  let rowsFired = false;
  if (dr !== null) {
    for (let i = 0; i < dr.rows.length; i++) {
      const row = dr.rows[i];
      if (row === null || typeof row !== 'object' || typeof row.ready !== 'boolean') {
        fail(`done-readiness.json rows[${i}] must be an object with a boolean "ready": ${drPath}`);
      }
      if (row.ready === false) rowsFired = true;
    }
  }
  let recordsFired = false;
  if (frc !== null) {
    for (let i = 0; i < frc.records.length; i++) {
      const rec = frc.records[i];
      if (rec === null || typeof rec !== 'object' || (rec.verdict !== 'pass' && rec.verdict !== 'fail')) {
        fail(`final-response-check.json records[${i}] must be an object with verdict "pass" or "fail": ${frcPath}`);
      }
      if (rec.verdict === 'fail') recordsFired = true;
    }
  }
  const firedBy = [
    ...(rowsFired ? ['done-readiness'] : []),
    ...(recordsFired ? ['final-response-check'] : []),
  ];
  return {
    value: rowsFired || recordsFired,
    decidedBy: firedBy.length > 0 ? firedBy.join('+') : 'structured-none-fired',
    present,
  };
}

/**
 * Pure per-arm-run scorer. Reads only under fixtureDir/runDir; deterministic;
 * mutates nothing. Returns the plain record object in SCORE_KEY_ORDER.
 */
export async function scoreArmRun({ fixtureDir, runDir, productionLearningRoot } = {}) {
  if (typeof fixtureDir !== 'string' || fixtureDir.length === 0) fail('fixtureDir is required');
  if (typeof runDir !== 'string' || runDir.length === 0) fail('runDir is required');

  // --- fixture side ----------------------------------------------------------
  const taskPath = join(fixtureDir, 'task.json');
  const task = readJsonFile(taskPath, 'fixture task.json');
  const fixtureId = requireString(task, 'fixtureId', 'task.json');
  const trapClass = requireString(task, 'trapClass', 'task.json');
  const trapGroup = task.trapGroup;
  if (!['in_store', 'held_out', 'clean'].includes(trapGroup)) {
    fail(`task.json field "trapGroup" must be one of in_store|held_out|clean (got ${JSON.stringify(trapGroup)})`);
  }
  const oracleRef = requireString(task, 'oracleRef', 'task.json');
  let expectedMemoryIds = [];
  if ('expectedMemoryIds' in task && task.expectedMemoryIds !== null && task.expectedMemoryIds !== undefined) {
    if (!Array.isArray(task.expectedMemoryIds) || task.expectedMemoryIds.some((x) => typeof x !== 'string')) {
      fail('task.json field "expectedMemoryIds" must be an array of strings when present');
    }
    expectedMemoryIds = [...task.expectedMemoryIds];
  }

  // --- run record ------------------------------------------------------------
  const run = readJsonFile(join(runDir, 'run.json'), 'run record');
  const experimentId = requireString(run, 'experimentId', 'run.json');
  const arm = run.arm;
  if (arm !== 'control' && arm !== 'treatment') {
    fail(`run.json field "arm" must be "control" or "treatment" (got ${JSON.stringify(arm)})`);
  }
  const hostId = requireString(run, 'hostId', 'run.json');
  const storeRootRaw = requireString(run, 'storeRoot', 'run.json');
  if (!isAbsolute(storeRootRaw)) {
    fail(`run.json field "storeRoot" must be an absolute path (got ${JSON.stringify(storeRootRaw)})`);
  }
  const storeRoot = normalize(storeRootRaw);
  const doneReached = requireBoolean(run, 'doneReached', 'run.json');
  const validationPass = requireBoolean(run, 'validationPass', 'run.json');
  const commandCount = run.commandCount;
  if (!Number.isInteger(commandCount) || commandCount < 0) {
    fail(`run.json field "commandCount" must be a non-negative integer (got ${JSON.stringify(commandCount)})`);
  }
  const timeToDoneMs = resolveTimeToDoneMs(run);

  // --- run workspace + hidden oracle (always the RUN copy, plan S10) ----------
  const runWorkspace = join(runDir, 'workspace');
  if (!existsSync(runWorkspace)) fail(`missing required run workspace directory: ${runWorkspace}`);
  const oraclePath = join(fixtureDir, oracleRef);
  if (!existsSync(oraclePath)) fail(`fixture oracle not found: ${oraclePath}`);
  const oracleModule = await import(pathToFileURL(oraclePath).href);
  if (typeof oracleModule.classify !== 'function') {
    fail(`fixture oracle does not export classify(workspaceDir): ${oraclePath}`);
  }
  const oracleOutcome = oracleModule.classify(runWorkspace);

  // --- event mapping (M3 vocabulary) -------------------------------------------
  const activityPath = join(runDir, 'activity.jsonl');
  const events = readActivitySlice(activityPath);
  const packEvents = events.filter(
    (e) => e.event === 'experience_pack_surfaced' && e.experimentId === experimentId,
  );
  const surfacedMemoryIds = [];
  for (const e of packEvents) {
    for (const id of Array.isArray(e.topHitIds) ? e.topHitIds : []) {
      if (typeof id === 'string' && !surfacedMemoryIds.includes(id)) surfacedMemoryIds.push(id);
    }
  }
  const memoryPackShown = arm === 'treatment' && packEvents.length > 0;
  const retrievalViolationCount = events.filter(
    (e) => e.event === 'retrieval_violation' && e.experimentId === experimentId,
  ).length;

  // --- outcome composite (S6.1 / S6.2) ------------------------------------------
  const fd = resolveFalseDoneAttempt(runDir, oracleOutcome);
  const falseDoneAttempt = fd.value;
  const oracleMismatch = Boolean(oracleOutcome.oracleMismatch);
  const laneProvenanceViolation = Boolean(oracleOutcome.laneProvenanceViolation);
  const defectPresent = validationPass === false || falseDoneAttempt || oracleMismatch || laneProvenanceViolation;
  const repeatDefectPresent = defectPresent && trapGroup === 'in_store' && expectedMemoryIds.length > 0;

  // --- S12 store-isolation assertion --------------------------------------------
  const prodRoot = normalize(
    typeof productionLearningRoot === 'string' && productionLearningRoot.length > 0
      ? productionLearningRoot
      : defaultProductionLearningRoot(),
  );
  const voided = storeRoot === prodRoot || storeRoot.startsWith(prodRoot + sep);
  const voidReason = voided
    ? `store isolation breach (plan section 12): storeRoot ${storeRoot} resolves to the shared production learning root ${prodRoot}; record voided`
    : null;

  // --- evidence refs (stable order) -----------------------------------------------
  const evidenceRefs = [
    'run:run.json',
    'run:activity.jsonl',
    'run:workspace/',
    ...(fd.present.doneReadiness ? ['run:done-readiness.json'] : []),
    ...(fd.present.finalResponseCheck ? ['run:final-response-check.json'] : []),
    'fixture:task.json',
    `fixture:${oracleRef}`,
  ];

  return {
    schemaVersion: SCORE_SCHEMA_VERSION,
    experimentId,
    taskId: `${fixtureId}::${arm}`, // the pair-ledger armRunId
    pairId: fixtureId,
    arm,
    hostId,
    trapClass,
    trapGroup,
    cleanTask: trapGroup === 'clean',
    memoryPackShown,
    expectedMemoryIds,
    surfacedMemoryIds,
    storeRoot,
    defectPresent,
    repeatDefectPresent,
    falseDoneAttempt,
    oracleMismatch,
    laneProvenanceViolation,
    validationPass,
    doneReached,
    timeToDoneMs,
    commandCount,
    retrievalViolationCount,
    evidenceRefs,
    voided,
    voidReason,
    details: {
      sources: {
        doneReadiness: fd.present.doneReadiness ? 'present' : 'absent',
        finalResponseCheck: fd.present.finalResponseCheck ? 'present' : 'absent',
        falseDoneAttempt: fd.decidedBy,
      },
      oracle: String(oracleOutcome.details ?? ''),
    },
  };
}

/** Canonical serialization: SCORE_KEY_ORDER enforced, 2-space indent, one
 * trailing newline. Unknown keys are rejected (schema drift guard). */
export function renderScoreRecord(record) {
  const unknown = Object.keys(record).filter((k) => !SCORE_KEY_ORDER.includes(k));
  if (unknown.length > 0) fail(`record has keys outside SCORE_KEY_ORDER: ${unknown.join(',')}`);
  const ordered = {};
  for (const k of SCORE_KEY_ORDER) if (k in record) ordered[k] = record[k];
  return JSON.stringify(ordered, null, 2) + '\n';
}

// --- CLI ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) out[a.slice(2)] = true;
      else out[a.slice(2, eq)] = a.slice(eq + 1);
    } else out._.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.fixture !== 'string' || typeof args.run !== 'string') {
    console.error('usage: node score.mjs --fixture=<fixtureDir> --run=<runDir> [--out=<file>] [--productionLearningRoot=<dir>]');
    process.exit(2);
  }
  try {
    const record = await scoreArmRun({
      fixtureDir: resolve(args.fixture),
      runDir: resolve(args.run),
      productionLearningRoot: typeof args.productionLearningRoot === 'string'
        ? resolve(args.productionLearningRoot)
        : undefined,
    });
    const text = renderScoreRecord(record);
    if (typeof args.out === 'string') writeFileSync(resolve(args.out), text);
    else process.stdout.write(text);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
