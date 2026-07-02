#!/usr/bin/env node
// protocol-selfcheck.mjs — hermetic selfcheck for the M0 protocol freeze tool.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalStringify,
  computeProtocolHash,
  extractPayload,
  freezeProtocol,
  hashDirectorySnapshot,
  loadFrozenProtocol,
  validateFrozenProtocol,
  PROTOCOL_SCHEMA_VERSION,
  experimentRoot,
} from './protocol.mjs';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS ${name}`);
  else { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function expectThrow(name, fn, matcher) {
  try { fn(); failures++; console.error(`FAIL ${name} — expected a throw`); }
  catch (err) {
    const ok = matcher ? matcher(err) : true;
    if (ok) console.log(`PASS ${name}`);
    else { failures++; console.error(`FAIL ${name} — threw but did not match: ${err.message}`); }
  }
}

const IN_STORE = ['stale-doc', 'parent-roadmap', 'host-policy', 'deprecated-brand', 'false-done', 'reviewer-lane'];
function validConfig(experimentId = 'exp-selfcheck') {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    experimentId,
    taskClasses: { inStore: [...IN_STORE], heldOut: ['novel-trap-a', 'novel-trap-b'], clean: ['clean-a'] },
    perPopulation: {
      seeded: { alpha: 0.05, power: 0.80, baselineBand: [0.5, 0.8], mdeBand: [0.25, 0.35] },
      live: { alpha: 0.05, power: 0.80, baseline: 0.30, mde: 0.10 },
    },
    pilotFreezeRule: { minControlFaultRuns: 15, freezeAt: 'wilson95Lower', maxCiWidth: 0.30 },
    noOverclaimBoundaryRef: 'docs/requirements/decisions/experience-layer-ablation-causal-validation-execution-plan.md#15-no-overclaim-rule',
    memorySnapshotHash: 'a'.repeat(64),
  };
}

const tmp = mkdtempSync(join(tmpdir(), 'ablation-protocol-'));
const extraRoots = []; // every additional mkdtemp root, removed in finally (F-007/F-011)
try {
  // --- happy: freeze then validate ------------------------------------------
  const { protocolHash } = freezeProtocol({ root: tmp, config: validConfig(), createdAt: '2026-07-03T00:00:00Z' });
  const { protocolHash: validatedHash } = validateFrozenProtocol(tmp, 'exp-selfcheck');
  check('freeze -> validate passes with matching hash', validatedHash === protocolHash);
  const doc = loadFrozenProtocol(tmp, 'exp-selfcheck');
  check('createdAt stored but outside the hashed payload',
    doc.createdAt === '2026-07-03T00:00:00Z' && !('createdAt' in extractPayload(doc)));

  // --- canonicalization: key order does not change the hash -------------------
  const cfg = validConfig();
  const reordered = {};
  for (const k of Object.keys(cfg).reverse()) reordered[k] = cfg[k]; // reversed insertion order
  check('key-order invariance', computeProtocolHash(extractPayload(cfg)) === computeProtocolHash(extractPayload(reordered)));
  check('canonicalStringify sorts nested keys',
    canonicalStringify({ b: { d: 1, c: 2 }, a: 3 }) === '{"a":3,"b":{"c":2,"d":1}}');

  // --- createdAt variation -> same hash -----------------------------------------
  const root1 = mkdtempSync(join(tmpdir(), 'ablation-p1-'));
  const root2 = mkdtempSync(join(tmpdir(), 'ablation-p2-'));
  extraRoots.push(root1, root2);
  const h1 = freezeProtocol({ root: root1, config: validConfig(), createdAt: '2026-01-01T00:00:00Z' }).protocolHash;
  const h2 = freezeProtocol({ root: root2, config: validConfig(), createdAt: '2026-12-31T23:59:59Z' }).protocolHash;
  check('same config at different createdAt -> same protocolHash', h1 === h2 && h1 === protocolHash);

  // --- tamper: any field change breaks the hash ----------------------------------
  const protoPath = join(experimentRoot(tmp, 'exp-selfcheck'), 'protocol.json');
  const original = readFileSync(protoPath, 'utf8');
  const tampered = JSON.parse(original);
  tampered.perPopulation.live.baseline = 0.31;
  writeFileSync(protoPath, JSON.stringify(tampered, null, 2));
  expectThrow('tampered field -> validate hash mismatch',
    () => validateFrozenProtocol(tmp, 'exp-selfcheck'),
    (e) => e.code === 'PROTOCOL_HASH_MISMATCH');
  writeFileSync(protoPath, original); // restore

  // --- schema: missing / malformed fields named ------------------------------------
  expectThrow('missing memorySnapshotHash named',
    () => { const c = validConfig('exp-x'); delete c.memorySnapshotHash; freezeProtocol({ root: tmp, config: c }); },
    (e) => /memorySnapshotHash/.test(e.message));
  expectThrow('malformed perPopulation named',
    () => { const c = validConfig('exp-y'); c.perPopulation.seeded.baselineBand = [0.8, 0.5]; freezeProtocol({ root: tmp, config: c }); },
    (e) => /baselineBand/.test(e.message));
  expectThrow('in-store/held-out overlap rejected',
    () => { const c = validConfig('exp-z'); c.taskClasses.heldOut = ['stale-doc']; freezeProtocol({ root: tmp, config: c }); },
    (e) => /overlap/.test(e.message));
  expectThrow('clean/in-store overlap rejected (clean must never pool into the fault baseline)',
    () => { const c = validConfig('exp-z2'); c.taskClasses.clean = ['stale-doc']; freezeProtocol({ root: tmp, config: c }); },
    (e) => /overlap/.test(e.message));
  expectThrow('wrong schemaVersion rejected',
    () => { const c = validConfig('exp-w'); c.schemaVersion = 'v0'; freezeProtocol({ root: tmp, config: c }); },
    (e) => /schemaVersion/.test(e.message));

  // --- memory snapshot sidecar consistency --------------------------------------
  const snapPath = join(experimentRoot(tmp, 'exp-selfcheck'), 'memory-snapshot-hash.json');
  const snapOriginal = readFileSync(snapPath, 'utf8');
  writeFileSync(snapPath, JSON.stringify({ memorySnapshotHash: 'b'.repeat(64) }));
  expectThrow('memory-snapshot sidecar mismatch detected',
    () => validateFrozenProtocol(tmp, 'exp-selfcheck'),
    (e) => e.code === 'MEMORY_SNAPSHOT_MISMATCH');
  // Sidecar with a correct memorySnapshotHash but a wrong protocolHash must
  // also fail (F-005: validation must consume the protocolHash it stores).
  writeFileSync(snapPath, JSON.stringify({ memorySnapshotHash: 'a'.repeat(64), protocolHash: 'f'.repeat(64) }));
  expectThrow('memory-snapshot sidecar protocolHash mismatch detected',
    () => validateFrozenProtocol(tmp, 'exp-selfcheck'),
    (e) => e.code === 'MEMORY_SNAPSHOT_MISMATCH' && /protocolHash/.test(e.message));
  writeFileSync(snapPath, snapOriginal);

  // --- directory snapshot hashing: deterministic + content-sensitive ---------------
  const snapDir = mkdtempSync(join(tmpdir(), 'ablation-snapdir-'));
  extraRoots.push(snapDir);
  writeFileSync(join(snapDir, 'lesson-1.json'), '{"a":1}');
  writeFileSync(join(snapDir, 'lesson-2.json'), '{"b":2}');
  const d1 = hashDirectorySnapshot(snapDir);
  const d2 = hashDirectorySnapshot(snapDir);
  writeFileSync(join(snapDir, 'lesson-2.json'), '{"b":3}');
  const d3 = hashDirectorySnapshot(snapDir);
  check('directory snapshot hash deterministic and content-sensitive', d1 === d2 && d1 !== d3);

  // --- no frozen protocol -> named error ---------------------------------------------
  expectThrow('validate without a frozen protocol -> NO_FROZEN_PROTOCOL',
    () => validateFrozenProtocol(tmp, 'never-frozen'),
    (e) => e.code === 'NO_FROZEN_PROTOCOL');
} finally {
  rmSync(tmp, { recursive: true, force: true });
  for (const r of extraRoots) rmSync(r, { recursive: true, force: true });
}

if (failures > 0) { console.error(`${failures} selfcheck failure(s)`); process.exit(1); }
console.log('protocol selfcheck: all cases passed');
