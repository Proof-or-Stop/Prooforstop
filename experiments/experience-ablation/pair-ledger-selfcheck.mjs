#!/usr/bin/env node
// pair-ledger-selfcheck.mjs — hermetic selfcheck for the M2 pair ledger.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freezeProtocol, experimentRoot, PROTOCOL_SCHEMA_VERSION } from './protocol.mjs';
import {
  ARMS,
  buildLedger,
  seededShuffle,
  validateManifest,
  verifyLedger,
} from './pair-ledger.mjs';

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
    else { failures++; console.error(`FAIL ${name} — threw but did not match: ${err.message} (code ${err.code})`); }
  }
}

const EXP = 'exp-ledger-selfcheck';
function freezeValidProtocol(root) {
  return freezeProtocol({
    root,
    config: {
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      experimentId: EXP,
      taskClasses: { inStore: ['stale-doc', 'false-done'], heldOut: ['novel-a'], clean: ['clean-a'] },
      perPopulation: {
        seeded: { alpha: 0.05, power: 0.80, baselineBand: [0.5, 0.8], mdeBand: [0.25, 0.35] },
        live: { alpha: 0.05, power: 0.80, baseline: 0.30, mde: 0.10 },
      },
      pilotFreezeRule: { minControlFaultRuns: 15, freezeAt: 'wilson95Lower', maxCiWidth: 0.30 },
      noOverclaimBoundaryRef: 'docs/requirements/decisions/experience-layer-ablation-causal-validation-execution-plan.md#15-no-overclaim-rule',
      memorySnapshotHash: 'c'.repeat(64),
    },
    createdAt: '2026-07-03T00:00:00Z',
  });
}

const MANIFEST = [
  { fixtureId: 'stale-doc-01', trapClass: 'stale-doc', trapGroup: 'in_store', oracleRef: 'oracle/stale-doc-01.mjs' },
  { fixtureId: 'stale-doc-02', trapClass: 'stale-doc', trapGroup: 'in_store', oracleRef: 'oracle/stale-doc-02.mjs' },
  { fixtureId: 'false-done-01', trapClass: 'false-done', trapGroup: 'in_store', oracleRef: 'oracle/false-done-01.mjs' },
  { fixtureId: 'novel-a-01', trapClass: 'novel-a', trapGroup: 'held_out', oracleRef: 'oracle/novel-a-01.mjs' },
  { fixtureId: 'novel-a-02', trapClass: 'novel-a', trapGroup: 'held_out', oracleRef: 'oracle/novel-a-02.mjs' },
  { fixtureId: 'clean-a-01', trapClass: 'clean-a', trapGroup: 'clean', oracleRef: 'oracle/clean-a-01.mjs' },
];

// --- seeded shuffle primitives ------------------------------------------------
check('seededShuffle deterministic', JSON.stringify(seededShuffle([1, 2, 3, 4, 5], 's')) === JSON.stringify(seededShuffle([1, 2, 3, 4, 5], 's')));
check('seededShuffle seed-sensitive', JSON.stringify(seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], 'a')) !== JSON.stringify(seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], 'b')));
check('seededShuffle is a permutation', [...seededShuffle([3, 1, 2], 'x')].sort().join() === '1,2,3');

// --- refusal without frozen protocol -------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'ablation-ledger-noproto-'));
  try {
    expectThrow('build without frozen protocol refused (M0 enforcement)',
      () => buildLedger({ root, experimentId: EXP, manifestRows: MANIFEST, seed: 's1' }),
      (e) => e.code === 'NO_FROZEN_PROTOCOL' && /M0/.test(e.message));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// --- happy build + reproducibility ------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'ablation-ledger-'));
  try {
    freezeValidProtocol(root);
    const b1 = buildLedger({ root, experimentId: EXP, manifestRows: MANIFEST, seed: 'seed-A' });
    check('build writes three files', ['fixture-manifest.jsonl', 'pair-ledger.jsonl', 'run-order-seed.json']
      .every((f) => readFileSync(join(b1.dir, f), 'utf8').length > 0));
    check('runOrder covers every armRun exactly once',
      b1.runOrder.length === MANIFEST.length * ARMS.length &&
      new Set(b1.runOrder).size === b1.runOrder.length &&
      MANIFEST.every((r) => ARMS.every((a) => b1.runOrder.includes(`${r.fixtureId}::${a}`))));

    const b2 = buildLedger({ root, experimentId: EXP, manifestRows: MANIFEST, seed: 'seed-A' });
    check('same seed rebuild -> byte-identical runOrder', JSON.stringify(b1.runOrder) === JSON.stringify(b2.runOrder));

    const b3 = buildLedger({ root, experimentId: EXP, manifestRows: MANIFEST, seed: 'seed-B' });
    check('different seed -> different order, same armRun set',
      JSON.stringify(b3.runOrder) !== JSON.stringify(b1.runOrder) &&
      [...b3.runOrder].sort().join() === [...b1.runOrder].sort().join());

    check('verify passes on a clean build', verifyLedger(root, EXP).ok === true);

    // --- verify catches a tampered ledger row --------------------------------
    const ledgerPath = join(b1.dir, 'pair-ledger.jsonl');
    const originalLedger = readFileSync(ledgerPath, 'utf8');
    writeFileSync(ledgerPath, originalLedger.replace('"arm":"control"', '"arm":"treatment"'));
    expectThrow('verify catches tampered ledger row',
      () => verifyLedger(root, EXP),
      (e) => e.code === 'LEDGER_VERIFY_FAILED' && e.problems.some((p) => /ledger row tampered/.test(p)));
    writeFileSync(ledgerPath, originalLedger);

    // --- verify catches a tampered seed file ------------------------------------
    const seedPath = join(b1.dir, 'run-order-seed.json');
    const originalSeed = readFileSync(seedPath, 'utf8');
    const seedDoc = JSON.parse(originalSeed);
    seedDoc.runOrder = [...seedDoc.runOrder].reverse();
    writeFileSync(seedPath, JSON.stringify(seedDoc, null, 2) + '\n');
    expectThrow('verify catches tampered run order',
      () => verifyLedger(root, EXP),
      (e) => e.code === 'LEDGER_VERIFY_FAILED');
    writeFileSync(seedPath, originalSeed);

    // --- verify catches post-build protocol drift (CHK-002 edge:2) --------------
    const protoPath = join(experimentRoot(root, EXP), 'protocol.json');
    const originalProto = readFileSync(protoPath, 'utf8');
    const protoDoc = JSON.parse(originalProto);
    protoDoc.perPopulation.live.mde = 0.11; // tamper after build
    writeFileSync(protoPath, JSON.stringify(protoDoc, null, 2) + '\n');
    expectThrow('verify catches protocol drift after build',
      () => verifyLedger(root, EXP),
      (e) => e.code === 'NO_FROZEN_PROTOCOL' || /protocolHash/.test(e.message));
    writeFileSync(protoPath, originalProto);
    check('verify passes again after restores', verifyLedger(root, EXP).ok === true);

    // --- immutability after a score record exists --------------------------------
    writeFileSync(join(b1.dir, 'score-records.jsonl'), JSON.stringify({ armRunId: 'stale-doc-01::control', defectPresent: true }) + '\n');
    expectThrow('build refused once a score record exists',
      () => buildLedger({ root, experimentId: EXP, manifestRows: MANIFEST, seed: 'seed-C' }),
      (e) => e.code === 'LEDGER_IMMUTABLE');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// --- manifest schema enforcement ----------------------------------------------------
expectThrow('manifest row missing trapGroup refused',
  () => validateManifest([{ fixtureId: 'x', trapClass: 'c', oracleRef: 'o' }]),
  (e) => /trapGroup/.test(e.message));
expectThrow('duplicate fixtureId refused',
  () => validateManifest([
    { fixtureId: 'x', trapClass: 'c', trapGroup: 'clean', oracleRef: 'o' },
    { fixtureId: 'x', trapClass: 'c', trapGroup: 'clean', oracleRef: 'o' },
  ]),
  (e) => /duplicate/.test(e.message));
expectThrow('invalid trapGroup refused',
  () => validateManifest([{ fixtureId: 'x', trapClass: 'c', trapGroup: 'shadow', oracleRef: 'o' }]),
  (e) => /trapGroup/.test(e.message));

if (failures > 0) { console.error(`${failures} selfcheck failure(s)`); process.exit(1); }
console.log('pair-ledger selfcheck: all cases passed');
