#!/usr/bin/env node
// pair-ledger.mjs — M2 immutable pair ledger with deterministic seeded run order
// (experience-ablation S1).
//
// build: requires a FROZEN protocol (M0) — refusing to build without one is the
// mechanical enforcement of M0's "no task runs without protocol hash" exit
// criterion. Writes, under the S12 experiment root:
//   fixture-manifest.jsonl  — one row per fixture {fixtureId, trapClass, trapGroup, oracleRef}
//   pair-ledger.jsonl       — one row per fixture pair {pairId, armRuns:[control, treatment], status}
//   run-order-seed.json     — {seed, protocolHash, manifestHash, ledgerHash, runOrder, sealHash}
// The run order is a Fisher-Yates shuffle of every armRunId driven by
// xmur3(seed) + mulberry32 (the experiments/recovery-runner/run-driver.mjs
// pattern, re-implemented locally to keep this directory self-contained).
//
// Immutability: every mutating entry point calls guardImmutable — once
// score-records.jsonl exists in the experiment root, the ledger is frozen and
// all mutations refuse (plan S8: "Ledger entries are immutable once the first
// score record exists"). verify re-derives the run order from the stored seed
// and re-checks every hash binding, so any hand-tamper of any of the three
// files (or of the frozen protocol) is detected.
//
// Fixtures do NOT need to exist on disk yet: M1 builds them later; S1
// guarantees the manifest/ledger/order machinery only.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalStringify, experimentRoot, sha256, validateFrozenProtocol } from './protocol.mjs';

export const TRAP_GROUPS = ['in_store', 'held_out', 'clean'];
export const ARMS = ['control', 'treatment'];

// --- seeded PRNG (xmur3 + mulberry32 + Fisher-Yates), run-driver.mjs pattern ---
export function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

export function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle(items, seed) {
  const rand = mulberry32(xmur3(String(seed))());
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// --- guards -----------------------------------------------------------------
export function scoreRecordsPath(root, experimentId) {
  return join(experimentRoot(root, experimentId), 'score-records.jsonl');
}

export function guardImmutable(root, experimentId, operation) {
  if (existsSync(scoreRecordsPath(root, experimentId))) {
    const e = new Error(
      `${operation} refused: score-records.jsonl exists — the ledger is immutable once the first score record exists (plan S8/M2). ` +
      'Start a NEW experimentId for a new assignment.');
    e.code = 'LEDGER_IMMUTABLE';
    throw e;
  }
}

export function guardFrozenProtocol(root, experimentId) {
  try {
    return validateFrozenProtocol(root, experimentId);
  } catch (err) {
    const e = new Error(
      `frozen-protocol requirement not met for experiment '${experimentId}': ${err.message} — ` +
      'M0 requires a valid frozen protocol.json (run protocol.mjs freeze) before any task/ledger work.');
    e.code = 'NO_FROZEN_PROTOCOL';
    e.cause = err;
    throw e;
  }
}

// --- manifest ------------------------------------------------------------------
function fail(field, why) {
  const e = new Error(`manifest field '${field}' invalid: ${why}`);
  e.field = field;
  return e;
}

export function validateManifest(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw fail('(root)', 'manifest must be a non-empty array of fixture rows');
  const seen = new Set();
  rows.forEach((row, i) => {
    if (!row || typeof row !== 'object') throw fail(`[${i}]`, 'row must be an object');
    if (typeof row.fixtureId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(row.fixtureId)) {
      throw fail(`[${i}].fixtureId`, 'must be a slug');
    }
    if (seen.has(row.fixtureId)) throw fail(`[${i}].fixtureId`, `duplicate fixtureId '${row.fixtureId}'`);
    seen.add(row.fixtureId);
    if (typeof row.trapClass !== 'string' || row.trapClass.length === 0) throw fail(`[${i}].trapClass`, 'must be a non-empty string');
    if (!TRAP_GROUPS.includes(row.trapGroup)) throw fail(`[${i}].trapGroup`, `must be one of ${TRAP_GROUPS.join('|')}`);
    if (typeof row.oracleRef !== 'string' || row.oracleRef.length === 0) throw fail(`[${i}].oracleRef`, 'must be a non-empty string');
  });
  return rows;
}

export function armRunId(fixtureId, arm) {
  return `${fixtureId}::${arm}`;
}

function toJsonl(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

// --- protocol-membership binding (B-047f F-002) -------------------------------
// Every manifest row's trapClass must be a member of the FROZEN protocol group
// matching its trapGroup — a valid protocol hash alone must not admit
// unregistered fixtures into the run.
const GROUP_FIELD = { in_store: 'inStore', held_out: 'heldOut', clean: 'clean' };

export function validateMembership(rows, taskClasses) {
  rows.forEach((row, i) => {
    const members = taskClasses[GROUP_FIELD[row.trapGroup]] ?? [];
    if (!members.includes(row.trapClass)) {
      throw fail(`[${i}].trapClass`,
        `'${row.trapClass}' is not a member of the frozen protocol's ${GROUP_FIELD[row.trapGroup]} group (${members.join(', ') || 'empty'})`);
    }
  });
  return rows;
}

// --- build ------------------------------------------------------------------------
export function buildLedger({ root, experimentId, manifestRows, seed }) {
  if (typeof seed !== 'string' || seed.length === 0) throw new Error('seed must be a non-empty string');
  const { doc, protocolHash } = guardFrozenProtocol(root, experimentId);
  guardImmutable(root, experimentId, 'build');
  const rows = validateMembership(validateManifest(manifestRows), doc.taskClasses);

  const dir = experimentRoot(root, experimentId);
  mkdirSync(dir, { recursive: true });

  const manifestRowsCanonical = rows.map((r) => ({
    fixtureId: r.fixtureId, trapClass: r.trapClass, trapGroup: r.trapGroup, oracleRef: r.oracleRef,
  }));
  const ledgerRows = rows.map((r) => ({
    pairId: r.fixtureId,
    armRuns: ARMS.map((arm) => ({ armRunId: armRunId(r.fixtureId, arm), arm, status: 'pending' })),
  }));
  const allArmRunIds = ledgerRows.flatMap((p) => p.armRuns.map((a) => a.armRunId));
  const runOrder = seededShuffle(allArmRunIds, seed);

  const manifestText = toJsonl(manifestRowsCanonical);
  const ledgerText = toJsonl(ledgerRows);
  const manifestHash = sha256(manifestText);
  const ledgerHash = sha256(ledgerText);
  const sealPayload = { seed, protocolHash, manifestHash, ledgerHash, runOrder };
  const sealHash = sha256(canonicalStringify(sealPayload));

  // Re-check immutability immediately before the writes to narrow the TOCTOU
  // window between the entry guard and the renames (B-047f F-006; single-host
  // tooling tier — a concurrent score writer on another host is out of scope).
  guardImmutable(root, experimentId, 'build(write)');
  writeAtomic(join(dir, 'fixture-manifest.jsonl'), manifestText);
  writeAtomic(join(dir, 'pair-ledger.jsonl'), ledgerText);
  writeAtomic(join(dir, 'run-order-seed.json'), JSON.stringify({ ...sealPayload, sealHash }, null, 2) + '\n');

  return { dir, runOrder, manifestHash, ledgerHash, sealHash, protocolHash };
}

// --- verify --------------------------------------------------------------------------
export function verifyLedger(root, experimentId) {
  const { doc, protocolHash } = guardFrozenProtocol(root, experimentId); // also fails on tampered protocol
  const dir = experimentRoot(root, experimentId);
  const problems = [];

  const seedPath = join(dir, 'run-order-seed.json');
  if (!existsSync(seedPath)) throw new Error(`run-order-seed.json missing at ${dir} — build the ledger first`);
  const sealDoc = JSON.parse(readFileSync(seedPath, 'utf8'));
  const { sealHash, ...sealPayload } = sealDoc;

  if (sha256(canonicalStringify(sealPayload)) !== sealHash) {
    problems.push('run-order-seed.json sealHash mismatch (seed file tampered)');
  }
  if (sealPayload.protocolHash !== protocolHash) {
    problems.push(`stored protocolHash ${sealPayload.protocolHash} no longer matches frozen protocol ${protocolHash}`);
  }

  const manifestText = readFileSync(join(dir, 'fixture-manifest.jsonl'), 'utf8');
  const ledgerText = readFileSync(join(dir, 'pair-ledger.jsonl'), 'utf8');
  if (sha256(manifestText) !== sealPayload.manifestHash) problems.push('fixture-manifest.jsonl hash mismatch (manifest tampered)');
  if (sha256(ledgerText) !== sealPayload.ledgerHash) problems.push('pair-ledger.jsonl hash mismatch (ledger row tampered)');

  // Re-derive the run order from the stored seed + manifest content, and
  // re-check protocol-group membership (F-002) on the stored manifest.
  try {
    const rows = validateMembership(
      validateManifest(manifestText.trim().split('\n').map((l) => JSON.parse(l))),
      doc.taskClasses,
    );
    const expectedOrder = seededShuffle(rows.flatMap((r) => ARMS.map((arm) => armRunId(r.fixtureId, arm))), sealPayload.seed);
    if (JSON.stringify(expectedOrder) !== JSON.stringify(sealPayload.runOrder)) {
      problems.push('runOrder does not re-derive from seed + manifest');
    }
  } catch (err) {
    problems.push(`manifest invalid: ${err.message}`);
  }

  if (problems.length) {
    const e = new Error(`ledger verify FAILED:\n  - ${problems.join('\n  - ')}`);
    e.code = 'LEDGER_VERIFY_FAILED';
    e.problems = problems;
    throw e;
  }
  return { ok: true, protocolHash, runOrderLength: sealPayload.runOrder.length };
}

// --- CLI --------------------------------------------------------------------------------
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  try {
    if (cmd === 'build') {
      if (!args.root || !args.experimentId || !args.manifest || !args.seed) {
        throw new Error('build requires --root --experimentId --manifest --seed');
      }
      const manifestRows = JSON.parse(readFileSync(args.manifest, 'utf8'));
      const r = buildLedger({ root: args.root, experimentId: args.experimentId, manifestRows, seed: String(args.seed) });
      console.log(`ledger built at ${r.dir}`);
      console.log(`runOrder (${r.runOrder.length}): ${r.runOrder.join(', ')}`);
      console.log(`sealHash: ${r.sealHash}`);
      return;
    }
    if (cmd === 'verify') {
      if (!args.root || !args.experimentId) throw new Error('verify requires --root --experimentId');
      const r = verifyLedger(args.root, args.experimentId);
      console.log(`PASS ledger verified: ${r.runOrderLength} arm-runs bound to protocol ${r.protocolHash.slice(0, 12)}…`);
      return;
    }
    console.error('usage: node pair-ledger.mjs build|verify --root=<root> --experimentId=<id> [--manifest=<path> --seed=<string>]');
    process.exit(2);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
