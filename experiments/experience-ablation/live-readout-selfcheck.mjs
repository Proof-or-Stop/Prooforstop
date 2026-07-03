#!/usr/bin/env node
// live-readout-selfcheck.mjs — hermetic selfcheck for the M8 live readout tool.
//
// Everything runs inside mkdtemp roots with STUB inputs; the real
// learning_effectiveness CLI is NEVER spawned (every run injects
// --effectivenessJson), no repository path is read or written, and the tmp
// tree is removed on exit. Asserted here:
//
//   - strict section separation and order (controlled -> live -> no-overclaim)
//     in both the markdown and the JSON key order;
//   - the live section header states non-inferential / cannot answer H1 per
//     plan sections 5.2/15, and EVERY live figure line carries the
//     [exploratory-only] label (and the controlled section carries none);
//   - the no-overclaim block quotes the plan-15 disallowed claims and the
//     final inconclusive verdict;
//   - deterministic double-run byte-identity (with and without --generatedAt);
//   - the defensive text-format fallback parses the stable human rendering;
//   - each missing required pilot artifact fails with exactly ONE actionable
//     line, as do malformed records and a missing --effectivenessJson file;
//   - the tool never writes outside --out (recursive tree digest before/after).

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  EXPLORATORY_LABEL,
  CONTROLLED_HEADING,
  LIVE_HEADING,
  NO_OVERCLAIM_HEADING,
  parseScoreRecordsText,
  parseEffectivenessText,
  summarizeRecords,
} from './live-readout.mjs';

const TOOL = new URL('./live-readout.mjs', import.meta.url).pathname;
const EXP_ID = 'expabl-selfcheck-v1';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS ${name}`);
  else { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// --- stub fixtures -----------------------------------------------------------------

function stubRecord(overrides) {
  return {
    schemaVersion: 'proofbound.experience-ablation-score.v1',
    experimentId: EXP_ID,
    taskId: 'fx-stub::x',
    pairId: 'fx-stub',
    arm: 'control',
    trapClass: 'stale-doc',
    trapGroup: 'in_store',
    cleanTask: false,
    defectPresent: false,
    voided: false,
    voidReason: null,
    ...overrides,
  };
}

/** Concatenated pretty-printed AND single-line records — the real on-disk mix. */
function stubScoreRecordsText() {
  const records = [
    stubRecord({ taskId: 'fx-1::control', pairId: 'fx-1', defectPresent: true }),
    stubRecord({ taskId: 'fx-2::control', pairId: 'fx-2' }),
    stubRecord({ taskId: 'fx-1::treatment', pairId: 'fx-1', arm: 'treatment' }),
    stubRecord({ taskId: 'fx-3::treatment', pairId: 'fx-3', arm: 'treatment', trapGroup: 'held_out', trapClass: 'tool-hallucination' }),
    stubRecord({ taskId: 'fx-4::control', pairId: 'fx-4', trapGroup: 'clean', trapClass: 'clean', cleanTask: true }),
    stubRecord({
      taskId: 'fx-5::treatment', pairId: 'fx-5', arm: 'treatment', voided: true,
      voidReason: 'store isolation: run used {shared} production root — braces on purpose',
    }),
  ];
  // records[1] and records[3] single-line, the rest pretty-printed (real format mix).
  return records
    .map((r, i) => (i === 1 || i === 3 ? `${JSON.stringify(r)}\n` : `${JSON.stringify(r, null, 2)}\n`))
    .join('');
}

const STUB_N_FREEZE = {
  schemaVersion: 'proofbound.experience-ablation-n-freeze.v1',
  experimentId: EXP_ID,
  pilotInputs: {
    controlInStoreFaultRuns: 2,
    controlInStoreFaultDefects: 1,
    scoreRecordsDigestPrefix: 'feedfacecafebeef',
    replayByteIdentical: true,
    voidedRecords: 1,
  },
  wilson95: { lower: 0.0945, upper: 0.9055, width: 0.811, phat: 0.5 },
  freezeVerdict: 'refused',
  freezeAttempts: {
    'mde_0.35': { ok: false, reason: 'freeze_baseline_too_low: sizing baseline 0.9055 exceeds no computable N (stub)' },
    'mde_0.25': { ok: false, reason: 'freeze_baseline_too_low: stub refusal reason' },
  },
  planningBand: { baseline: [0.5, 0.8], mdeBand: [0.25, 0.35] },
  outOfBandFinding: 'stub out-of-band finding: observed baseline outside the planning band',
  attestedAt: '2026-07-03T00:00:00Z',
};

const STUB_M7_DECISION = {
  schemaVersion: 'proofbound.experience-ablation-m7-decision.v1',
  experimentId: EXP_ID,
  decision: 'skip_powered_study',
  decidedBy: 'stub user via explicit option selection',
  basis: 'stub basis: freeze refused, powered study unsizable',
  consequence: 'stub consequence: M8 proceeds exploratory-only; verdict inconclusive',
  decidedAt: '2026-07-03T00:00:00Z',
};

const STUB_EFFECTIVENESS_JSON = {
  predictiveValue: {
    stories: 7, findingsWithSig: 5, preWarnable: 2, recall: 0.4,
    windows: [{ cutoff: 25, hitRate: 0 }], slopeSign: '+',
  },
  armComparison: {
    nOn: 3, nOff: 4, outcomeOn: 0.1, outcomeOff: 0.25, delta: 0.15,
    significant: false, note: 'insufficient arm N (stub)',
  },
};

const STUB_EFFECTIVENESS_TEXT = [
  'Experience Layer — learning effectiveness (read-only, advisory)',
  'FAST predictive value (per-story hint, retrodictive):',
  '  stories scanned:        7',
  '  findings w/ signature:  5',
  '  pre-warnable findings:  2',
  '  recall:    0.400',
  '  trend (windowed hit-rate, slope +):',
  '    <=25: 0.000',
  'LONG-GAME ON/OFF arm comparison (experience_hint_surfaced hintMode):',
  '  nOn:  3',
  '  nOff: 4',
  '  outcomeOn  (uncaught recurrence rate): 0.100',
  '  outcomeOff (uncaught recurrence rate): 0.250',
  '  delta (off - on): 0.150',
  '  significant: NO — insufficient arm N (stub)',
  '(advisory, read-only — no gate touched, nothing written)',
].join('\n');

/** Materialize a stub repo root; `omit` names evidence files to leave out. */
function makeRoot(base, name, { omit = [], scoreText } = {}) {
  const root = join(base, name);
  const evidence = join(root, '.lattice', 'experiments', 'experience-ablation', EXP_ID);
  mkdirSync(evidence, { recursive: true });
  if (!omit.includes('score-records.jsonl')) {
    writeFileSync(join(evidence, 'score-records.jsonl'), scoreText ?? stubScoreRecordsText());
  }
  if (!omit.includes('n-freeze.json')) {
    writeFileSync(join(evidence, 'n-freeze.json'), `${JSON.stringify(STUB_N_FREEZE, null, 2)}\n`);
  }
  if (!omit.includes('m7-decision.json')) {
    writeFileSync(join(evidence, 'm7-decision.json'), `${JSON.stringify(STUB_M7_DECISION, null, 2)}\n`);
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

/** Slice one `## <heading>` section body out of the markdown. */
function sectionOf(md, heading) {
  const marker = `## ${heading}`;
  const start = md.indexOf(marker);
  if (start === -1) return null;
  const rest = md.slice(start + marker.length);
  const next = rest.indexOf('\n## ');
  return next === -1 ? rest : rest.slice(0, next);
}

/** One actionable line on stderr, prefixed `live-readout: `, mentioning `needle`. */
function assertOneLineError(name, res, needle) {
  const lines = (res.stderr ?? '').trim().split('\n').filter(Boolean);
  check(name,
    res.status !== 0 && lines.length === 1 && lines[0].startsWith('live-readout: ') && lines[0].includes(needle),
    `status=${res.status} stderr=${JSON.stringify(res.stderr)}`);
}

const tmp = mkdtempSync(join(tmpdir(), 'ablation-live-readout-'));
try {
  const effJsonPath = join(tmp, 'effectiveness.json');
  writeFileSync(effJsonPath, `${JSON.stringify(STUB_EFFECTIVENESS_JSON, null, 2)}\n`);
  const effTextPath = join(tmp, 'effectiveness.txt');
  writeFileSync(effTextPath, STUB_EFFECTIVENESS_TEXT);

  // --- happy path -------------------------------------------------------------------
  const root = makeRoot(tmp, 'root-happy');
  const out = join(tmp, 'out-happy');
  const baseArgs = (o) => [
    `--root=${root}`, `--experimentId=${EXP_ID}`, `--out=${o}`,
    `--effectivenessJson=${effJsonPath}`, '--generatedAt=2026-07-03T12:00:00.000Z',
  ];
  const preDigest = digestTree(tmp, [out]);
  const happy = runTool(baseArgs(out), { cwd: tmp });
  const md = happy.status === 0 ? readFileSync(join(out, 'live-readout.md'), 'utf8') : '';
  const jsonText = happy.status === 0 ? readFileSync(join(out, 'live-readout.json'), 'utf8') : '';
  check('happy: exit 0 and both files written under --out',
    happy.status === 0 && md.length > 0 && jsonText.length > 0,
    `status=${happy.status} stderr=${happy.stderr}`);

  // --- strict section separation + order ---------------------------------------------
  const iControlled = md.indexOf(`## ${CONTROLLED_HEADING}`);
  const iLive = md.indexOf(`## ${LIVE_HEADING}`);
  const iNo = md.indexOf(`## ${NO_OVERCLAIM_HEADING}`);
  check('md: controlled section precedes live section precedes no-overclaim',
    iControlled !== -1 && iLive !== -1 && iNo !== -1 && iControlled < iLive && iLive < iNo,
    `indices ${iControlled}/${iLive}/${iNo}`);
  check('md: live header states non-inferential / cannot answer H1 / plan 5.2+15',
    LIVE_HEADING.includes('non-inferential') && LIVE_HEADING.includes('cannot answer H1') &&
    LIVE_HEADING.includes('5.2') && LIVE_HEADING.includes('15') && iLive !== -1);

  const liveSection = sectionOf(md, LIVE_HEADING) ?? '';
  const controlledSection = sectionOf(md, CONTROLLED_HEADING) ?? '';
  const liveBullets = liveSection.split('\n').filter((l) => l.startsWith('- '));
  check('md: every live figure line carries the exploratory-only label',
    liveBullets.length >= 10 && liveBullets.every((l) => l.includes(EXPLORATORY_LABEL)),
    `bullets=${liveBullets.length} unlabeled=${JSON.stringify(liveBullets.filter((l) => !l.includes(EXPLORATORY_LABEL)))}`);
  const expectFigure = (label, value) =>
    liveBullets.some((l) => l.includes(label) && l.includes(value) && l.includes(EXPLORATORY_LABEL));
  check('md: each expected live figure appears on a labeled line',
    expectFigure('stories scanned', '7') && expectFigure('findings w/ signature', '5') &&
    expectFigure('pre-warnable findings', '2') && expectFigure('recall', '0.4000') &&
    expectFigure('nOn', '3') && expectFigure('nOff', '4') &&
    expectFigure('outcomeOn', '0.1000') && expectFigure('outcomeOff', '0.2500') &&
    expectFigure('delta (off - on)', '0.1500') && expectFigure('significance gate', 'NO'),
    liveSection);
  check('md: controlled section carries no exploratory-only label (strict separation)',
    !controlledSection.includes(EXPLORATORY_LABEL));

  // --- controlled pilot summary -------------------------------------------------------
  check('md: controlled section carries the pilot summary',
    controlledSection.includes('total 6') &&
    controlledSection.includes('control 3 / treatment 3') &&
    controlledSection.includes('clean 1 / held_out 1 / in_store 4') &&
    controlledSection.includes('voided records: 1') &&
    controlledSection.includes('1/2 (phat 0.5000)') &&
    controlledSection.includes('[0.0945, 0.9055]') &&
    controlledSection.includes('matches frozen inputs: yes') &&
    controlledSection.includes('feedfacecafebeef') &&
    controlledSection.includes('replayByteIdentical: true'),
    controlledSection);
  check('md: controlled section carries freeze REFUSED + reason + m7 skip context',
    controlledSection.includes('freeze verdict: REFUSED') &&
    controlledSection.includes('planning band baseline [0.5, 0.8]') &&
    controlledSection.includes('freeze_baseline_too_low') &&
    controlledSection.includes('out-of-band finding: stub out-of-band finding') &&
    controlledSection.includes('M7 decision: skip_powered_study') &&
    controlledSection.includes('basis: stub basis') &&
    controlledSection.includes('consequence: stub consequence'),
    controlledSection);

  // --- no-overclaim block --------------------------------------------------------------
  const noSection = sectionOf(md, NO_OVERCLAIM_HEADING) ?? '';
  check('md: no-overclaim block carries plan-15 disallowed claims + rule',
    noSection.includes('Proofbound agents became smarter') &&
    noSection.includes('Memory proves DONE') &&
    noSection.includes('The experience layer eliminates defects') &&
    noSection.includes('generalizes to failure modes it has no lessons for') &&
    noSection.includes('directionally consistent with the controlled study'),
    noSection);
  check('md: no-overclaim block carries the final inconclusive verdict',
    noSection.includes('Causal impact: inconclusive') &&
    noSection.includes('design assumption was invalidated by the pilot baseline') &&
    noSection.includes('0.5000 fell below the planning band [0.5, 0.8]') &&
    noSection.includes('N-freeze REFUSED') &&
    noSection.includes('M7 decision skip_powered_study'),
    noSection);

  // --- machine view ---------------------------------------------------------------------
  let payload = null;
  try { payload = JSON.parse(jsonText); } catch { payload = null; }
  const topKeys = payload ? Object.keys(payload) : [];
  check('json: parses with controlled -> live -> no-overclaim key order + md headings',
    payload !== null &&
    topKeys.indexOf('controlledCausal') !== -1 &&
    topKeys.indexOf('controlledCausal') < topKeys.indexOf('liveExploratory') &&
    topKeys.indexOf('liveExploratory') < topKeys.indexOf('noOverclaim') &&
    payload.controlledCausal.heading === CONTROLLED_HEADING &&
    payload.liveExploratory.heading === LIVE_HEADING &&
    payload.noOverclaim.heading === NO_OVERCLAIM_HEADING,
    `keys=${topKeys.join(',')}`);
  check('json: every live figure row labeled exploratory-only + source recorded',
    payload !== null &&
    payload.liveExploratory.figures.length >= 10 &&
    payload.liveExploratory.figures.every((f) => f.inference === 'exploratory-only') &&
    payload.liveExploratory.inference.includes('exploratory-only') &&
    payload.liveExploratory.source === 'learning_effectiveness via file-json' &&
    payload.generatedAt === '2026-07-03T12:00:00.000Z');

  // --- determinism -----------------------------------------------------------------------
  const out2 = join(tmp, 'out-repeat');
  const repeat = runTool(baseArgs(out2), { cwd: tmp });
  check('determinism: double run byte-identical (json + md)',
    repeat.status === 0 &&
    readFileSync(join(out2, 'live-readout.md'), 'utf8') === md &&
    readFileSync(join(out2, 'live-readout.json'), 'utf8') === jsonText);
  const outNoTs1 = join(tmp, 'out-nots-1');
  const outNoTs2 = join(tmp, 'out-nots-2');
  const noTsArgs = (o) => [`--root=${root}`, `--experimentId=${EXP_ID}`, `--out=${o}`, `--effectivenessJson=${effJsonPath}`];
  const noTs1 = runTool(noTsArgs(outNoTs1), { cwd: tmp });
  const noTs2 = runTool(noTsArgs(outNoTs2), { cwd: tmp });
  const noTsJson = noTs1.status === 0 ? readFileSync(join(outNoTs1, 'live-readout.json'), 'utf8') : '';
  check('determinism: without --generatedAt payload records null and stays byte-identical',
    noTs1.status === 0 && noTs2.status === 0 &&
    noTsJson === readFileSync(join(outNoTs2, 'live-readout.json'), 'utf8') &&
    JSON.parse(noTsJson).generatedAt === null &&
    readFileSync(join(outNoTs1, 'live-readout.md'), 'utf8') === readFileSync(join(outNoTs2, 'live-readout.md'), 'utf8'));

  // --- write boundary ----------------------------------------------------------------------
  check('write boundary: nothing outside --out was created or modified',
    digestTree(tmp, [out, out2, outNoTs1, outNoTs2]) === preDigest);

  // --- defensive text fallback ----------------------------------------------------------------
  const outText = join(tmp, 'out-text');
  const textRun = runTool([
    `--root=${root}`, `--experimentId=${EXP_ID}`, `--out=${outText}`,
    `--effectivenessJson=${effTextPath}`, '--generatedAt=2026-07-03T12:00:00.000Z',
  ], { cwd: tmp });
  const textPayload = textRun.status === 0 ? JSON.parse(readFileSync(join(outText, 'live-readout.json'), 'utf8')) : null;
  check('text fallback: stable human rendering parsed defensively (file-text source)',
    textPayload !== null &&
    textPayload.liveExploratory.source === 'learning_effectiveness via file-text' &&
    textPayload.liveExploratory.figures.some((f) => f.label === 'stories scanned' && f.value === 7) &&
    textPayload.liveExploratory.figures.some((f) => f.label === 'delta (off - on)' && f.value === 0.15),
    `status=${textRun.status} stderr=${textRun.stderr}`);

  // --- missing / malformed inputs ---------------------------------------------------------------
  const errArgs = (r) => [`--root=${r}`, `--experimentId=${EXP_ID}`, `--out=${join(tmp, 'out-err')}`, `--effectivenessJson=${effJsonPath}`];
  assertOneLineError('error: missing score-records.jsonl -> one actionable line',
    runTool(errArgs(makeRoot(tmp, 'root-no-score', { omit: ['score-records.jsonl'] })), { cwd: tmp }),
    'score-records.jsonl');
  assertOneLineError('error: missing n-freeze.json -> one actionable line',
    runTool(errArgs(makeRoot(tmp, 'root-no-freeze', { omit: ['n-freeze.json'] })), { cwd: tmp }),
    'n-freeze.json');
  assertOneLineError('error: missing m7-decision.json -> one actionable line',
    runTool(errArgs(makeRoot(tmp, 'root-no-m7', { omit: ['m7-decision.json'] })), { cwd: tmp }),
    'm7-decision.json');
  assertOneLineError('error: truncated score-records.jsonl -> one actionable line',
    runTool(errArgs(makeRoot(tmp, 'root-truncated', { scoreText: '{\n  "experimentId": "x", "arm": "control"' })), { cwd: tmp }),
    'score-records.jsonl');
  assertOneLineError('error: missing --effectivenessJson file -> one actionable line',
    runTool([`--root=${root}`, `--experimentId=${EXP_ID}`, `--out=${join(tmp, 'out-err')}`, `--effectivenessJson=${join(tmp, 'nope.json')}`], { cwd: tmp }),
    'nope.json');
  const usage = runTool([`--root=${root}`], { cwd: tmp });
  check('usage: missing required flags exits 2 with usage line',
    usage.status === 2 && (usage.stderr ?? '').includes('usage: node live-readout.mjs'));

  // --- unit: robust record stream parsing ------------------------------------------------------
  const parsed = parseScoreRecordsText(stubScoreRecordsText());
  check('unit: brace-depth parser handles pretty-printed concatenation + braces in strings',
    parsed.length === 6 && parsed[5].voidReason.includes('{shared}'));
  const summary = summarizeRecords(parsed, EXP_ID);
  check('unit: recount excludes voided from baseline and tallies groups',
    summary.total === 6 && summary.voided === 1 &&
    summary.controlInStoreFaultRuns === 2 && summary.controlInStoreFaultDefects === 1 &&
    summary.byArm.control === 3 && summary.byArm.treatment === 3);
  let mismatchRejected = false;
  try { summarizeRecords([stubRecord({ experimentId: 'other-exp' })], EXP_ID); }
  catch (err) { mismatchRejected = /experimentId/.test(err.message); }
  check('unit: record experimentId mismatch rejected with actionable message', mismatchRejected);
  const textParsed = parseEffectivenessText(STUB_EFFECTIVENESS_TEXT, 'unit');
  check('unit: text scraper extracts predictive value + arm comparison',
    textParsed.predictiveValue.stories === 7 && textParsed.predictiveValue.recall === 0.4 &&
    textParsed.armComparison !== null && textParsed.armComparison.significant === false &&
    textParsed.armComparison.note.includes('insufficient arm N'));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`${failures} selfcheck failure(s)`);
  process.exit(1);
}
console.log('live-readout-selfcheck: all cases passed');
