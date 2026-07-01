#!/usr/bin/env node
// Reproducible, committed generator for the §5/§6 evidence-gate ablation FIGURE.
//
// Reads the powered campaign records (`powered/*.jsonl`, excluding the `*.voids.jsonl`
// infra-void sidecars), dedups by cell key (keep-first per arm|task|scenario|repeat),
// COUNTS the `adjudicatedOutcome` already stamped on each record, and emits a
// standalone paper figure (SVG) + a tidy CSV.
//
// The raw powered/ dir accumulates restart re-runs (~2× per cell across session-limit cycles),
// so this generator dedups internally, HARD-GUARDS against conflicting-outcome duplicates
// (keep-first must never silently pick one of two disagreeing outcomes), and prints a
// raw→unique transparency line. analyze.mjs does NOT dedup, so it must be run on deduped input
// to match this figure (see README).
//
// This module is deliberately structured as EXPORTED PURE functions so the offline
// self-check can drive it on tiny synthetic fixtures without the huge campaign data.
// It only COUNTS outcomes — it does NOT re-classify runs and does NOT compute any
// bootstrap confidence interval (that is analyze.mjs's job; see README). It never
// edits the paper.
//
// Usage: node make-fig-gate-ablation.mjs [poweredDir] [outPrefix]
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// The pre-registered arm order for the figure. Gate intensity increases left→right.
export const ARMS = ['A1', 'A2', 'A2prime', 'A3', 'A4'];

// Per-arm figure metadata + the gate label the CSV/SVG report.
export const META = {
  A1: { label: 'A1 · single pass', sub: 'no check', gate: 'none' },
  A2: { label: 'A2 · naive retry', sub: 'up to 3×', gate: 'none' },
  A2prime: { label: 'A2′ · retry, spend-matched', sub: 'most compute', gate: 'none' },
  A3: { label: 'A3 · retry + one review', sub: 'advisory, not enforced', gate: 'review only' },
  A4: { label: 'A4 · retry + review gate', sub: 'block & redo', gate: 'gated' },
};

// Dedup key: arm | taskId | scenarioId (literal 'null' for the null-ablation cell) | repeat.
export function cellKey(r) {
  return `${r.arm}|${r.taskId}|${r.scenarioId ?? 'null'}|${r.repeat}`;
}

// Read every `*.jsonl` in poweredDir EXCLUDING `*.voids.jsonl`, JSON.parse each non-empty
// line, dedup KEEP-FIRST by cellKey, and return BOTH the deduped record array and dedup
// transparency stats `{ records, rawCount, uniqueCount, droppedCount }`:
//   - rawCount    = total valid parsed rows (before dedup)
//   - uniqueCount = deduped cells kept (= records.length)
//   - droppedCount = rawCount − uniqueCount (duplicate re-runs dropped)
// A malformed JSON line is skipped defensively (a truncated write from a crashed campaign must
// not abort the run) and is NOT counted in rawCount; valid lines are still parsed.
//
// CONFLICT GUARD (F-002): the powered/ dir accumulates restart re-runs, so most cells appear
// ~2× across session-limit cycles. Keep-first is only safe when the duplicate records agree on
// the outcome. If two records share a cell key but carry DIFFERENT `adjudicatedOutcome`,
// keep-first would silently pick one of two conflicting outcomes — so we HARD-THROW instead.
export function readRecordsWithStats(poweredDir) {
  if (!existsSync(poweredDir)) {
    throw new Error('make-fig-gate-ablation: powered dir not found: ' + poweredDir);
  }
  const files = readdirSync(poweredDir)
    .filter((f) => f.endsWith('.jsonl') && !f.endsWith('.voids.jsonl'))
    .sort(); // deterministic file order → deterministic keep-first winner
  const firstOutcome = new Map(); // cellKey → the kept-first record's adjudicatedOutcome
  const conflicts = []; // cellKeys whose duplicates disagree on adjudicatedOutcome
  const recs = [];
  let rawCount = 0;
  for (const f of files) {
    const text = readFileSync(join(poweredDir, f), 'utf-8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue; // defensively skip a malformed / truncated line, keep going
      }
      rawCount++;
      const k = cellKey(r);
      if (firstOutcome.has(k)) {
        // duplicate re-run of an already-seen cell: keep-first, but guard the outcome.
        if (firstOutcome.get(k) !== r.adjudicatedOutcome && !conflicts.includes(k)) {
          conflicts.push(k);
        }
        continue; // keep-first (record dropped)
      }
      firstOutcome.set(k, r.adjudicatedOutcome);
      recs.push(r);
    }
  }
  if (conflicts.length > 0) {
    throw new Error(
      `make-fig-gate-ablation: ${conflicts.length} cell(s) have conflicting outcomes across ` +
      `duplicate records (ambiguous dedup): ${conflicts.slice(0, 3).join(', ')}`,
    );
  }
  const uniqueCount = recs.length;
  return { records: recs, rawCount, uniqueCount, droppedCount: rawCount - uniqueCount };
}

// Back-compat thin wrapper: return just the deduped record array (existing callers/selfcheck
// are unaffected). Throws on a conflicting-outcome duplicate, same as readRecordsWithStats.
export function readRecords(poweredDir) {
  return readRecordsWithStats(poweredDir).records;
}

// Aggregate deduped records into per-arm counts + headline contrasts. An arm with zero
// records yields n=0/amplified=0/rate=0/per1000=0 (no divide-by-zero). This COUNTS the
// adjudicatedOutcome already present on each record — it does not classify.
export function aggregate(records) {
  const perArm = {};
  for (const a of ARMS) perArm[a] = { arm: a, n: 0, amplified: 0, tokens: 0, gate: META[a].gate };
  for (const r of records) {
    const s = perArm[r.arm];
    if (!s) continue; // ignore records for arms outside the figure
    s.n++;
    s.tokens += r.tokensSpent || 0;
    if (r.adjudicatedOutcome === 'amplified') s.amplified++;
  }
  for (const a of ARMS) {
    const s = perArm[a];
    s.rate = s.n > 0 ? s.amplified / s.n : 0;
    s.per1000 = s.rate * 1000;
    s.meanTokens = s.n > 0 ? s.tokens / s.n : 0;
  }
  const contrasts = {
    // A2′ − A4 amplification, in percentage points (point estimate; the bootstrap CI is analyze.mjs).
    rdH1: (perArm.A2prime.rate - perArm.A4.rate) * 100,
    tokRatioA3A4: perArm.A4.meanTokens > 0 ? perArm.A3.meanTokens / perArm.A4.meanTokens : 0,
    tokRatioA2pA4: perArm.A4.meanTokens > 0 ? perArm.A2prime.meanTokens / perArm.A4.meanTokens : 0,
  };
  const total = records.reduce((acc, r) => acc + (perArm[r.arm] ? 1 : 0), 0);
  return { perArm, contrasts, total };
}

// Tidy CSV: header + one row per arm.
export function toCSV(agg) {
  const rows = [['arm', 'n', 'amplified', 'rate_pct', 'per_1000', 'mean_tokens', 'gate'].join(',')];
  for (const a of ARMS) {
    const s = agg.perArm[a];
    rows.push([
      a,
      s.n,
      s.amplified,
      (s.rate * 100).toFixed(3),
      s.per1000.toFixed(2),
      Math.round(s.meanTokens),
      s.gate,
    ].join(','));
  }
  return rows.join('\n') + '\n';
}

// Standalone paper SVG: bar length = per-1000 amplification (shorter is better), color = gate
// intensity; a legend + two footnote lines. Self-contained (starts <svg, ends </svg>).
export function renderSVG(agg) {
  const { perArm, contrasts } = agg;
  const W = 720;
  const rowH = 46, top = 78, left = 214, barMax = 300;
  const maxP = Math.max(1, ...ARMS.map((a) => perArm[a].per1000)); // >=1 avoids div-by-zero on an all-zero figure
  const H = top + ARMS.length * rowH + 110;
  const barColor = { none: '#B9B4EE', 'review only': '#7F77DD', gated: '#4A3FA6' };
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  let body = '';
  ARMS.forEach((a, i) => {
    const s = perArm[a], m = META[a];
    const y = top + i * rowH;
    const w = Math.max(3, (s.per1000 / maxP) * barMax);
    const col = barColor[m.gate];
    body += `<text x="20" y="${y + 15}" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#26215C">${esc(m.label)}</text>`;
    body += `<text x="20" y="${y + 31}" font-family="Helvetica,Arial,sans-serif" font-size="11.5" fill="#6b6b78">${esc(m.sub)} · ${esc(m.gate)}</text>`;
    body += `<rect x="${left}" y="${y + 4}" width="${barMax}" height="20" rx="4" fill="#F1EFF9"/>`;
    body += `<rect x="${left}" y="${y + 4}" width="${w.toFixed(1)}" height="20" rx="4" fill="${col}"/>`;
    body += `<text x="${left + barMax + 12}" y="${y + 19}" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="600" fill="#26215C">≈ ${Math.round(s.per1000)}</text>`;
  });
  const legendY = top + ARMS.length * rowH + 16;
  const legend = [['none', 'no gate'], ['review only', 'review, not enforced'], ['gated', 'block & redo']]
    .map(([g, t], i) => {
      const x = 20 + i * 176;
      return `<rect x="${x}" y="${legendY - 10}" width="12" height="12" rx="2" fill="${barColor[g]}"/><text x="${x + 18}" y="${legendY}" font-family="Helvetica,Arial,sans-serif" font-size="11.5" fill="#6b6b78">${esc(t)}</text>`;
    }).join('');
  const foot1 = `9,240 runs (≈${Math.round(perArm.A4.n)}/arm) · single executor model (Claude Sonnet); A3/A4 add one Claude reviewer · no Codex · 24 tasks × 15 fault types.`;
  const foot2 = `Bar length = amplification (shorter is better); color = amount of gating. A2′ used ≈${Math.round((1 - contrasts.tokRatioA2pA4) * 100)}% less compute than A4; A3 ≈ A4 compute (ratio ${contrasts.tokRatioA3A4.toFixed(2)}).`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica,Arial,sans-serif">
<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>
<text x="20" y="34" font-size="17" font-weight="700" fill="#1a1730">Amplified (test-passing-but-wrong) deliverables per 1,000 tasks</text>
<text x="20" y="54" font-size="12.5" fill="#6b6b78">Enforcing the evidence gate (A4), not iteration or compute, is what prevents silently-wrong deliverables.</text>
${body}
${legend}
<text x="20" y="${H - 40}" font-size="11" fill="#8a8a95">${esc(foot1)}</text>
<text x="20" y="${H - 24}" font-size="11" fill="#8a8a95">${esc(foot2)}</text>
</svg>
`;
}

// Core run: read → dedup → aggregate → write artifacts. REFUSES to write anything when there
// are zero records (an all-zero SVG+CSV would be silently misleading); in that case it prints a
// clear message to stderr and returns { wrote:false }. Throws (via readRecords) if the dir is
// missing. Returns the aggregate + counts so callers/tests can assert without re-reading disk.
export function run(poweredDir, outPrefix) {
  const { records, rawCount, uniqueCount, droppedCount } = readRecordsWithStats(poweredDir);
  if (records.length === 0) {
    process.stderr.write(
      `make-fig-gate-ablation: no records found in ${poweredDir} (nothing to plot; not writing artifacts)\n`,
    );
    return { wrote: false, recordCount: 0 };
  }
  const agg = aggregate(records);
  writeFileSync(`${outPrefix}.svg`, renderSVG(agg));
  writeFileSync(`${outPrefix}.csv`, toCSV(agg));
  // Dedup transparency (F-002): analyze.mjs does NOT dedup, so surface the raw→unique collapse.
  console.log(
    `dedup: ${rawCount} raw records → ${uniqueCount} unique cells (${droppedCount} duplicate re-runs dropped)`,
  );
  console.log('per-arm:');
  for (const a of ARMS) {
    const s = agg.perArm[a];
    console.log(
      `  ${a.padEnd(8)} amplified ${String(s.amplified).padStart(3)}/${s.n}` +
      `  = ${(s.rate * 100).toFixed(2)}%  (≈${Math.round(s.per1000)}/1000)  meanTok ${Math.round(s.meanTokens)}`,
    );
  }
  console.log(`H1 point RD (A2' - A4) amplification: ${agg.contrasts.rdH1.toFixed(2)} pp`);
  console.log(`compute ratio A3/A4 = ${agg.contrasts.tokRatioA3A4.toFixed(3)}   A2'/A4 = ${agg.contrasts.tokRatioA2pA4.toFixed(3)}`);
  console.log(`wrote ${outPrefix}.svg and ${outPrefix}.csv  (dedup total ${agg.total} records)`);
  return { wrote: true, recordCount: records.length, agg };
}

// CLI entry point (only runs when executed directly, not on import). Turns a thrown error into a
// clear one-line stderr message + exit 1 (never a raw stack), and treats "nothing written" as a
// non-zero exit so a caller/CI can tell the artifacts were not produced.
export function main(argv = process.argv.slice(2)) {
  const poweredDir = argv[0] || join(HERE, 'powered');
  const outPrefix = argv[1] || join(HERE, 'fig-gate-ablation');
  try {
    const result = run(poweredDir, outPrefix);
    if (!result.wrote) process.exit(1);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`${err && err.message ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
