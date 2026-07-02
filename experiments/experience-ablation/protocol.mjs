#!/usr/bin/env node
// protocol.mjs — M0 protocol freeze tool (experience-ablation S1).
//
// Freezes and validates the machine-checked pre-registration protocol for an
// experience-ablation experiment (rev-2 plan S12/S13 M0):
//   - protocol.json: schemaVersion, experimentId, taskClasses (in-store /
//     held-out / clean membership), perPopulation sample-size config, the S7
//     pilot freeze rule, the no-overclaim boundary pointer, and the FROZEN
//     memorySnapshotHash.
//   - protocolHash: sha256 over the canonical JSON serialization (sorted keys,
//     the hash field itself excluded). createdAt is accepted as an INPUT and
//     kept OUTSIDE the hashed payload so re-freezing the same protocol at a
//     different time yields the same hash (no Date.now anywhere near the hash).
//
// Artifact root (plan S12): <root>/.lattice/experiments/experience-ablation/<experimentId>/
//   protocol.json            — the frozen protocol (hashed payload + protocolHash + createdAt)
//   memory-snapshot-hash.json — { memorySnapshotHash } recorded at freeze time
//
// The M2 pair ledger refuses to build without a valid frozen protocol here —
// that refusal is how M0's "no task runs without protocol hash" exit criterion
// is enforced mechanically.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const PROTOCOL_SCHEMA_VERSION = 'proofbound.experience-ablation-protocol.v1';

export function experimentRoot(root, experimentId) {
  return join(root, '.lattice', 'experiments', 'experience-ablation', experimentId);
}

// --- canonical serialization -------------------------------------------------
// Sorted keys at every level, arrays kept in order, no whitespace variance.
export function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// sha256 over a directory snapshot: sorted relative paths + file bytes.
export function hashDirectorySnapshot(dir) {
  const files = [];
  const walk = (d) => {
    for (const entry of readdirSync(d).sort()) {
      const p = join(d, entry);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);
  const h = createHash('sha256');
  for (const f of files) {
    h.update(relative(dir, f));
    h.update('\0');
    h.update(readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex');
}

// --- schema validation ---------------------------------------------------------
function fail(field, why) {
  const e = new Error(`protocol field '${field}' invalid: ${why}`);
  e.field = field;
  return e;
}

function assertStringArray(v, field, { allowEmpty = true } = {}) {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.length === 0)) {
    throw fail(field, 'must be an array of non-empty strings');
  }
  if (!allowEmpty && v.length === 0) throw fail(field, 'must be non-empty');
}

function assertProb(v, field, { open = true } = {}) {
  if (typeof v !== 'number' || Number.isNaN(v)) throw fail(field, 'must be a number');
  if (open ? !(v > 0 && v < 1) : !(v >= 0 && v <= 1)) throw fail(field, 'must be in (0,1)');
}

function assertBand(v, field) {
  if (!Array.isArray(v) || v.length !== 2) throw fail(field, 'must be a [low, high] pair');
  assertProb(v[0], `${field}[0]`);
  assertProb(v[1], `${field}[1]`);
  if (!(v[0] < v[1])) throw fail(field, 'low must be < high');
}

// Validates the HASHED payload (everything except protocolHash/createdAt).
export function validateProtocolPayload(p) {
  if (!p || typeof p !== 'object') throw fail('(root)', 'protocol must be an object');
  if (p.schemaVersion !== PROTOCOL_SCHEMA_VERSION) throw fail('schemaVersion', `must be '${PROTOCOL_SCHEMA_VERSION}'`);
  if (typeof p.experimentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(p.experimentId)) {
    throw fail('experimentId', 'must be a slug (alphanumeric, -, _)');
  }
  if (!p.taskClasses || typeof p.taskClasses !== 'object') throw fail('taskClasses', 'must be an object');
  assertStringArray(p.taskClasses.inStore, 'taskClasses.inStore', { allowEmpty: false });
  assertStringArray(p.taskClasses.heldOut, 'taskClasses.heldOut');
  assertStringArray(p.taskClasses.clean, 'taskClasses.clean');
  const overlap = p.taskClasses.inStore.filter((c) => p.taskClasses.heldOut.includes(c));
  if (overlap.length) throw fail('taskClasses', `in-store and held-out overlap: ${overlap.join(', ')}`);

  if (!p.perPopulation || typeof p.perPopulation !== 'object') throw fail('perPopulation', 'must be an object');
  const s = p.perPopulation.seeded;
  if (!s || typeof s !== 'object') throw fail('perPopulation.seeded', 'must be an object');
  assertProb(s.alpha, 'perPopulation.seeded.alpha');
  assertProb(s.power, 'perPopulation.seeded.power');
  assertBand(s.baselineBand, 'perPopulation.seeded.baselineBand');
  assertBand(s.mdeBand, 'perPopulation.seeded.mdeBand');
  const l = p.perPopulation.live;
  if (!l || typeof l !== 'object') throw fail('perPopulation.live', 'must be an object');
  assertProb(l.alpha, 'perPopulation.live.alpha');
  assertProb(l.power, 'perPopulation.live.power');
  assertProb(l.baseline, 'perPopulation.live.baseline');
  assertProb(l.mde, 'perPopulation.live.mde');

  const r = p.pilotFreezeRule;
  if (!r || typeof r !== 'object') throw fail('pilotFreezeRule', 'must be an object');
  if (!(Number.isInteger(r.minControlFaultRuns) && r.minControlFaultRuns > 0)) {
    throw fail('pilotFreezeRule.minControlFaultRuns', 'must be a positive integer');
  }
  if (r.freezeAt !== 'wilson95Lower') throw fail('pilotFreezeRule.freezeAt', "must be 'wilson95Lower'");
  assertProb(r.maxCiWidth, 'pilotFreezeRule.maxCiWidth');

  if (typeof p.noOverclaimBoundaryRef !== 'string' || p.noOverclaimBoundaryRef.length < 8) {
    throw fail('noOverclaimBoundaryRef', 'must be a pointer string (>= 8 chars) to the plan S15 boundary');
  }
  if (typeof p.memorySnapshotHash !== 'string' || !/^[0-9a-f]{64}$/.test(p.memorySnapshotHash)) {
    throw fail('memorySnapshotHash', 'must be a 64-hex sha256');
  }
  return true;
}

// The hashed payload = every schema field, sorted canonically. protocolHash and
// createdAt live OUTSIDE the payload.
export function computeProtocolHash(payload) {
  validateProtocolPayload(payload);
  return sha256(canonicalStringify(payload));
}

export function extractPayload(doc) {
  const { protocolHash, createdAt, ...payload } = doc;
  return payload;
}

// --- freeze / validate ------------------------------------------------------------
function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function freezeProtocol({ root, config, createdAt }) {
  const payload = extractPayload(config);
  const protocolHash = computeProtocolHash(payload); // validates too
  const dir = experimentRoot(root, payload.experimentId);
  mkdirSync(dir, { recursive: true });
  const doc = { ...payload, protocolHash, ...(createdAt ? { createdAt } : {}) };
  writeAtomic(join(dir, 'protocol.json'), JSON.stringify(doc, null, 2) + '\n');
  writeAtomic(join(dir, 'memory-snapshot-hash.json'),
    JSON.stringify({ memorySnapshotHash: payload.memorySnapshotHash, protocolHash }, null, 2) + '\n');
  return { dir, protocolHash };
}

export function loadFrozenProtocol(root, experimentId) {
  const path = join(experimentRoot(root, experimentId), 'protocol.json');
  if (!existsSync(path)) {
    const e = new Error(`no frozen protocol at ${path} — run protocol.mjs freeze first (M0)`);
    e.code = 'NO_FROZEN_PROTOCOL';
    throw e;
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function validateFrozenProtocol(root, experimentId) {
  const doc = loadFrozenProtocol(root, experimentId);
  const payload = extractPayload(doc);
  const expected = computeProtocolHash(payload); // schema + hash in one pass
  if (doc.protocolHash !== expected) {
    const e = new Error(`protocolHash mismatch: stored ${doc.protocolHash}, recomputed ${expected} — the frozen protocol was tampered`);
    e.code = 'PROTOCOL_HASH_MISMATCH';
    throw e;
  }
  const snapPath = join(experimentRoot(root, experimentId), 'memory-snapshot-hash.json');
  if (!existsSync(snapPath)) {
    const e = new Error(`memory-snapshot-hash.json missing beside protocol.json`);
    e.code = 'NO_MEMORY_SNAPSHOT';
    throw e;
  }
  const snap = JSON.parse(readFileSync(snapPath, 'utf8'));
  if (snap.memorySnapshotHash !== payload.memorySnapshotHash) {
    const e = new Error('memory-snapshot-hash.json disagrees with protocol.json memorySnapshotHash');
    e.code = 'MEMORY_SNAPSHOT_MISMATCH';
    throw e;
  }
  return { doc, protocolHash: doc.protocolHash };
}

// --- CLI ------------------------------------------------------------------------
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
    if (cmd === 'freeze') {
      if (!args.root || !args.config) throw new Error('freeze requires --root and --config');
      const config = JSON.parse(readFileSync(args.config, 'utf8'));
      if (!config.memorySnapshotHash && args.snapshotDir) {
        config.memorySnapshotHash = hashDirectorySnapshot(args.snapshotDir);
      }
      const { dir, protocolHash } = freezeProtocol({ root: args.root, config, createdAt: args.createdAt });
      console.log(`frozen: ${dir}`);
      console.log(`protocolHash: ${protocolHash}`);
      return;
    }
    if (cmd === 'validate') {
      if (!args.root || !args.experimentId) throw new Error('validate requires --root and --experimentId');
      const { protocolHash } = validateFrozenProtocol(args.root, args.experimentId);
      console.log(`PASS protocol.json valid, protocolHash ${protocolHash}`);
      return;
    }
    if (cmd === 'hash') {
      if (!args.config) throw new Error('hash requires --config');
      const config = JSON.parse(readFileSync(args.config, 'utf8'));
      console.log(computeProtocolHash(extractPayload(config)));
      return;
    }
    console.error('usage: node protocol.mjs freeze|validate|hash --root=<root> --experimentId=<id> --config=<path> [--snapshotDir=<dir>] [--createdAt=<iso>]');
    process.exit(2);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
