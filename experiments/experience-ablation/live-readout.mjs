#!/usr/bin/env node
// live-readout.mjs — M8 exploratory live readout composer (experience-ablation).
//
// Emits the plan-S13-M8 report as ONE document pair (live-readout.json machine
// view + live-readout.md human view) with two STRICTLY separated top-level
// sections plus a closing no-overclaim block:
//
//   1. "Controlled causal (seeded pilot)" — the M6 pilot summary composed from
//      the on-disk evidence root ONLY (score-records.jsonl + n-freeze.json +
//      m7-decision.json): record counts by arm/group, voided count, the FROZEN
//      control in-store fault baseline with its Wilson 95% CI (from n-freeze,
//      cross-checked against a recount of the records), the replay digest, the
//      freeze verdict (REFUSED) with per-MDE reasons, and the M7
//      skip_powered_study decision context.
//   2. "Live exploratory (observational)" — the production
//      learning_effectiveness readout (plan section 5.2): hints-only,
//      story-unit, trap-blind, NON-INFERENTIAL. Every figure line carries the
//      [exploratory-only] label and the section header itself states that the
//      section cannot answer H1 (plan sections 5.2/15).
//   3. "No-overclaim" — the plan section 15 essence (disallowed claims + the
//      strongest permitted live-side sentence) and the final study verdict:
//      causal impact inconclusive; design assumption invalidated by the pilot
//      baseline.
//
// LIVE SIDE SOURCE: the existing read-only CLI `learning_effectiveness`. The
// command DOES support `--json` (handlers/learning-effectiveness.ts renders
// `{predictiveValue, armComparison}` when args.json is set; verified against
// the built packages/main/dist CLI), so the spawn path is
// `node <root>/packages/main/dist/cli.js learning_effectiveness --json` with
// cwd=<root>. Parsing stays DEFENSIVE regardless: JSON is extracted between
// the outermost braces (tolerating progress noise), and when no JSON body
// parses the stable human text rendering is scraped for the same figures
// (stories scanned / findings w/ signature / pre-warnable / recall + the
// ON/OFF arm comparison when present). `--effectivenessJson=<path>` injects a
// pre-captured payload (JSON or text) instead of spawning — the hermetic stub
// point used by live-readout-selfcheck.mjs, which never spawns the real CLI.
//
// CONTROLLED SIDE PARSING: score-records.jsonl in the real evidence root is a
// concatenation of PRETTY-PRINTED multi-line JSON objects (not one-per-line),
// so records are split with a string-aware brace-depth scanner, never by
// newline. Records voided by the S12 store-isolation rule are excluded from
// the baseline recount (they never enter scoring baselines) but ARE counted in
// the voided tally.
//
// DETERMINISM: no wall clock anywhere in the payload — generatedAt comes from
// the --generatedAt flag only (null when absent); count maps and freeze
// attempts are emitted in sorted key order and everything else in fixed
// insertion order, so two runs over the same inputs are byte-identical.
//
// WRITE BOUNDARY: the tool writes EXACTLY two files (live-readout.json,
// live-readout.md), both under --out (default: the experiment evidence root
// <root>/.lattice/experiments/experience-ablation/<experimentId>, plan
// section 12). Nothing outside --out is created or modified, and this module
// imports nothing from packages/main — the CLI spawn is the only contact.
//
// CLI
//   node live-readout.mjs --root=<repoRoot> --experimentId=<id>
//                         [--out=<dir>] [--effectivenessJson=<path>]
//                         [--generatedAt=<iso>]
//   Any input problem exits nonzero with exactly ONE actionable line.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const READOUT_SCHEMA_VERSION = 'proofbound.experience-ablation-live-readout.v1';
export const EXPLORATORY_LABEL = '[exploratory-only]';
export const CONTROLLED_HEADING = 'Controlled causal (seeded pilot)';
export const LIVE_HEADING =
  'Live exploratory (observational; non-inferential — cannot answer H1; plan sections 5.2/15)';
export const NO_OVERCLAIM_HEADING = 'No-overclaim';

/** Plan section 15 essence: claims this study must never emit. */
export const DISALLOWED_CLAIMS = [
  '"Proofbound agents became smarter."',
  '"Memory proves DONE."',
  '"The experience layer eliminates defects."',
  '"The experience layer generalizes to failure modes it has no lessons for." (the held-out contrast was not powered, so no generalization claim is available)',
];

/** Plan section 15 live-data rule, quoted alongside every readout. */
export const LIVE_DATA_RULE =
  'Plan section 15: live shadow data is allowed only as exploratory evidence unless powered — the strongest permitted live-side sentence is "Live shadow data is directionally consistent with the controlled study", and because the powered study was refused at the N-freeze, even directional consistency stays exploratory and non-inferential here.';

/** One-line actionable failure; the CLI prints err.message verbatim. */
function fail(msg) {
  throw new Error(`live-readout: ${String(msg).replace(/\s*\n\s*/g, ' ')}`);
}

// --- controlled side: pilot artifacts ----------------------------------------------

/**
 * Split a stream of CONCATENATED JSON objects (pretty-printed multi-line
 * and/or single-line, in any mix) into parsed records. String-aware
 * brace-depth scan — braces inside JSON strings do not confuse it.
 */
export function parseScoreRecordsText(text, label = 'score-records.jsonl') {
  const records = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (depth === 0) {
      if (c === '{') {
        start = i;
        depth = 1;
      } else if (!/\s/.test(c)) {
        fail(`${label} has stray content outside JSON objects at offset ${i} — regenerate the pilot score records (score.mjs)`);
      }
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          records.push(JSON.parse(slice));
        } catch {
          fail(`${label} record ${records.length + 1} is not valid JSON — regenerate the pilot score records (score.mjs)`);
        }
      }
    }
  }
  if (depth !== 0) fail(`${label} ends mid-object (truncated record ${records.length + 1}) — regenerate the pilot score records (score.mjs)`);
  return records;
}

function readJsonArtifact(path, label, hint) {
  if (!existsSync(path)) fail(`missing required pilot artifact ${label} at ${path} — ${hint}`);
  const text = readFileSync(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    fail(`pilot artifact ${label} is not valid JSON: ${path} — ${hint}`);
  }
}

/** Deterministic sorted-key copy of a count map. */
function sortedCounts(map) {
  return Object.fromEntries(Object.keys(map).sort().map((k) => [k, map[k]]));
}

/**
 * Recount the pilot records: totals by arm and trap group, voided tally, and
 * the control in-store fault baseline (voided records excluded from the
 * baseline recount — they never enter scoring baselines).
 */
export function summarizeRecords(records, experimentId) {
  if (!Array.isArray(records) || records.length === 0) {
    fail('score-records.jsonl contains no records — run the M6 pilot campaign (run-pilot.mjs) first');
  }
  const byArm = {};
  const byGroup = {};
  let voided = 0;
  let controlInStoreFaultRuns = 0;
  let controlInStoreFaultDefects = 0;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r === null || typeof r !== 'object') fail(`score-records.jsonl record ${i + 1} is not an object`);
    if (r.experimentId !== experimentId) {
      fail(`score-records.jsonl record ${i + 1} has experimentId ${JSON.stringify(r.experimentId)}, expected ${JSON.stringify(experimentId)} — point --experimentId at the matching evidence root`);
    }
    if (typeof r.arm !== 'string' || r.arm.length === 0) fail(`score-records.jsonl record ${i + 1} is missing "arm"`);
    const group = typeof r.trapGroup === 'string' && r.trapGroup.length > 0 ? r.trapGroup : 'unknown';
    byArm[r.arm] = (byArm[r.arm] ?? 0) + 1;
    byGroup[group] = (byGroup[group] ?? 0) + 1;
    if (r.voided === true) {
      voided++;
      continue; // voided runs never enter the baseline recount
    }
    if (r.arm === 'control' && group === 'in_store' && r.cleanTask !== true) {
      controlInStoreFaultRuns++;
      if (r.defectPresent === true) controlInStoreFaultDefects++;
    }
  }
  return {
    total: records.length,
    byArm: sortedCounts(byArm),
    byGroup: sortedCounts(byGroup),
    voided,
    controlInStoreFaultRuns,
    controlInStoreFaultDefects,
  };
}

// --- live side: learning_effectiveness ----------------------------------------------

function requireNumber(obj, key, where) {
  const v = obj?.[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    fail(`${where} field "${key}" must be a finite number (got ${JSON.stringify(v)})`);
  }
  return v;
}

/** Normalize the --json payload shape {predictiveValue, armComparison}. */
export function normalizeEffectivenessJson(obj, origin) {
  const pv = obj?.predictiveValue;
  if (pv === null || typeof pv !== 'object') {
    fail(`${origin} JSON payload is missing "predictiveValue" — expected the learning_effectiveness --json shape {predictiveValue, armComparison}`);
  }
  const predictiveValue = {
    stories: requireNumber(pv, 'stories', `${origin} predictiveValue`),
    findingsWithSig: requireNumber(pv, 'findingsWithSig', `${origin} predictiveValue`),
    preWarnable: requireNumber(pv, 'preWarnable', `${origin} predictiveValue`),
    recall: requireNumber(pv, 'recall', `${origin} predictiveValue`),
  };
  if (typeof pv.slopeSign === 'string') predictiveValue.slopeSign = pv.slopeSign;
  const arms = obj?.armComparison;
  let armComparison = null;
  if (arms !== null && typeof arms === 'object') {
    armComparison = {
      nOn: requireNumber(arms, 'nOn', `${origin} armComparison`),
      nOff: requireNumber(arms, 'nOff', `${origin} armComparison`),
      outcomeOn: requireNumber(arms, 'outcomeOn', `${origin} armComparison`),
      outcomeOff: requireNumber(arms, 'outcomeOff', `${origin} armComparison`),
      delta: requireNumber(arms, 'delta', `${origin} armComparison`),
      significant: arms.significant === true,
      note: typeof arms.note === 'string' ? arms.note : '',
    };
  }
  return { predictiveValue, armComparison };
}

/**
 * Defensive scrape of the STABLE human text rendering (renderHuman in
 * handlers/learning-effectiveness.ts) — the fallback when no JSON body parses.
 */
export function parseEffectivenessText(text, origin) {
  const num = (re, name, required) => {
    const m = text.match(re);
    if (!m) {
      if (required) fail(`${origin} text output is missing the "${name}" figure — expected the stable learning_effectiveness rendering`);
      return null;
    }
    return Number(m[1]);
  };
  const predictiveValue = {
    stories: num(/stories scanned:\s*(\d+)/, 'stories scanned', true),
    findingsWithSig: num(/findings w\/ signature:\s*(\d+)/, 'findings w/ signature', true),
    preWarnable: num(/pre-warnable findings:\s*(\d+)/, 'pre-warnable findings', true),
    recall: num(/recall:\s*([0-9.]+)/, 'recall', true),
  };
  const slope = text.match(/slope ([+\-0])\)/);
  if (slope) predictiveValue.slopeSign = slope[1];
  const nOn = num(/nOn:\s*(\d+)/, 'nOn', false);
  const nOff = num(/nOff:\s*(\d+)/, 'nOff', false);
  const outcomeOn = num(/outcomeOn\s*\(uncaught recurrence rate\):\s*([0-9.-]+)/, 'outcomeOn', false);
  const outcomeOff = num(/outcomeOff\s*\(uncaught recurrence rate\):\s*([0-9.-]+)/, 'outcomeOff', false);
  const delta = num(/delta \(off - on\):\s*([0-9.-]+)/, 'delta', false);
  const sig = text.match(/significant:\s*(YES|NO)(?:\s*—\s*(.*))?/);
  let armComparison = null;
  if (nOn !== null && nOff !== null && outcomeOn !== null && outcomeOff !== null && delta !== null && sig) {
    armComparison = {
      nOn, nOff, outcomeOn, outcomeOff, delta,
      significant: sig[1] === 'YES',
      note: (sig[2] ?? '').trim(),
    };
  }
  return { predictiveValue, armComparison };
}

/** JSON-first, text-fallback parse of a captured learning_effectiveness payload. */
function parseEffectivenessPayload(text, origin) {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  let parsed = null;
  if (first !== -1 && last > first) {
    try {
      parsed = JSON.parse(text.slice(first, last + 1));
    } catch {
      parsed = null;
    }
  }
  if (parsed !== null) return { effectiveness: normalizeEffectivenessJson(parsed, origin), mode: 'json' };
  return { effectiveness: parseEffectivenessText(text, origin), mode: 'text' };
}

/** Load the live readout: injected file when given, else spawn the read-only CLI. */
function loadEffectiveness({ root, effectivenessJsonPath }) {
  if (typeof effectivenessJsonPath === 'string') {
    if (!existsSync(effectivenessJsonPath)) {
      fail(`--effectivenessJson file not found: ${effectivenessJsonPath} — capture one with: node <root>/packages/main/dist/cli.js learning_effectiveness --json`);
    }
    const { effectiveness, mode } = parseEffectivenessPayload(readFileSync(effectivenessJsonPath, 'utf8'), '--effectivenessJson');
    return { effectiveness, source: `file-${mode}` };
  }
  const cliPath = join(root, 'packages', 'main', 'dist', 'cli.js');
  if (!existsSync(cliPath)) {
    fail(`learning_effectiveness CLI not found at ${cliPath} — build it (npm --prefix packages/main run build) or pass --effectivenessJson=<path>`);
  }
  const res = spawnSync(process.execPath, [cliPath, 'learning_effectiveness', '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (res.error || res.status !== 0) {
    fail(`learning_effectiveness spawn failed (${res.error ? res.error.message : `exit ${res.status}`}) — pass --effectivenessJson=<path> with a captured payload`);
  }
  const { effectiveness, mode } = parseEffectivenessPayload(res.stdout ?? '', 'learning_effectiveness');
  return { effectiveness, source: `cli-${mode}` };
}

// --- readout assembly ----------------------------------------------------------------

const fmtRate = (x) => Number(x).toFixed(4);
const fmtValue = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : fmtRate(v)) : String(v));

/** Flat, fixed-order live figure rows; every row is exploratory-only. */
export function liveFigureRows(effectiveness) {
  const rows = [];
  const pv = effectiveness.predictiveValue;
  rows.push({ group: 'fast-predictive-value', label: 'stories scanned', value: pv.stories });
  rows.push({ group: 'fast-predictive-value', label: 'findings w/ signature', value: pv.findingsWithSig });
  rows.push({ group: 'fast-predictive-value', label: 'pre-warnable findings', value: pv.preWarnable });
  rows.push({ group: 'fast-predictive-value', label: 'recall (retrodictive)', value: pv.recall });
  if (typeof pv.slopeSign === 'string') {
    rows.push({ group: 'fast-predictive-value', label: 'trend slope sign', value: pv.slopeSign });
  }
  const arms = effectiveness.armComparison;
  if (arms) {
    rows.push({ group: 'arm-comparison', label: 'ON-arm stories (nOn)', value: arms.nOn });
    rows.push({ group: 'arm-comparison', label: 'OFF-arm stories (nOff)', value: arms.nOff });
    rows.push({ group: 'arm-comparison', label: 'outcomeOn (uncaught recurrence rate)', value: arms.outcomeOn });
    rows.push({ group: 'arm-comparison', label: 'outcomeOff (uncaught recurrence rate)', value: arms.outcomeOff });
    rows.push({ group: 'arm-comparison', label: 'delta (off - on)', value: arms.delta });
    rows.push({
      group: 'arm-comparison',
      label: 'conservative significance gate',
      value: `${arms.significant ? 'YES' : 'NO'}${arms.note ? ` — ${arms.note}` : ''}`,
    });
  } else {
    rows.push({
      group: 'arm-comparison',
      label: 'ON/OFF arm comparison',
      value: 'not present in the learning_effectiveness output',
    });
  }
  return rows.map((r) => ({ ...r, inference: 'exploratory-only' }));
}

function finalStudyVerdict(nFreeze, m7Decision) {
  const phat = nFreeze.wilson95.phat;
  const band = Array.isArray(nFreeze?.planningBand?.baseline)
    ? `[${nFreeze.planningBand.baseline.join(', ')}]`
    : 'the pre-registered planning band';
  return `Causal impact: inconclusive — the design assumption was invalidated by the pilot baseline (control in-store fault baseline ${fmtRate(phat)} fell below the planning band ${band}; N-freeze ${String(nFreeze.freezeVerdict).toUpperCase()}; M7 decision ${m7Decision.decision}).`;
}

/** Assemble the full deterministic payload (fixed key order throughout). */
export function buildReadout({ experimentId, generatedAt, effectiveness, effectivenessSource, records, nFreeze, m7Decision }) {
  const counts = summarizeRecords(records, experimentId);
  const pilotInputs = nFreeze?.pilotInputs;
  if (pilotInputs === null || typeof pilotInputs !== 'object') fail('n-freeze.json is missing "pilotInputs" — re-run the pilot freeze check (sample-size.mjs)');
  const wilson = nFreeze?.wilson95;
  if (wilson === null || typeof wilson !== 'object') fail('n-freeze.json is missing "wilson95" — re-run the pilot freeze check (sample-size.mjs)');
  if (typeof nFreeze.freezeVerdict !== 'string') fail('n-freeze.json is missing "freezeVerdict" — re-run the pilot freeze check (sample-size.mjs)');
  if (typeof m7Decision?.decision !== 'string') fail('m7-decision.json is missing "decision" — record the M7 decision first');

  const frozenRuns = requireNumber(pilotInputs, 'controlInStoreFaultRuns', 'n-freeze pilotInputs');
  const frozenDefects = requireNumber(pilotInputs, 'controlInStoreFaultDefects', 'n-freeze pilotInputs');
  const matchesFrozenInputs =
    counts.controlInStoreFaultRuns === frozenRuns && counts.controlInStoreFaultDefects === frozenDefects;

  const attempts = nFreeze.freezeAttempts && typeof nFreeze.freezeAttempts === 'object'
    ? Object.keys(nFreeze.freezeAttempts).sort().map((name) => ({
        name,
        ok: nFreeze.freezeAttempts[name]?.ok === true,
        reason: typeof nFreeze.freezeAttempts[name]?.reason === 'string' ? nFreeze.freezeAttempts[name].reason : '',
      }))
    : [];

  return {
    schemaVersion: READOUT_SCHEMA_VERSION,
    experimentId,
    generatedAt: generatedAt ?? null,
    determinism: 'generatedAt comes from the --generatedAt flag only; the tool reads no wall clock',
    controlledCausal: {
      heading: CONTROLLED_HEADING,
      inference: 'controlled-causal design (seeded pilot only; the powered study was refused at the N-freeze and never run)',
      recordCounts: {
        total: counts.total,
        byArm: counts.byArm,
        byGroup: counts.byGroup,
        voided: counts.voided,
      },
      controlInStoreBaseline: {
        frozenInputs: { faultRuns: frozenRuns, faultDefects: frozenDefects },
        phat: requireNumber(wilson, 'phat', 'n-freeze wilson95'),
        wilson95: {
          lower: requireNumber(wilson, 'lower', 'n-freeze wilson95'),
          upper: requireNumber(wilson, 'upper', 'n-freeze wilson95'),
          width: requireNumber(wilson, 'width', 'n-freeze wilson95'),
        },
        recomputedFromRecords: {
          faultRuns: counts.controlInStoreFaultRuns,
          faultDefects: counts.controlInStoreFaultDefects,
        },
        matchesFrozenInputs,
      },
      replay: {
        scoreRecordsDigestPrefix: typeof pilotInputs.scoreRecordsDigestPrefix === 'string' ? pilotInputs.scoreRecordsDigestPrefix : null,
        replayByteIdentical: pilotInputs.replayByteIdentical === true,
      },
      freeze: {
        verdict: nFreeze.freezeVerdict,
        verdictDisplay: String(nFreeze.freezeVerdict).toUpperCase(),
        attempts,
        planningBand: nFreeze.planningBand ?? null,
        outOfBandFinding: typeof nFreeze.outOfBandFinding === 'string' ? nFreeze.outOfBandFinding : null,
      },
      m7Decision: {
        decision: m7Decision.decision,
        decidedBy: typeof m7Decision.decidedBy === 'string' ? m7Decision.decidedBy : null,
        decidedAt: typeof m7Decision.decidedAt === 'string' ? m7Decision.decidedAt : null,
        basis: typeof m7Decision.basis === 'string' ? m7Decision.basis : null,
        consequence: typeof m7Decision.consequence === 'string' ? m7Decision.consequence : null,
      },
    },
    liveExploratory: {
      heading: LIVE_HEADING,
      inference: 'exploratory-only — non-inferential, observational; hints-only, story-unit, trap-blind; cannot answer H1 (plan sections 5.2/15)',
      source: `learning_effectiveness via ${effectivenessSource}`,
      figures: liveFigureRows(effectiveness),
    },
    noOverclaim: {
      heading: NO_OVERCLAIM_HEADING,
      liveDataRule: LIVE_DATA_RULE,
      disallowedClaims: [...DISALLOWED_CLAIMS],
      finalStudyVerdict: finalStudyVerdict(nFreeze, m7Decision),
    },
  };
}

/** Render the human markdown view from the assembled payload. */
export function renderMarkdown(payload) {
  const c = payload.controlledCausal;
  const l = payload.liveExploratory;
  const n = payload.noOverclaim;
  const countMap = (m) => Object.keys(m).map((k) => `${k} ${m[k]}`).join(' / ');
  const lines = [];
  lines.push(`# Live readout — ${payload.experimentId} (M8)`);
  lines.push('');
  lines.push(`Generated at: ${payload.generatedAt ?? 'not recorded (no --generatedAt flag; the tool injects no wall clock)'}`);
  lines.push(`Live source: ${l.source}`);
  lines.push('');
  lines.push(`## ${c.heading}`);
  lines.push('');
  lines.push(`Inference class: ${c.inference}.`);
  lines.push('');
  const b = c.controlInStoreBaseline;
  lines.push(`- pilot records: total ${c.recordCounts.total} — by arm: ${countMap(c.recordCounts.byArm)}`);
  lines.push(`- records by trap group: ${countMap(c.recordCounts.byGroup)}`);
  lines.push(`- voided records: ${c.recordCounts.voided}`);
  lines.push(`- control in-store fault baseline (frozen pilot inputs): ${b.frozenInputs.faultDefects}/${b.frozenInputs.faultRuns} (phat ${fmtRate(b.phat)})`);
  lines.push(`- Wilson 95% CI: [${fmtRate(b.wilson95.lower)}, ${fmtRate(b.wilson95.upper)}] — width ${fmtRate(b.wilson95.width)}`);
  lines.push(`- baseline recomputed from score-records.jsonl: ${b.recomputedFromRecords.faultDefects}/${b.recomputedFromRecords.faultRuns} — matches frozen inputs: ${b.matchesFrozenInputs ? 'yes' : 'NO (investigate before citing the pilot)'}`);
  lines.push(`- replay digest: scoreRecordsDigestPrefix ${c.replay.scoreRecordsDigestPrefix ?? 'unavailable'} — replayByteIdentical: ${c.replay.replayByteIdentical}`);
  const bandText = Array.isArray(c.freeze.planningBand?.baseline)
    ? ` — planning band baseline [${c.freeze.planningBand.baseline.join(', ')}], MDE band [${(c.freeze.planningBand.mdeBand ?? []).join(', ')}]`
    : '';
  lines.push(`- freeze verdict: ${c.freeze.verdictDisplay}${bandText}`);
  for (const a of c.freeze.attempts) {
    lines.push(`  - ${a.name}: ${a.ok ? 'ok' : a.reason || 'refused (no reason recorded)'}`);
  }
  if (c.freeze.outOfBandFinding) lines.push(`- out-of-band finding: ${c.freeze.outOfBandFinding}`);
  const m7 = c.m7Decision;
  lines.push(`- M7 decision: ${m7.decision}${m7.decidedBy ? ` — decided by ${m7.decidedBy}` : ''}${m7.decidedAt ? ` at ${m7.decidedAt}` : ''}`);
  if (m7.basis) lines.push(`  - basis: ${m7.basis}`);
  if (m7.consequence) lines.push(`  - consequence: ${m7.consequence}`);
  lines.push('');
  lines.push(`## ${l.heading}`);
  lines.push('');
  lines.push('This section is observational ONLY (plan section 5.2): hints-only, story-unit, trap-blind. It is non-inferential, CANNOT answer H1, and must never be conflated with the controlled causal section above.');
  lines.push('');
  for (const row of l.figures) {
    lines.push(`- ${EXPLORATORY_LABEL} ${row.label}: ${fmtValue(row.value)}`);
  }
  lines.push('');
  lines.push(`## ${n.heading}`);
  lines.push('');
  lines.push(n.liveDataRule);
  lines.push('');
  lines.push('Disallowed claims (plan section 15):');
  for (const claim of n.disallowedClaims) lines.push(`- ${claim}`);
  lines.push('');
  lines.push(`Final study verdict: ${n.finalStudyVerdict}`);
  return `${lines.join('\n')}\n`;
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

export function generateLiveReadout({ root, experimentId, outDir, effectivenessJsonPath, generatedAt }) {
  if (typeof generatedAt === 'string' && !/^\d{4}-\d{2}-\d{2}T[0-9:.+Z-]+$/.test(generatedAt)) {
    fail(`--generatedAt must be an ISO 8601 timestamp (got ${JSON.stringify(generatedAt)})`);
  }
  const evidenceRoot = join(root, '.lattice', 'experiments', 'experience-ablation', experimentId);
  const scorePath = join(evidenceRoot, 'score-records.jsonl');
  if (!existsSync(scorePath)) {
    fail(`missing required pilot artifact score-records.jsonl at ${scorePath} — run the M6 pilot campaign (run-pilot.mjs) or point --root/--experimentId at the evidence root`);
  }
  const records = parseScoreRecordsText(readFileSync(scorePath, 'utf8'));
  const nFreeze = readJsonArtifact(join(evidenceRoot, 'n-freeze.json'), 'n-freeze.json', 're-run the pilot freeze check (sample-size.mjs pilotFreezeCheck / M6 scoring)');
  const m7Decision = readJsonArtifact(join(evidenceRoot, 'm7-decision.json'), 'm7-decision.json', 'record the explicit M7 decision before the M8 readout');
  const { effectiveness, source } = loadEffectiveness({ root, effectivenessJsonPath });
  const payload = buildReadout({
    experimentId,
    generatedAt,
    effectiveness,
    effectivenessSource: source,
    records,
    nFreeze,
    m7Decision,
  });
  const target = outDir ?? evidenceRoot;
  mkdirSync(target, { recursive: true });
  const jsonPath = join(target, 'live-readout.json');
  const mdPath = join(target, 'live-readout.md');
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(mdPath, renderMarkdown(payload));
  return { payload, jsonPath, mdPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.root !== 'string' || typeof args.experimentId !== 'string') {
    console.error('usage: node live-readout.mjs --root=<repoRoot> --experimentId=<id> [--out=<dir>] [--effectivenessJson=<path>] [--generatedAt=<iso>]');
    process.exit(2);
  }
  try {
    const { jsonPath, mdPath } = generateLiveReadout({
      root: resolve(args.root),
      experimentId: args.experimentId,
      outDir: typeof args.out === 'string' ? resolve(args.out) : undefined,
      effectivenessJsonPath: typeof args.effectivenessJson === 'string' ? resolve(args.effectivenessJson) : undefined,
      generatedAt: typeof args.generatedAt === 'string' ? args.generatedAt : undefined,
    });
    console.log(`live-readout: wrote ${jsonPath} and ${mdPath}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
