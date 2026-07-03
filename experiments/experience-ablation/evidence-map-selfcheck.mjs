#!/usr/bin/env node
// evidence-map-selfcheck.mjs — hermetic selfcheck for the M9 evidence map tool.
//
// Everything runs inside mkdtemp roots with STUB artifacts (protocol freeze,
// manifest/ledger/seal, leakage audit, score records, n-freeze, m7 decision,
// live readout, plan doc, memory snapshot) whose recorded hashes are built
// with the SAME canonical hashing the real tools use; no repository path is
// read or written and the tmp tree is removed on exit. Asserted here:
//
//   - the claim-to-artifact table covers ALL plan-section-18 rows in order,
//     and every cited artifact is existence-checked and carries the correct
//     sha256 digest (plan doc included);
//   - each missing required artifact fails with exactly ONE actionable line
//     naming it (looped over every required artifact + the plan doc);
//   - digest mismatches are detected when a stub artifact is tampered AFTER
//     its hash was recorded (protocol payload, manifest bytes, memory
//     snapshot, score records vs frozen pilot inputs);
//   - the no-overclaim section carries the circularity disclosure and all
//     four plan-15 disallowed claims, and the final summary carries the exact
//     `Causal impact: INCONCLUSIVE` verdict line with its artifact-composed
//     basis (the tool fails closed when n-freeze does not say `refused`);
//   - EVERY paper-table figure row is labeled unpowered/exploratory in both
//     views, and the computed figures match the stub records;
//   - deterministic double-run byte-identity (with and without --generatedAt);
//   - the tool never writes outside --out (recursive tree digest).

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { canonicalStringify, hashDirectorySnapshot, sha256 } from './protocol.mjs';
import {
  CIRCULARITY_DISCLOSURE,
  PLAN_DOC_RELPATH,
  REQUIRED_ARTIFACTS,
  SECTION18_ROWS,
  UNPOWERED_LABEL,
  VERDICT_LINE,
  computePaperTable,
} from './evidence-map.mjs';

const TOOL = new URL('./evidence-map.mjs', import.meta.url).pathname;
const EXP_ID = 'expabl-selfcheck-v1';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS ${name}`);
  else { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// --- stub fixtures ------------------------------------------------------------------

const FIXTURES = [
  { fixtureId: 'fx-1', trapClass: 'stale-doc', trapGroup: 'in_store', oracleRef: 'oracle.mjs' },
  { fixtureId: 'fx-2', trapClass: 'stale-doc', trapGroup: 'in_store', oracleRef: 'oracle.mjs' },
  { fixtureId: 'fx-3', trapClass: 'tool-hallucination', trapGroup: 'held_out', oracleRef: 'oracle.mjs' },
  { fixtureId: 'fx-4', trapClass: 'clean', trapGroup: 'clean', oracleRef: 'oracle.mjs' },
  { fixtureId: 'fx-5', trapClass: 'stale-doc', trapGroup: 'in_store', oracleRef: 'oracle.mjs' },
];

function stubRecord(fixtureId, arm, overrides) {
  const fx = FIXTURES.find((f) => f.fixtureId === fixtureId);
  return {
    schemaVersion: 'proofbound.experience-ablation-score.v1',
    experimentId: EXP_ID,
    taskId: `${fixtureId}::${arm}`,
    pairId: fixtureId,
    arm,
    trapClass: fx.trapClass,
    trapGroup: fx.trapGroup,
    cleanTask: fx.trapGroup === 'clean',
    memoryPackShown: arm === 'treatment',
    surfacedMemoryIds: ['les-stale-doc'],
    storeRoot: `/tmp-stub/ablation-${fixtureId}-${arm}/workspace/.lattice/learning`,
    defectPresent: false,
    repeatDefectPresent: false,
    timeToDoneMs: 1000,
    retrievalViolationCount: 0,
    voided: false,
    voidReason: null,
    ...overrides,
  };
}

/**
 * 5 pairs / 10 records. Expected figures (groups sorted clean/held_out/in_store):
 *   clean:    1 fixture, rates 0/0, paired RD 0, median time delta +100ms
 *   held_out: 1 fixture, rates 1/1, paired RD 0, median time delta +500ms
 *   in_store: 3 fixtures (fx-5 treatment VOIDED -> pair incomplete);
 *             control 1/3 defects, treatment 0/2, paired RD -0.5 over 2 pairs,
 *             median time delta of [+1000, -2000] = -500ms,
 *             repeat-defect delta 0 - 1/3 = -1/3.
 * Control in-store fault recount for n-freeze: 1 defect / 3 runs.
 */
function stubRecords() {
  return [
    stubRecord('fx-1', 'control', { defectPresent: true, repeatDefectPresent: true, timeToDoneMs: 1000 }),
    stubRecord('fx-1', 'treatment', { timeToDoneMs: 2000 }),
    stubRecord('fx-2', 'control', { timeToDoneMs: 3000 }),
    stubRecord('fx-2', 'treatment', { timeToDoneMs: 1000 }),
    stubRecord('fx-3', 'control', { defectPresent: true, timeToDoneMs: 5000 }),
    stubRecord('fx-3', 'treatment', { defectPresent: true, timeToDoneMs: 5500 }),
    stubRecord('fx-4', 'control', { timeToDoneMs: 100 }),
    stubRecord('fx-4', 'treatment', { timeToDoneMs: 200 }),
    stubRecord('fx-5', 'control', { timeToDoneMs: 4000 }),
    stubRecord('fx-5', 'treatment', {
      voided: true,
      voidReason: 'store isolation: run touched a {shared} root — braces on purpose',
      timeToDoneMs: 9999,
    }),
  ];
}

/** Concatenated pretty-printed AND single-line records — the real on-disk mix. */
function stubScoreRecordsText(records = stubRecords()) {
  return records
    .map((r, i) => (i % 3 === 1 ? `${JSON.stringify(r)}\n` : `${JSON.stringify(r, null, 2)}\n`))
    .join('');
}

const STUB_M7_DECISION = {
  schemaVersion: 'proofbound.experience-ablation-m7-decision.v1',
  experimentId: EXP_ID,
  decision: 'skip_powered_study',
  decidedBy: 'stub user via explicit option selection',
  basis: 'stub basis: freeze refused, powered study unsizable',
  consequence: 'stub consequence: verdict inconclusive',
  decidedAt: '2026-07-03T00:00:00Z',
};

const STUB_LIVE_READOUT = {
  schemaVersion: 'proofbound.experience-ablation-live-readout.v1',
  experimentId: EXP_ID,
  noOverclaim: {
    heading: 'No-overclaim',
    disallowedClaims: [
      '"Proofbound agents became smarter."',
      '"Memory proves DONE."',
      '"The experience layer eliminates defects."',
      '"The experience layer generalizes to failure modes it has no lessons for."',
    ],
    finalStudyVerdict: 'Causal impact: inconclusive — stub verdict (design assumption invalidated).',
  },
};

/**
 * Materialize a full stub repo root. `omit` names evidence files (or
 * 'plan-doc' / 'memory-snapshot') to leave out; `nFreezeOverrides` patches the
 * stub n-freeze document.
 */
function makeRoot(base, name, { omit = [], scoreText, nFreezeOverrides } = {}) {
  const root = join(base, name);
  const evidence = join(root, '.lattice', 'experiments', 'experience-ablation', EXP_ID);
  mkdirSync(evidence, { recursive: true });

  let memorySnapshotHash = 'a'.repeat(64);
  if (!omit.includes('memory-snapshot')) {
    const snapDir = join(evidence, 'memory-snapshot');
    mkdirSync(snapDir, { recursive: true });
    writeFileSync(join(snapDir, 'lessons.jsonl'), '{"id":"les-stale-doc","lesson":"stub"}\n');
    memorySnapshotHash = hashDirectorySnapshot(snapDir);
  }

  const payload = {
    schemaVersion: 'proofbound.experience-ablation-protocol.v1',
    experimentId: EXP_ID,
    taskClasses: { inStore: ['stale-doc'], heldOut: ['tool-hallucination'], clean: ['clean'] },
    perPopulation: {
      seeded: { alpha: 0.05, power: 0.8, baselineBand: [0.5, 0.8], mdeBand: [0.25, 0.35] },
      live: { alpha: 0.05, power: 0.8, baseline: 0.3, mde: 0.1 },
    },
    pilotFreezeRule: { minControlFaultRuns: 3, freezeAt: 'wilson95Lower', maxCiWidth: 0.9 },
    noOverclaimBoundaryRef: `${PLAN_DOC_RELPATH}#15-no-overclaim-rule`,
    memorySnapshotHash,
  };
  const protocolHash = sha256(canonicalStringify(payload));
  const write = (file, text) => { if (!omit.includes(file)) writeFileSync(join(evidence, file), text); };

  write('protocol.json', `${JSON.stringify({ ...payload, protocolHash, createdAt: '2026-07-03T00:00:00Z' }, null, 2)}\n`);
  write('protocol-config.json', `${JSON.stringify(payload, null, 2)}\n`);
  write('memory-snapshot-hash.json', `${JSON.stringify({ memorySnapshotHash, protocolHash }, null, 2)}\n`);

  const manifestText = FIXTURES.map((f) => `${JSON.stringify(f)}\n`).join('');
  const ledgerRows = FIXTURES.map((f) => ({
    pairId: f.fixtureId,
    armRuns: ['control', 'treatment'].map((arm) => ({ armRunId: `${f.fixtureId}::${arm}`, arm, status: 'pending' })),
  }));
  const ledgerText = ledgerRows.map((r) => `${JSON.stringify(r)}\n`).join('');
  const runOrder = ledgerRows.flatMap((r) => r.armRuns.map((a) => a.armRunId));
  const sealPayload = { seed: 'stub-seed', protocolHash, manifestHash: sha256(manifestText), ledgerHash: sha256(ledgerText), runOrder };
  write('fixture-manifest.jsonl', manifestText);
  write('pair-ledger.jsonl', ledgerText);
  write('run-order-seed.json', `${JSON.stringify({ ...sealPayload, sealHash: sha256(canonicalStringify(sealPayload)) }, null, 2)}\n`);

  write('leakage-audit.jsonl', FIXTURES.map((f) => `${JSON.stringify({ fixtureId: f.fixtureId, checks: { structure: { pass: true, hits: [] } }, pass: true })}\n`).join(''));
  write('score-records.jsonl', scoreText ?? stubScoreRecordsText());

  const nFreeze = {
    schemaVersion: 'proofbound.experience-ablation-n-freeze.v1',
    experimentId: EXP_ID,
    protocolHash,
    pilotInputs: { controlInStoreFaultRuns: 3, controlInStoreFaultDefects: 1, scoreRecordsDigestPrefix: 'feedfacecafebeef', replayByteIdentical: true, voidedRecords: 1 },
    wilson95: { lower: 0.0617, upper: 0.7924, width: 0.7307, phat: 1 / 3 },
    freezeVerdict: 'refused',
    freezeAttempts: { 'mde_0.25': { ok: false, reason: 'freeze_baseline_too_low: stub' } },
    planningBand: { baseline: [0.5, 0.8], mdeBand: [0.25, 0.35] },
    outOfBandFinding: 'stub out-of-band finding: observed baseline below the planning band',
    attestedAt: '2026-07-03T00:00:00Z',
    ...nFreezeOverrides,
  };
  write('n-freeze.json', `${JSON.stringify(nFreeze, null, 2)}\n`);
  write('m7-decision.json', `${JSON.stringify(STUB_M7_DECISION, null, 2)}\n`);
  write('live-readout.json', `${JSON.stringify(STUB_LIVE_READOUT, null, 2)}\n`);
  write('live-readout.md', '# Live readout — stub (M8)\n\nFinal study verdict: Causal impact: inconclusive — stub.\n');

  if (!omit.includes('plan-doc')) {
    const planPath = join(root, PLAN_DOC_RELPATH);
    mkdirSync(join(planPath, '..'), { recursive: true });
    writeFileSync(planPath, '# stub plan\n\n## 18. Definition Of Done\n\n(stub — the real rows live in the repository plan)\n');
  }
  return root;
}

function runTool(args, opts = {}) {
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', ...opts });
}

/** Recursive content digest of a tree (skip = absolute prefixes to ignore). */
function digestTree(dir, skip = []) {
  const h = createHash('sha256');
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (skip.some((s) => p === s || p.startsWith(s + sep))) continue;
      const st = lstatSync(p);
      if (st.isDirectory()) { h.update(`D:${p}\n`); walk(p); }
      else { h.update(`F:${p}\n`); h.update(readFileSync(p)); }
    }
  };
  walk(dir);
  return h.digest('hex');
}

/** One actionable line on stderr, prefixed `evidence-map: `, mentioning `needle`. */
function assertOneLineError(name, res, needle) {
  const lines = (res.stderr ?? '').trim().split('\n').filter(Boolean);
  check(name,
    res.status !== 0 && lines.length === 1 && lines[0].startsWith('evidence-map: ') && lines[0].includes(needle),
    `status=${res.status} stderr=${JSON.stringify(res.stderr)}`);
}

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const tmp = mkdtempSync(join(tmpdir(), 'ablation-evidence-map-'));
try {
  // --- happy path -------------------------------------------------------------------
  const root = makeRoot(tmp, 'root-happy');
  const out = join(tmp, 'out-happy');
  const baseArgs = (o) => [`--root=${root}`, `--experimentId=${EXP_ID}`, `--out=${o}`, '--generatedAt=2026-07-03T12:00:00.000Z'];
  const preDigest = digestTree(tmp, [out]);
  const happy = runTool(baseArgs(out), { cwd: tmp });
  const md = happy.status === 0 ? readFileSync(join(out, 'evidence-map.md'), 'utf8') : '';
  const jsonText = happy.status === 0 ? readFileSync(join(out, 'evidence-map.json'), 'utf8') : '';
  check('happy: exit 0 and both files written under --out',
    happy.status === 0 && md.length > 0 && jsonText.length > 0,
    `status=${happy.status} stderr=${happy.stderr}`);
  let payload = null;
  try { payload = JSON.parse(jsonText); } catch { payload = null; }
  check('happy: json parses with fixed section order',
    payload !== null &&
    JSON.stringify(Object.keys(payload)) ===
      JSON.stringify(['schemaVersion', 'experimentId', 'generatedAt', 'determinism', 'planDoc', 'claimToArtifact', 'noOverclaim', 'finalSummary', 'paperTable']));

  // --- section-18 coverage --------------------------------------------------------------
  const rows = payload?.claimToArtifact?.rows ?? [];
  check('section 18: every definition-of-done row present, in order, status ok',
    rows.length === SECTION18_ROWS.length &&
    rows.every((r, i) => r.id === SECTION18_ROWS[i].id && r.claim === SECTION18_ROWS[i].claim && r.status === 'ok'),
    `ids=${rows.map((r) => r.id).join(',')}`);
  check('section 18: every claim text appears in the markdown table',
    SECTION18_ROWS.every((r) => md.includes(r.claim)));

  // --- existence + digest checks on every cited artifact -----------------------------------
  const evidence = join(root, '.lattice', 'experiments', 'experience-ablation', EXP_ID);
  const citedByName = new Map();
  for (const r of rows) for (const a of r.artifacts) citedByName.set(a.path.split('/').pop(), a);
  const digestsOk = REQUIRED_ARTIFACTS.every((name) => {
    const cited = citedByName.get(name);
    return cited && cited.exists === true && cited.sha256 === sha256File(join(evidence, name));
  });
  check('digests: every required artifact is cited with existence + correct sha256', digestsOk,
    REQUIRED_ARTIFACTS.filter((n) => !citedByName.has(n)).join(','));
  check('digests: plan document cited with correct sha256 in json + md',
    payload?.planDoc?.sha256 === sha256File(join(root, PLAN_DOC_RELPATH)) &&
    md.includes(`Plan document: ${PLAN_DOC_RELPATH} (sha256 ${payload?.planDoc?.sha256})`));
  check('digests: self-referential map artifacts carry null digest, not a fake one',
    rows.find((r) => r.id === 'claim-map')?.artifacts.every((a) => a.sha256 === null && a.exists === true) === true);

  // --- no-overclaim + verdict ------------------------------------------------------------------
  check('no-overclaim: circularity disclosure present in json + md',
    payload?.noOverclaim?.circularityDisclosure === CIRCULARITY_DISCLOSURE &&
    md.includes('authored from the same lesson store the treatment surfaces'));
  const claims = payload?.noOverclaim?.disallowedClaims ?? [];
  check('no-overclaim: all four plan-15 disallowed claims present in json + md',
    claims.length === 4 &&
    ['Proofbound agents became smarter', 'Memory proves DONE', 'The experience layer eliminates defects', 'generalizes to failure modes it has no lessons for']
      .every((c) => claims.some((k) => k.includes(c)) && md.includes(c)));
  check('verdict: exact INCONCLUSIVE line in json + md',
    payload?.finalSummary?.verdict === VERDICT_LINE && md.includes(`\n${VERDICT_LINE}\n`));
  const basis = payload?.finalSummary?.basis ?? [];
  check('verdict: basis composed from artifacts (pilot baseline, refused freeze + skip decision, unpowered contrast)',
    basis.length === 3 &&
    basis[0].includes('1/3 = 0.3333') && basis[0].includes('planning band [0.5, 0.8]') &&
    basis[1].includes('REFUSED') && basis[1].includes('skip_powered_study') &&
    basis[2].includes('never powered'),
    JSON.stringify(basis));

  // --- paper table -----------------------------------------------------------------------------
  const table = payload?.paperTable?.rows ?? [];
  const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-12;
  check('paper table: sorted trap groups with figures computed from the records',
    table.length === 3 &&
    table[0].trapGroup === 'clean' && near(table[0].controlDefectRate, 0) && near(table[0].pairedRiskDifference, 0) && table[0].medianTimeDeltaMs === 100 &&
    table[1].trapGroup === 'held_out' && near(table[1].controlDefectRate, 1) && near(table[1].treatmentDefectRate, 1) && table[1].medianTimeDeltaMs === 500 &&
    table[2].trapGroup === 'in_store' && table[2].fixtures === 3 &&
    near(table[2].controlDefectRate, 1 / 3) && near(table[2].treatmentDefectRate, 0) &&
    near(table[2].pairedRiskDifference, -0.5) && near(table[2].repeatDefectRateDelta, -1 / 3) &&
    table[2].medianTimeDeltaMs === -500 && table[2].costDelta === null,
    JSON.stringify(table));
  check('paper table: EVERY figure row labeled unpowered/exploratory in json + md',
    table.every((r) => r.inference === 'unpowered/exploratory') &&
    (() => {
      const dataRows = md.split('\n').filter((l) => /^\| (clean|held_out|in_store) \|/.test(l));
      return dataRows.length === 3 && dataRows.every((l) => l.includes(UNPOWERED_LABEL));
    })());
  check('paper table: voided treatment run excluded (in_store treatment runs = 2, paired over 2 pairs)',
    table[2]?.treatmentRuns === 2 && table[2]?.controlRuns === 3);

  // --- determinism --------------------------------------------------------------------------------
  const out2 = join(tmp, 'out-repeat');
  const repeat = runTool(baseArgs(out2), { cwd: tmp });
  check('determinism: double run byte-identical (json + md)',
    repeat.status === 0 &&
    readFileSync(join(out2, 'evidence-map.md'), 'utf8') === md &&
    readFileSync(join(out2, 'evidence-map.json'), 'utf8') === jsonText);
  const outNoTs1 = join(tmp, 'out-nots-1');
  const outNoTs2 = join(tmp, 'out-nots-2');
  const noTsArgs = (o) => [`--root=${root}`, `--experimentId=${EXP_ID}`, `--out=${o}`];
  const noTs1 = runTool(noTsArgs(outNoTs1), { cwd: tmp });
  const noTs2 = runTool(noTsArgs(outNoTs2), { cwd: tmp });
  const noTsJson = noTs1.status === 0 ? readFileSync(join(outNoTs1, 'evidence-map.json'), 'utf8') : '';
  check('determinism: without --generatedAt payload records null and stays byte-identical',
    noTs1.status === 0 && noTs2.status === 0 &&
    noTsJson === readFileSync(join(outNoTs2, 'evidence-map.json'), 'utf8') &&
    JSON.parse(noTsJson).generatedAt === null &&
    readFileSync(join(outNoTs1, 'evidence-map.md'), 'utf8') === readFileSync(join(outNoTs2, 'evidence-map.md'), 'utf8'));

  // --- write boundary ------------------------------------------------------------------------------
  check('write boundary: nothing outside --out was created or modified',
    digestTree(tmp, [out, out2, outNoTs1, outNoTs2]) === preDigest);

  // --- missing artifacts: one actionable line each ---------------------------------------------------
  const errOut = join(tmp, 'out-err');
  const errArgs = (r) => [`--root=${r}`, `--experimentId=${EXP_ID}`, `--out=${errOut}`];
  for (const name of REQUIRED_ARTIFACTS) {
    assertOneLineError(`error: missing ${name} -> one actionable line`,
      runTool(errArgs(makeRoot(tmp, `root-no-${name}`, { omit: [name] })), { cwd: tmp }),
      name);
  }
  assertOneLineError('error: missing plan document -> one actionable line',
    runTool(errArgs(makeRoot(tmp, 'root-no-plan', { omit: ['plan-doc'] })), { cwd: tmp }),
    PLAN_DOC_RELPATH);

  // --- tamper detection: recorded hash vs recomputation ----------------------------------------------
  const tamperProto = makeRoot(tmp, 'root-tamper-proto');
  const protoPath = join(tamperProto, '.lattice', 'experiments', 'experience-ablation', EXP_ID, 'protocol.json');
  const protoDoc = JSON.parse(readFileSync(protoPath, 'utf8'));
  protoDoc.taskClasses.inStore = ['tampered-after-freeze'];
  writeFileSync(protoPath, `${JSON.stringify(protoDoc, null, 2)}\n`);
  assertOneLineError('tamper: protocol payload edited after hash recording -> protocolHash mismatch',
    runTool(errArgs(tamperProto), { cwd: tmp }), 'protocolHash recompute');

  const tamperManifest = makeRoot(tmp, 'root-tamper-manifest');
  const manifestPath = join(tamperManifest, '.lattice', 'experiments', 'experience-ablation', EXP_ID, 'fixture-manifest.jsonl');
  writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8') + `${JSON.stringify({ fixtureId: 'fx-evil', trapClass: 'stale-doc', trapGroup: 'in_store', oracleRef: 'oracle.mjs' })}\n`);
  assertOneLineError('tamper: manifest row appended after sealing -> manifestHash mismatch',
    runTool(errArgs(tamperManifest), { cwd: tmp }), 'manifestHash');

  const tamperSnap = makeRoot(tmp, 'root-tamper-snapshot');
  writeFileSync(join(tamperSnap, '.lattice', 'experiments', 'experience-ablation', EXP_ID, 'memory-snapshot', 'lessons.jsonl'),
    '{"id":"les-stale-doc","lesson":"tampered after freeze"}\n');
  assertOneLineError('tamper: memory snapshot edited after freeze -> memorySnapshotHash recompute mismatch',
    runTool(errArgs(tamperSnap), { cwd: tmp }), 'memorySnapshotHash recompute');

  const drifted = stubRecords();
  drifted[2].defectPresent = true; // fx-2 control: recount no longer matches frozen pilotInputs
  assertOneLineError('tamper: score records drifted from frozen pilot inputs -> recount mismatch',
    runTool(errArgs(makeRoot(tmp, 'root-drift-records', { scoreText: stubScoreRecordsText(drifted) })), { cwd: tmp }),
    'pilot baseline recount');

  // --- fail-closed verdict guard ------------------------------------------------------------------------
  assertOneLineError('fail closed: n-freeze verdict not refused -> map refuses to claim INCONCLUSIVE',
    runTool(errArgs(makeRoot(tmp, 'root-frozen', { nFreezeOverrides: { freezeVerdict: 'frozen' } })), { cwd: tmp }),
    'freezeVerdict');

  // --- usage ----------------------------------------------------------------------------------------------
  const usage = runTool([`--root=${root}`], { cwd: tmp });
  check('usage: missing required flags exits 2 with usage line',
    usage.status === 2 && (usage.stderr ?? '').includes('usage: node evidence-map.mjs'));

  // --- unit: paper table math -------------------------------------------------------------------------------
  const unit = computePaperTable(stubRecords());
  check('unit: computePaperTable is pure and matches the CLI output figures',
    JSON.stringify(unit) === JSON.stringify(table));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`${failures} selfcheck failure(s)`);
  process.exit(1);
}
console.log('evidence-map-selfcheck: all cases passed');
