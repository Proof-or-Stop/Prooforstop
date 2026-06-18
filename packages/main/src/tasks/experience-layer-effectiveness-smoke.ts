#!/usr/bin/env node
/**
 * B-c06a CHK-003: smoke suite for the Experience Layer learning_effectiveness
 * leaf (`core/experience-effectiveness.ts`) plus a CLI read-only smoke for the
 * `learning_effectiveness` command.
 *
 * Coverage (named `check:` lines; exits non-zero on any failure; prints
 * `effectiveness smoke passed` at the very end):
 *
 *   LEAF (hermetic — synthetic ordered stories, no fs / no repo state):
 *     - EXACT recall / precision / findingsWithSig / preWarnable for a fixture
 *       with a known recurring signatureTag across 3 stories;
 *     - EXACT windowed trend (per-window hit-rate + cutoff) + slopeSign;
 *     - confirmedOnly threads through (unconfirmed findings excluded);
 *     - never-NaN on empty / zero-denominator inputs;
 *     - determinism (compute twice => deep-equal);
 *     - arm comparison: small-N fixture (nOn=2, nOff=2, big delta) => significant
 *       FALSE with an insufficient-N note (honesty trap);
 *     - arm comparison: nOn>=20 && nOff>=20 => significant TRUE (gate behaves);
 *     - empty input => fully zeroed report, no crash.
 *
 *   CLI (drives the REAL user-facing path on the real store):
 *     - human output prints a predictive-value line;
 *     - `git status --porcelain` shows nothing newly written (read-only contract).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  computePredictiveValue,
  computeArmComparison,
  MIN_ARM_N,
  type EffStory,
} from '../core/experience-effectiveness.js';

let total = 0;
let passed = 0;
function check(label: string, fn: () => void): void {
  total += 1;
  try {
    fn();
    passed += 1;
    console.log(`check: ${label} — PASS`);
  } catch (err) {
    console.error(`check: ${label} — FAIL`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  }
}

/** Every numeric field in a value tree must be a finite number (no NaN/Infinity). */
function assertAllFinite(value: unknown, path = 'root'): void {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} must be finite, got ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertAllFinite(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertAllFinite(v, `${path}.${k}`);
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** 3 ordered stories with signatureTag "A"/"B" recurring across stories. */
const RECURRING: EffStory[] = [
  { storyId: 'B-1', createdAt: '2026-01-01', findings: [{ signatureTag: 'A' }, { signatureTag: 'B' }] },
  { storyId: 'B-2', createdAt: '2026-01-02', findings: [{ signatureTag: 'A' }, { signatureTag: 'C' }] },
  { storyId: 'B-3', createdAt: '2026-01-03', findings: [{ signatureTag: 'A' }, { signatureTag: 'B' }, { signatureTag: 'D' }] },
];

/** Build N arm stories all sharing a recurring signature so outcome is well-defined. */
function armStories(n: number, mode: 'on' | 'off', offset: number): EffStory[] {
  const out: EffStory[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      storyId: `${mode}-${i}`,
      createdAt: `2026-02-${String(offset + i).padStart(2, '0')}T00:00:00.000Z`,
      hintMode: mode,
      findings: [{ signatureTag: 'SHARED' }],
    });
  }
  return out;
}

function run(): void {
  // ─── LEAF: exact predictive value over the recurring fixture (window=2) ──────
  check('leaf: exact recall/precision/counts over recurring fixture', () => {
    const pv = computePredictiveValue(RECURRING, { window: 2 });
    assert.equal(pv.stories, 3, 'stories');
    assert.equal(pv.findingsWithSig, 7, 'findingsWithSig (2+2+3)');
    assert.equal(pv.preWarnable, 3, 'preWarnable (0 + A + A,B)');
    assert.equal(pv.recall, 3 / 7, 'recall = preWarnable/findingsWithSig');
    assert.equal(pv.precision, 1, 'precision = preWarnable/preWarnable = 1 (surfaced set non-empty)');
  });

  check('leaf: exact windowed trend + slopeSign over recurring fixture', () => {
    const pv = computePredictiveValue(RECURRING, { window: 2 });
    assert.deepEqual(
      pv.windows,
      [{ cutoff: 2, hitRate: 0.25 }, { cutoff: 3, hitRate: 2 / 3 }],
      'two windows: [0,1]=1/4, [2]=2/3',
    );
    assert.equal(pv.slopeSign, '+', 'last (0.667) > first (0.25) => +');
  });

  // ─── LEAF: descending trend => slopeSign '-' ────────────────────────────────
  check("leaf: descending hit-rate => slopeSign '-'", () => {
    // Window 1 fully pre-warned (every tag seen earlier), window 2 all-novel.
    const stories: EffStory[] = [
      { storyId: 'S0', createdAt: '2026-01-01', findings: [{ signatureTag: 'X' }] },
      { storyId: 'S1', createdAt: '2026-01-02', findings: [{ signatureTag: 'X' }] }, // window1 with S0 below? no — window starts at 0
    ];
    // Build a clearer descending case across 4 stories, window=2.
    const desc: EffStory[] = [
      { storyId: 'D0', createdAt: '2026-01-01', findings: [{ signatureTag: 'P' }] },
      { storyId: 'D1', createdAt: '2026-01-02', findings: [{ signatureTag: 'P' }] }, // window1 [D0,D1]: pre=1/2
      { storyId: 'D2', createdAt: '2026-01-03', findings: [{ signatureTag: 'Q' }] },
      { storyId: 'D3', createdAt: '2026-01-04', findings: [{ signatureTag: 'R' }] }, // window2 [D2,D3]: pre=0/2
    ];
    void stories;
    const pv = computePredictiveValue(desc, { window: 2 });
    assert.deepEqual(pv.windows, [{ cutoff: 2, hitRate: 0.5 }, { cutoff: 4, hitRate: 0 }]);
    assert.equal(pv.slopeSign, '-', 'last (0) < first (0.5) => -');
  });

  // ─── LEAF: confirmedOnly excludes unconfirmed findings ──────────────────────
  check('leaf: confirmedOnly excludes unconfirmed signature findings', () => {
    const stories: EffStory[] = [
      { storyId: 'C0', createdAt: '2026-01-01', findings: [{ signatureTag: 'Z', signatureTagSource: 'confirmed' }] },
      {
        storyId: 'C1',
        createdAt: '2026-01-02',
        findings: [
          { signatureTag: 'Z', signatureTagSource: 'confirmed' }, // counts + pre-warnable
          { signatureTag: 'Z', signatureTagSource: 'auto' }, // excluded under confirmedOnly
        ],
      },
    ];
    const all = computePredictiveValue(stories);
    assert.equal(all.findingsWithSig, 3, 'without confirmedOnly: all 3 counted');
    assert.equal(all.preWarnable, 2, 'both story-C1 Z findings pre-warnable');

    const confirmed = computePredictiveValue(stories, { confirmedOnly: true });
    assert.equal(confirmed.findingsWithSig, 2, 'confirmedOnly: only 2 confirmed Z findings');
    assert.equal(confirmed.preWarnable, 1, 'confirmedOnly: only the C1 confirmed Z is pre-warnable');
  });

  // ─── LEAF: empty input => zeroed report, no crash, no NaN ────────────────────
  check('leaf: empty input => zeroed report, never NaN', () => {
    const pv = computePredictiveValue([]);
    assert.deepEqual(pv, {
      stories: 0,
      findingsWithSig: 0,
      preWarnable: 0,
      recall: 0,
      precision: 0,
      windows: [],
      slopeSign: '0',
    });
    assertAllFinite(pv);
  });

  // ─── LEAF: zero-denominator (no signatures at all) => no NaN ─────────────────
  check('leaf: stories with no signatureTag => recall/precision 0, no NaN', () => {
    const stories: EffStory[] = [
      { storyId: 'N0', createdAt: '2026-01-01', findings: [{}, { signatureTag: '' }] },
      { storyId: 'N1', createdAt: '2026-01-02', findings: [{ signatureTag: undefined }] },
    ];
    const pv = computePredictiveValue(stories);
    assert.equal(pv.findingsWithSig, 0, 'empty/undefined tags excluded');
    assert.equal(pv.recall, 0, 'recall 0 not NaN');
    assert.equal(pv.precision, 0, 'precision 0 not NaN');
    assertAllFinite(pv);
  });

  // ─── LEAF: single story => no prior signatures possible ─────────────────────
  check('leaf: single story => preWarnable 0, recall 0', () => {
    const pv = computePredictiveValue([RECURRING[0]]);
    assert.equal(pv.preWarnable, 0, 'no earlier story => nothing pre-warnable');
    assert.equal(pv.recall, 0, 'recall 0');
    assertAllFinite(pv);
  });

  // ─── LEAF: determinism (deep-equal across repeated + 100x tight-loop calls) ──
  check('leaf: deterministic (two calls deep-equal + 100x identical JSON)', () => {
    const a = computePredictiveValue(RECURRING, { window: 2 });
    const b = computePredictiveValue(RECURRING, { window: 2 });
    assert.deepEqual(a, b, 'two calls deep-equal');
    const baseline = JSON.stringify(a);
    for (let i = 0; i < 100; i += 1) {
      assert.equal(JSON.stringify(computePredictiveValue(RECURRING, { window: 2 })), baseline, `call ${i} identical`);
    }
  });

  // ─── LEAF ARM: small-N fixture with big delta => NOT significant (honesty) ───
  check('arm: nOn=2 nOff=2 big delta => significant FALSE, insufficient-N note', () => {
    const stories: EffStory[] = [
      // OFF arm: stories that recur (high uncaught rate) — but only 2 of them.
      { storyId: 'seed', createdAt: '2026-02-01', findings: [{ signatureTag: 'G' }] },
      { storyId: 'off-0', createdAt: '2026-02-02', hintMode: 'off', findings: [{ signatureTag: 'G' }] },
      { storyId: 'off-1', createdAt: '2026-02-03', hintMode: 'off', findings: [{ signatureTag: 'G' }] },
      // ON arm: all-novel signatures (low uncaught rate) — only 2 of them.
      { storyId: 'on-0', createdAt: '2026-02-04', hintMode: 'on', findings: [{ signatureTag: 'H' }] },
      { storyId: 'on-1', createdAt: '2026-02-05', hintMode: 'on', findings: [{ signatureTag: 'I' }] },
    ];
    const arm = computeArmComparison(stories);
    assert.equal(arm.nOn, 2, 'nOn');
    assert.equal(arm.nOff, 2, 'nOff');
    assert.equal(arm.outcomeOff, 1, 'OFF arm fully recurs (uncaught rate 1)');
    assert.equal(arm.outcomeOn, 0, 'ON arm all-novel (uncaught rate 0)');
    assert.equal(arm.delta, 1, 'delta = off - on = 1 (a big delta)');
    assert.equal(arm.significant, false, 'MUST NOT claim significance on tiny N');
    assert.match(arm.note, /insufficient N/, 'note states insufficient N');
    assertAllFinite(arm);
  });

  // ─── LEAF ARM: both arms >= MIN_ARM_N => significant TRUE (gate behaves) ─────
  check(`arm: nOn>=${MIN_ARM_N} && nOff>=${MIN_ARM_N} => significant TRUE`, () => {
    const stories: EffStory[] = [
      { storyId: 'seed', createdAt: '2026-02-01T00:00:00.000Z', findings: [{ signatureTag: 'SHARED' }] },
      ...armStories(MIN_ARM_N, 'off', 2),
      ...armStories(MIN_ARM_N, 'on', 2 + MIN_ARM_N),
    ];
    const arm = computeArmComparison(stories);
    assert.equal(arm.nOn, MIN_ARM_N, 'nOn at threshold');
    assert.equal(arm.nOff, MIN_ARM_N, 'nOff at threshold');
    assert.equal(arm.significant, true, 'both arms meet MIN_ARM_N => conservative gate engages');
    assert.match(arm.note, /observational/, 'note states delta is observational (no p-value)');
    assertAllFinite(arm);
  });

  // ─── LEAF ARM: exactly MIN_ARM_N-1 in one arm => NOT significant ─────────────
  check(`arm: nOn=${MIN_ARM_N - 1} (just under) => significant FALSE`, () => {
    const stories: EffStory[] = [
      ...armStories(MIN_ARM_N, 'off', 1),
      ...armStories(MIN_ARM_N - 1, 'on', 1 + MIN_ARM_N),
    ];
    const arm = computeArmComparison(stories);
    assert.equal(arm.nOn, MIN_ARM_N - 1, 'nOn just under threshold');
    assert.equal(arm.significant, false, 'one arm under MIN_ARM_N => not significant');
    assert.match(arm.note, /insufficient N/, 'note states insufficient N');
  });

  // ─── LEAF ARM: all unassigned arms => nOn=0 nOff=0, not significant ──────────
  check('arm: all hintMode undefined => nOn=0 nOff=0, insufficient N', () => {
    const arm = computeArmComparison(RECURRING); // none carry hintMode
    assert.equal(arm.nOn, 0, 'nOn 0');
    assert.equal(arm.nOff, 0, 'nOff 0');
    assert.equal(arm.significant, false, 'no arm data => not significant');
    assert.match(arm.note, /insufficient N/, 'note states insufficient N');
    assertAllFinite(arm);
  });

  // ─── LEAF ARM: one empty arm (nOn=0, nOff=many) => no NaN, not significant ───
  check('arm: nOn=0 nOff=many => no NaN on empty-arm outcome, not significant', () => {
    const stories: EffStory[] = armStories(30, 'off', 1);
    const arm = computeArmComparison(stories);
    assert.equal(arm.nOn, 0, 'nOn 0');
    assert.equal(arm.nOff, 30, 'nOff 30');
    assert.equal(arm.outcomeOn, 0, 'empty arm outcome is 0, not NaN');
    assert.equal(arm.significant, false, 'empty arm => not significant');
    assertAllFinite(arm);
  });

  // ─── LEAF: no overlap across stories => precision/recall 0, no NaN ───────────
  check('leaf: every finding has a unique signature (no overlap) => recall 0', () => {
    const stories: EffStory[] = [
      { storyId: 'U0', createdAt: '2026-01-01', findings: [{ signatureTag: 'u0' }] },
      { storyId: 'U1', createdAt: '2026-01-02', findings: [{ signatureTag: 'u1' }] },
      { storyId: 'U2', createdAt: '2026-01-03', findings: [{ signatureTag: 'u2' }] },
    ];
    const pv = computePredictiveValue(stories);
    assert.equal(pv.preWarnable, 0, 'no overlap => nothing pre-warnable');
    assert.equal(pv.recall, 0, 'recall 0');
    assert.equal(pv.precision, 0, 'precision 0 (empty surfaced set)');
    assertAllFinite(pv);
  });

  // ─── LEAF: mixed null/undefined/empty + valid tags ──────────────────────────
  check('leaf: mixed null/undefined/empty signature tags excluded, valid computed', () => {
    const stories: EffStory[] = [
      { storyId: 'M0', createdAt: '2026-01-01', findings: [{ signatureTag: 'V' }] },
      {
        storyId: 'M1',
        createdAt: '2026-01-02',
        findings: [
          { signatureTag: 'V' }, // pre-warnable
          { signatureTag: '' }, // excluded
          { signatureTag: undefined }, // excluded
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { signatureTag: null as any }, // excluded
        ],
      },
    ];
    const pv = computePredictiveValue(stories);
    assert.equal(pv.findingsWithSig, 2, 'only the two V findings count');
    assert.equal(pv.preWarnable, 1, 'the M1 V finding is pre-warnable');
    assertAllFinite(pv);
  });

  // ─── CLI: real read-only run prints a predictive-value line; nothing written ─
  check('cli: learning_effectiveness prints a predictive-value line + writes nothing', () => {
    const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
    const CLI = join(ROOT, 'bin', 'lattice.js');
    assert.ok(existsSync(CLI), `bin/lattice.js not found at ${CLI}`);

    const before = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf-8' });
    const out = execFileSync('node', [CLI, 'learning_effectiveness'], {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.match(out, /FAST predictive value/, 'human output has the predictive-value section');
    assert.match(out, /recall:/, 'human output has a recall line');

    const after = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf-8' });
    const beforeSet = new Set(before.split('\n').map((l) => l.trim()).filter(Boolean));
    const introduced = after.split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !beforeSet.has(l));
    const offending = introduced.filter((l) => /\.lattice[\\/]learning|activity\.jsonl/.test(l));
    assert.deepEqual(offending, [], `read-only violated; new write(s): ${introduced.join(' | ')}`);
  });

  console.log(`TOTAL ${total} | PASS ${passed} | FAIL ${total - passed}`);
  if (passed !== total) {
    process.exitCode = 1;
    return;
  }
  console.log('effectiveness smoke passed');
}

run();
