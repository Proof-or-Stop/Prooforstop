#!/usr/bin/env node
// evidence-map.mjs — M9 paper-ready evidence map composer (experience-ablation).
//
// Emits the plan-S13-M9 claim-to-artifact map as ONE document pair
// (evidence-map.json machine view + evidence-map.md human view) with four
// fixed sections:
//
//   1. "Claim-to-artifact map" — one row per plan-section-18 definition-of-done
//      claim (all ten, fixed order). Every cited artifact is existence-checked
//      and sha256-digested, and wherever an artifact self-declares a hash
//      (protocolHash / memorySnapshotHash / manifestHash / ledgerHash /
//      sealHash) the recorded value is cross-checked against a recomputation,
//      so the map can never cite a missing or drifted file. ANY missing
//      artifact or failed cross-check exits nonzero with ONE actionable line.
//   2. "No-overclaim" — the plan-section-15 circularity disclosure (the
//      in-store seeded traps are authored from the same lesson store the
//      treatment surfaces) plus the four disallowed claims, imported from the
//      committed M8 tool so the two reports quote one source.
//   3. "Final study summary" — the verdict line `Causal impact: INCONCLUSIVE`
//      with its three-part basis composed from the on-disk artifacts: the
//      planning-band baseline invalidated by the pilot measurement
//      (n-freeze.json), the mechanically unsizable powered study skipped by
//      explicit decision (m7-decision.json), and the never-powered in-store
//      vs held-out contrast. The tool FAILS CLOSED if the artifacts do not
//      support that verdict (freezeVerdict must be `refused`).
//   4. "Paper table" (plan section 16) — per-trap-group control/treatment
//      defect rates, paired risk difference, repeat-defect rate delta, and
//      median time delta computed from score-records.jsonl over non-voided
//      records (paired figures over pairs with BOTH arms non-voided); cost
//      delta is honestly "not recorded". EVERY figure row carries the
//      [unpowered/exploratory] label — nothing in this table is inferential.
//
// SCORE RECORD PARSING: score-records.jsonl is a concatenation of
// pretty-printed multi-line JSON objects, so the records are parsed with the
// string-aware brace-depth scanner from live-readout.mjs (imported, and its
// error prefix rewrapped as `evidence-map:`), never split by newline.
//
// DETERMINISM: no wall clock anywhere in the payload — generatedAt comes from
// the --generatedAt flag only (null when absent); trap groups and count maps
// are emitted in sorted key order and everything else in fixed insertion
// order, so two runs over the same inputs are byte-identical.
//
// WRITE BOUNDARY: the tool writes EXACTLY two files (evidence-map.json,
// evidence-map.md), both under --out (default: the experiment evidence root
// <root>/.lattice/experiments/experience-ablation/<experimentId>, plan
// section 12). Nothing outside --out is created or modified, and this module
// imports nothing from packages/main — only the sibling committed tools
// protocol.mjs (canonical hashing) and live-readout.mjs (record parsing +
// the plan-15 disallowed-claims text).
//
// CLI
//   node evidence-map.mjs --root=<repoRoot> --experimentId=<id>
//                         [--out=<dir>] [--generatedAt=<iso>]
//   Any input problem exits nonzero with exactly ONE actionable line.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  canonicalStringify,
  extractPayload,
  hashDirectorySnapshot,
  sha256,
} from './protocol.mjs';
import { DISALLOWED_CLAIMS, parseScoreRecordsText, summarizeRecords } from './live-readout.mjs';

export const EVIDENCE_MAP_SCHEMA_VERSION = 'proofbound.experience-ablation-evidence-map.v1';
export const UNPOWERED_LABEL = '[unpowered/exploratory]';
export const VERDICT_LINE = 'Causal impact: INCONCLUSIVE';
export const CLAIM_MAP_HEADING = 'Claim-to-artifact map (plan section 18 definition of done)';
export const NO_OVERCLAIM_HEADING = 'No-overclaim';
export const FINAL_SUMMARY_HEADING = 'Final study summary';
export const PAPER_TABLE_HEADING = 'Paper table (plan section 16) — unpowered/exploratory only';

/** Plan section 15 required disclosure, quoted wherever an effect is discussed. */
export const CIRCULARITY_DISCLOSURE =
  'Circularity disclosure (plan section 15): the in-store seeded traps are authored from the same lesson store the treatment surfaces; the held-out contrast was designed to bound how much of any effect is lesson-specific rather than generic priming, and that contrast was never powered.';

/** Relative path (under --root) of the governing plan document. */
export const PLAN_DOC_RELPATH =
  'docs/requirements/decisions/experience-layer-ablation-causal-validation-execution-plan.md';

/** Evidence-root artifacts every map must cite (fixed check order). */
export const REQUIRED_ARTIFACTS = [
  'protocol.json',
  'protocol-config.json',
  'memory-snapshot-hash.json',
  'fixture-manifest.jsonl',
  'pair-ledger.jsonl',
  'run-order-seed.json',
  'leakage-audit.jsonl',
  'score-records.jsonl',
  'n-freeze.json',
  'm7-decision.json',
  'live-readout.json',
  'live-readout.md',
];

/** The ten plan-section-18 definition-of-done rows, verbatim, fixed order. */
export const SECTION18_ROWS = [
  { id: 'protocol-freeze', claim: 'protocol hash and memory-snapshot hash are frozen' },
  { id: 'manifest-ledger-run-order', claim: 'fixture manifest, pair ledger, and run-order seed are immutable and reproducible' },
  { id: 'arm-behavior', claim: 'control/treatment arm behavior (compute-and-log both, render-gate one) is mechanically verified' },
  { id: 'store-isolation-leakage', claim: 'store isolation is asserted per run (no production .lattice/learning/ reads or writes) and the fixture-leakage audit passed' },
  { id: 'sample-size', claim: 'per-population sample size calculation is recorded before the powered run, with the seeded baseline validated in the pilot' },
  { id: 'score-records', claim: 'powered paired study score records are complete' },
  { id: 'analysis-report', claim: 'analysis report includes paired effect size, confidence interval, p-value, and the in-store vs held-out contrast' },
  { id: 'no-overclaim-guard', claim: 'no-overclaim guard text including the circularity disclosure is in the report' },
  { id: 'claim-map', claim: 'paper-ready claim-to-artifact map is generated' },
  { id: 'final-summary', claim: 'final summary states whether causal impact was supported, unsupported, or inconclusive' },
];

/** One-line actionable failure; the CLI prints err.message verbatim. */
function fail(msg) {
  throw new Error(`evidence-map: ${String(msg).replace(/\s*\n\s*/g, ' ')}`);
}

/** Run an imported sibling-tool function, rewrapping its error prefix as ours. */
function rewrap(fn) {
  try {
    return fn();
  } catch (err) {
    fail(String(err.message ?? err).replace(/^live-readout: /, ''));
  }
}

// --- artifact loading -----------------------------------------------------------------

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function requireArtifact(evidenceRoot, name, hint) {
  const path = join(evidenceRoot, name);
  if (!existsSync(path)) fail(`missing required evidence artifact ${name} at ${path} — ${hint}`);
  return { name, path, text: readFileSync(path, 'utf8'), sha256: sha256File(path) };
}

function parseJson(artifact) {
  try {
    return JSON.parse(artifact.text);
  } catch {
    fail(`evidence artifact ${artifact.name} is not valid JSON: ${artifact.path} — regenerate it with its committed tool`);
  }
}

function parseJsonl(artifact) {
  return artifact.text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        fail(`evidence artifact ${artifact.name} line ${i + 1} is not valid JSON: ${artifact.path} — regenerate it with its committed tool`);
      }
    });
}

// --- cross-checks -----------------------------------------------------------------------

function crossCheck(name, ok, detail) {
  if (!ok) fail(`cross-check failed [${name}]: ${detail}`);
  return { name, ok: true, detail };
}

const isHex64 = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

// --- paper table (plan section 16) --------------------------------------------------------

const fmtRate = (x) => (x === null ? 'not computable' : Number(x).toFixed(4));

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const rate = (records, flagKey) =>
  records.length === 0 ? null : records.filter((r) => r[flagKey] === true).length / records.length;

/**
 * Per-trap-group table from non-voided score records. Arm rates use all
 * non-voided records of that arm; paired figures use only pairs with BOTH
 * arms non-voided. Groups are emitted in sorted order (deterministic).
 */
export function computePaperTable(records) {
  const live = records.filter((r) => r.voided !== true);
  if (live.length === 0) fail('score-records.jsonl has no non-voided records — the paper table has nothing to compute');
  const groups = [...new Set(live.map((r) => (typeof r.trapGroup === 'string' && r.trapGroup.length > 0 ? r.trapGroup : 'unknown')))].sort();
  return groups.map((group) => {
    const inGroup = live.filter((r) => (r.trapGroup ?? 'unknown') === group);
    const control = inGroup.filter((r) => r.arm === 'control');
    const treatment = inGroup.filter((r) => r.arm === 'treatment');
    const byPair = new Map();
    for (const r of inGroup) {
      const entry = byPair.get(r.pairId) ?? {};
      entry[r.arm] = r;
      byPair.set(r.pairId, entry);
    }
    const completePairs = [...byPair.keys()].sort().map((k) => byPair.get(k)).filter((p) => p.control && p.treatment);
    const pairedDiffs = completePairs.map((p) => (p.treatment.defectPresent === true ? 1 : 0) - (p.control.defectPresent === true ? 1 : 0));
    const timeDeltas = completePairs
      .filter((p) => Number.isFinite(p.treatment.timeToDoneMs) && Number.isFinite(p.control.timeToDoneMs))
      .map((p) => p.treatment.timeToDoneMs - p.control.timeToDoneMs);
    const controlRepeat = rate(control, 'repeatDefectPresent');
    const treatmentRepeat = rate(treatment, 'repeatDefectPresent');
    return {
      trapGroup: group,
      fixtures: byPair.size,
      controlRuns: control.length,
      treatmentRuns: treatment.length,
      controlDefectRate: rate(control, 'defectPresent'),
      treatmentDefectRate: rate(treatment, 'defectPresent'),
      pairedRiskDifference: pairedDiffs.length === 0 ? null : pairedDiffs.reduce((a, b) => a + b, 0) / pairedDiffs.length,
      repeatDefectRateDelta: controlRepeat === null || treatmentRepeat === null ? null : treatmentRepeat - controlRepeat,
      medianTimeDeltaMs: median(timeDeltas),
      costDelta: null, // per-run cost was never recorded in the score schema — stated, not estimated
      inference: 'unpowered/exploratory',
    };
  });
}

// --- map assembly ---------------------------------------------------------------------------

/**
 * Build the full deterministic payload. `artifacts` is the name->loaded map,
 * `parsed` the name->parsed view, `planDoc` {path, sha256}, `outNames` the two
 * self-referential output basenames.
 */
export function buildEvidenceMap({ root, experimentId, generatedAt, artifacts, planDoc, memorySnapshot }) {
  const protocol = parseJson(artifacts['protocol.json']);
  const protocolConfig = parseJson(artifacts['protocol-config.json']);
  const snapshotHashDoc = parseJson(artifacts['memory-snapshot-hash.json']);
  const seal = parseJson(artifacts['run-order-seed.json']);
  const nFreeze = parseJson(artifacts['n-freeze.json']);
  const m7Decision = parseJson(artifacts['m7-decision.json']);
  const liveReadout = parseJson(artifacts['live-readout.json']);
  const leakageRows = parseJsonl(artifacts['leakage-audit.jsonl']);
  const ledgerRows = parseJsonl(artifacts['pair-ledger.jsonl']);
  const records = rewrap(() => parseScoreRecordsText(artifacts['score-records.jsonl'].text));

  const cite = (...names) =>
    names.map((n) => ({ path: `.lattice/experiments/experience-ablation/${experimentId}/${n}`, exists: true, sha256: artifacts[n].sha256 }));

  // Row 1 — protocol + snapshot freeze.
  if (!isHex64(protocol.protocolHash)) fail('protocol.json is missing a 64-hex protocolHash — re-freeze the protocol (protocol.mjs freeze)');
  if (!isHex64(protocol.memorySnapshotHash)) fail('protocol.json is missing a 64-hex memorySnapshotHash — re-freeze the protocol (protocol.mjs freeze)');
  const row1Checks = [
    crossCheck('protocolHash recompute', sha256(canonicalStringify(extractPayload(protocol))) === protocol.protocolHash,
      'recorded protocol.json protocolHash matches the canonical-JSON recomputation of its payload'),
    crossCheck('protocol-config payload hash', sha256(canonicalStringify(extractPayload(protocolConfig))) === protocol.protocolHash,
      'protocol-config.json payload recomputes to the same frozen protocolHash'),
    crossCheck('memory-snapshot-hash.json protocolHash', snapshotHashDoc.protocolHash === protocol.protocolHash,
      'memory-snapshot-hash.json protocolHash agrees with protocol.json'),
    crossCheck('memory-snapshot-hash.json memorySnapshotHash', snapshotHashDoc.memorySnapshotHash === protocol.memorySnapshotHash,
      'memory-snapshot-hash.json memorySnapshotHash agrees with protocol.json'),
    memorySnapshot.exists
      ? crossCheck('memorySnapshotHash recompute', memorySnapshot.recomputed === protocol.memorySnapshotHash,
          `memory-snapshot/ directory re-hashes to the recorded memorySnapshotHash (recorded ${protocol.memorySnapshotHash}, recomputed ${memorySnapshot.recomputed})`)
      : { name: 'memorySnapshotHash recompute', ok: true, detail: 'skipped — memory-snapshot/ directory not present beside the artifacts; the recorded hash is still pinned by protocol.json + memory-snapshot-hash.json' },
  ];

  // Row 2 — manifest / ledger / run-order immutability.
  const { sealHash, ...sealPayload } = seal;
  const row2Checks = [
    crossCheck('manifestHash', sha256(artifacts['fixture-manifest.jsonl'].text) === seal.manifestHash,
      'fixture-manifest.jsonl bytes re-hash to the sealed manifestHash'),
    crossCheck('ledgerHash', sha256(artifacts['pair-ledger.jsonl'].text) === seal.ledgerHash,
      'pair-ledger.jsonl bytes re-hash to the sealed ledgerHash'),
    crossCheck('sealHash recompute', sha256(canonicalStringify(sealPayload)) === sealHash,
      'run-order-seed.json sealHash matches the canonical-JSON recomputation of its payload'),
    crossCheck('seal protocolHash binding', seal.protocolHash === protocol.protocolHash,
      'run-order-seed.json is sealed against the frozen protocolHash'),
  ];

  // Row 3 — arm behavior (compute-and-log both, render-gate one).
  const liveRecs = records.filter((r) => r.voided !== true);
  const renderGateOk = liveRecs.every((r) =>
    r.arm === 'control' ? r.memoryPackShown === false : r.arm === 'treatment' ? r.memoryPackShown === true : false);
  const computeLogOk = liveRecs.every((r) => Array.isArray(r.surfacedMemoryIds));
  const row3Checks = [
    crossCheck('render gate', renderGateOk,
      `every non-voided record shows memoryPackShown=false on control and =true on treatment (${liveRecs.length} records)`),
    crossCheck('compute-and-log both arms', computeLogOk,
      'every non-voided record logs surfacedMemoryIds in both arms (retrieval computed regardless of rendering)'),
  ];

  // Row 4 — store isolation + leakage audit. The production-store test is
  // separator-safe (exact match OR prefix + path separator, mirroring the
  // selfcheck digestTree skip pattern) so a SIBLING path like
  // <root>/.lattice/learning-extra/... is NOT flagged as a violation.
  const productionStore = join(root, '.lattice', 'learning');
  const insideProductionStore = (p) => p === productionStore || p.startsWith(productionStore + sep);
  const isolationOk = liveRecs.every((r) =>
    typeof r.storeRoot === 'string' && r.storeRoot.length > 0 && !insideProductionStore(r.storeRoot) && r.retrievalViolationCount === 0);
  if (leakageRows.length === 0) fail('leakage-audit.jsonl has no rows — run the leakage audit (leakage-audit.mjs)');
  const row4Checks = [
    crossCheck('per-run store isolation', isolationOk,
      `every non-voided record pins a sandbox storeRoot outside ${productionStore} with retrievalViolationCount=0`),
    crossCheck('leakage audit all-pass', leakageRows.every((r) => r.pass === true),
      `all ${leakageRows.length} fixture leakage-audit rows pass`),
  ];

  // Row 5 — sample-size calculation recorded + pilot-validated baseline.
  const counts = rewrap(() => summarizeRecords(records, experimentId));
  const pi = nFreeze.pilotInputs ?? {};
  const wilson = nFreeze.wilson95 ?? {};
  if (typeof nFreeze.freezeVerdict !== 'string') fail('n-freeze.json is missing "freezeVerdict" — re-run the pilot freeze check (sample-size.mjs)');
  const seededBand = protocol.perPopulation?.seeded?.baselineBand;
  const row5Checks = [
    crossCheck('pilot baseline recount', counts.controlInStoreFaultRuns === pi.controlInStoreFaultRuns && counts.controlInStoreFaultDefects === pi.controlInStoreFaultDefects,
      `score-records recount ${counts.controlInStoreFaultDefects}/${counts.controlInStoreFaultRuns} matches the frozen pilotInputs ${pi.controlInStoreFaultDefects}/${pi.controlInStoreFaultRuns}`),
    crossCheck('planning band binding', JSON.stringify(nFreeze.planningBand?.baseline) === JSON.stringify(seededBand),
      `n-freeze.json planning band ${JSON.stringify(nFreeze.planningBand?.baseline)} matches the pre-registered protocol seeded baselineBand`),
  ];

  // Row 6 — score-record completeness against the sealed ledger.
  const expectedRunIds = ledgerRows.flatMap((p) => (p.armRuns ?? []).map((a) => a.armRunId));
  const seen = new Map();
  for (const r of records) seen.set(r.taskId, (seen.get(r.taskId) ?? 0) + 1);
  const missingRuns = expectedRunIds.filter((id) => !seen.has(id));
  const extraOrDup = [...seen.entries()].filter(([id, n]) => n > 1 || !expectedRunIds.includes(id)).map(([id]) => id);
  const row6Checks = [
    crossCheck('ledger coverage', missingRuns.length === 0 && extraOrDup.length === 0,
      `all ${expectedRunIds.length} sealed arm-runs have exactly one score record (missing: ${missingRuns.length}, extra/duplicate: ${extraOrDup.length})`),
  ];

  // Rows 7/8/10 — report contents.
  const lrClaims = liveReadout.noOverclaim?.disallowedClaims;
  const lrVerdict = liveReadout.noOverclaim?.finalStudyVerdict;
  const row7Checks = [
    crossCheck('pilot CI recorded', typeof wilson.phat === 'number' && typeof wilson.lower === 'number' && typeof wilson.upper === 'number',
      'n-freeze.json records the pilot baseline point estimate and Wilson 95% CI (the only interval analysis this study produced)'),
    crossCheck('readout verdict present', typeof lrVerdict === 'string' && /inconclusive/i.test(lrVerdict),
      'live-readout.json carries the recorded final study verdict (inconclusive)'),
  ];
  const row8Checks = [
    crossCheck('disallowed claims in readout', Array.isArray(lrClaims) && lrClaims.length === 4,
      'live-readout.json quotes all four plan-15 disallowed claims'),
    crossCheck('circularity disclosure in this map', CIRCULARITY_DISCLOSURE.includes('authored from the same lesson store'),
      'section 2 of this evidence map carries the plan-15 circularity disclosure verbatim'),
  ];
  if (typeof m7Decision.decision !== 'string' || m7Decision.decision.length === 0) {
    fail('m7-decision.json is missing "decision" — record the explicit M7 decision before the M9 map');
  }
  const row10Checks = [
    crossCheck('explicit skip decision', m7Decision.decision === 'skip_powered_study',
      `m7-decision.json records decision=${m7Decision.decision}, closing M7 without a powered run`),
    crossCheck('verdict consistency', typeof lrVerdict === 'string' && /inconclusive/i.test(lrVerdict),
      'the M8 readout and this map state the same INCONCLUSIVE verdict'),
  ];

  // Final-summary basis composed from the artifacts; fail closed if they do
  // not actually support the INCONCLUSIVE verdict.
  if (nFreeze.freezeVerdict !== 'refused') {
    fail(`n-freeze.json freezeVerdict is ${JSON.stringify(nFreeze.freezeVerdict)} — the INCONCLUSIVE verdict basis requires the refused N-freeze; do not emit this map against a different study state`);
  }
  const band = Array.isArray(nFreeze.planningBand?.baseline) ? `[${nFreeze.planningBand.baseline.join(', ')}]` : 'the pre-registered planning band';
  const basis = [
    `planning-band baseline invalidated by the pilot measurement: control in-store fault baseline ${pi.controlInStoreFaultDefects}/${pi.controlInStoreFaultRuns} = ${fmtRate(wilson.phat)} (Wilson 95% CI [${fmtRate(wilson.lower)}, ${fmtRate(wilson.upper)}]) fell below the pre-registered planning band ${band}`,
    `the powered paired study was mechanically unsizable at that baseline (N-freeze verdict REFUSED) and was skipped by explicit decision m7-decision.json (${m7Decision.decision})`,
    'the in-store vs held-out contrast was never powered, so no lesson-specificity or generalization claim is available',
  ];

  const rowChecks = {
    'protocol-freeze': { artifacts: cite('protocol.json', 'protocol-config.json', 'memory-snapshot-hash.json'), crossChecks: row1Checks },
    'manifest-ledger-run-order': { artifacts: cite('fixture-manifest.jsonl', 'pair-ledger.jsonl', 'run-order-seed.json'), crossChecks: row2Checks },
    'arm-behavior': { artifacts: cite('score-records.jsonl'), crossChecks: row3Checks },
    'store-isolation-leakage': { artifacts: cite('leakage-audit.jsonl', 'score-records.jsonl'), crossChecks: row4Checks },
    'sample-size': {
      artifacts: cite('n-freeze.json', 'protocol.json'), crossChecks: row5Checks,
      note: 'the pilot validated the measurement pipeline and INVALIDATED the planning-band assumption (out-of-band baseline, recorded verbatim in n-freeze.json outOfBandFinding) — that invalidation is the basis of the INCONCLUSIVE verdict below',
    },
    'score-records': {
      artifacts: cite('score-records.jsonl', 'pair-ledger.jsonl'), crossChecks: row6Checks,
      note: 'the powered study was never run — refused at the N-freeze and closed by explicit decision (m7-decision.json); completeness holds for the pilot records, which cover every sealed arm-run exactly once',
    },
    'analysis-report': {
      artifacts: cite('live-readout.json', 'live-readout.md', 'n-freeze.json'), crossChecks: row7Checks,
      note: 'no powered paired effect size / CI / p-value for H1 exists because the powered study was refused at the N-freeze; the recorded interval analysis is the pilot baseline Wilson 95% CI, and the in-store vs held-out contrast appears only as the unpowered/exploratory paper table in this map',
    },
    'no-overclaim-guard': { artifacts: cite('live-readout.json', 'live-readout.md'), crossChecks: row8Checks },
    'claim-map': {
      artifacts: [
        { path: 'evidence-map.json', exists: true, sha256: null },
        { path: 'evidence-map.md', exists: true, sha256: null },
      ],
      crossChecks: [{ name: 'self-reference', ok: true, detail: 'this document pair IS the claim-to-artifact map; it exists by construction of this run, so it carries no self-digest' }],
    },
    'final-summary': { artifacts: cite('m7-decision.json', 'live-readout.json'), crossChecks: row10Checks },
  };

  const rows = SECTION18_ROWS.map(({ id, claim }) => {
    const rc = rowChecks[id];
    return { id, claim, artifacts: rc.artifacts, crossChecks: rc.crossChecks, status: 'ok', ...(rc.note ? { note: rc.note } : {}) };
  });

  return {
    schemaVersion: EVIDENCE_MAP_SCHEMA_VERSION,
    experimentId,
    generatedAt: generatedAt ?? null,
    determinism: 'generatedAt comes from the --generatedAt flag only; the tool reads no wall clock',
    planDoc: { path: PLAN_DOC_RELPATH, exists: true, sha256: planDoc.sha256 },
    claimToArtifact: { heading: CLAIM_MAP_HEADING, rows },
    noOverclaim: {
      heading: NO_OVERCLAIM_HEADING,
      circularityDisclosure: CIRCULARITY_DISCLOSURE,
      disallowedClaims: [...DISALLOWED_CLAIMS],
    },
    finalSummary: { heading: FINAL_SUMMARY_HEADING, verdict: VERDICT_LINE, basis },
    paperTable: {
      heading: PAPER_TABLE_HEADING,
      inference: 'unpowered/exploratory — the powered study was refused at the N-freeze and never run; no figure below is inferential and none supports a causal claim',
      rows: computePaperTable(records),
    },
  };
}

// --- markdown view ------------------------------------------------------------------------

const fmtDelta = (x) => (x === null ? 'not computable' : `${x >= 0 ? '+' : ''}${Number(x).toFixed(4)}`);
const fmtMs = (x) => (x === null ? 'not computable' : `${x >= 0 ? '+' : ''}${Number(x)} ms`);

export function renderMarkdown(payload) {
  const lines = [];
  lines.push(`# Evidence map — ${payload.experimentId} (M9)`);
  lines.push('');
  lines.push(`Generated at: ${payload.generatedAt ?? 'not recorded (no --generatedAt flag; the tool injects no wall clock)'}`);
  lines.push(`Plan document: ${payload.planDoc.path} (sha256 ${payload.planDoc.sha256})`);
  lines.push('');
  lines.push(`## ${payload.claimToArtifact.heading}`);
  lines.push('');
  lines.push('| # | Definition-of-done claim | Artifact | Exists | sha256 | Status |');
  lines.push('|---|---|---|---|---|---|');
  payload.claimToArtifact.rows.forEach((row, i) => {
    row.artifacts.forEach((a, j) => {
      lines.push(`| ${j === 0 ? i + 1 : ''} | ${j === 0 ? row.claim : ''} | ${a.path} | ${a.exists ? 'yes' : 'NO'} | ${a.sha256 ?? 'self (this document pair)'} | ${row.status} |`);
    });
  });
  lines.push('');
  lines.push('Cross-checks (recorded hash vs recomputation, and content assertions):');
  for (const row of payload.claimToArtifact.rows) {
    lines.push(`- ${row.id}:`);
    for (const c of row.crossChecks) lines.push(`  - ${c.name}: ${c.ok ? 'ok' : 'FAILED'} — ${c.detail}`);
    if (row.note) lines.push(`  - note: ${row.note}`);
  }
  lines.push('');
  lines.push(`## ${payload.noOverclaim.heading}`);
  lines.push('');
  lines.push(payload.noOverclaim.circularityDisclosure);
  lines.push('');
  lines.push('Disallowed claims (plan section 15):');
  for (const claim of payload.noOverclaim.disallowedClaims) lines.push(`- ${claim}`);
  lines.push('');
  lines.push(`## ${payload.finalSummary.heading}`);
  lines.push('');
  lines.push(payload.finalSummary.verdict);
  lines.push('');
  lines.push('Basis:');
  for (const b of payload.finalSummary.basis) lines.push(`- ${b}`);
  lines.push('');
  lines.push(`## ${payload.paperTable.heading}`);
  lines.push('');
  lines.push(`Inference class: ${payload.paperTable.inference}.`);
  lines.push('');
  lines.push('| Trap group | Fixtures | Control defect rate | Treatment defect rate | Paired risk difference | Repeat-defect rate delta | Median time delta | Cost delta | Inference |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const r of payload.paperTable.rows) {
    lines.push(`| ${r.trapGroup} | ${r.fixtures} | ${fmtRate(r.controlDefectRate)} | ${fmtRate(r.treatmentDefectRate)} | ${fmtDelta(r.pairedRiskDifference)} | ${fmtDelta(r.repeatDefectRateDelta)} | ${fmtMs(r.medianTimeDeltaMs)} | not recorded | ${UNPOWERED_LABEL} |`);
  }
  lines.push('');
  lines.push(`Every figure above is ${UNPOWERED_LABEL}: no confidence interval or p-value is reported because the study was never powered (see the final study summary).`);
  return `${lines.join('\n')}\n`;
}

// --- CLI -------------------------------------------------------------------------------------

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

export function generateEvidenceMap({ root, experimentId, outDir, generatedAt }) {
  if (typeof generatedAt === 'string' && !/^\d{4}-\d{2}-\d{2}T[0-9:.+Z-]+$/.test(generatedAt)) {
    fail(`--generatedAt must be an ISO 8601 timestamp (got ${JSON.stringify(generatedAt)})`);
  }
  const evidenceRoot = join(root, '.lattice', 'experiments', 'experience-ablation', experimentId);
  const artifacts = {};
  for (const name of REQUIRED_ARTIFACTS) {
    artifacts[name] = requireArtifact(evidenceRoot, name, 'regenerate it with its committed tool (M0-M8), or point --root/--experimentId at the evidence root');
  }
  const planDocPath = join(root, PLAN_DOC_RELPATH);
  if (!existsSync(planDocPath)) {
    fail(`missing plan document ${PLAN_DOC_RELPATH} under --root=${root} — the map must cite the governing plan; point --root at the repository root`);
  }
  const planDoc = { path: planDocPath, sha256: sha256File(planDocPath) };
  const snapshotDir = join(evidenceRoot, 'memory-snapshot');
  const memorySnapshot = existsSync(snapshotDir)
    ? { exists: true, recomputed: hashDirectorySnapshot(snapshotDir) }
    : { exists: false, recomputed: null };

  const payload = buildEvidenceMap({ root, experimentId, generatedAt, artifacts, planDoc, memorySnapshot });
  const target = outDir ?? evidenceRoot;
  mkdirSync(target, { recursive: true });
  const jsonPath = join(target, 'evidence-map.json');
  const mdPath = join(target, 'evidence-map.md');
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(mdPath, renderMarkdown(payload));
  return { payload, jsonPath, mdPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.root !== 'string' || typeof args.experimentId !== 'string') {
    console.error('usage: node evidence-map.mjs --root=<repoRoot> --experimentId=<id> [--out=<dir>] [--generatedAt=<iso>]');
    process.exit(2);
  }
  try {
    const { jsonPath, mdPath } = generateEvidenceMap({
      root: resolve(args.root),
      experimentId: args.experimentId,
      outDir: typeof args.out === 'string' ? resolve(args.out) : undefined,
      generatedAt: typeof args.generatedAt === 'string' ? args.generatedAt : undefined,
    });
    console.log(`evidence-map: wrote ${jsonPath} and ${mdPath}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
