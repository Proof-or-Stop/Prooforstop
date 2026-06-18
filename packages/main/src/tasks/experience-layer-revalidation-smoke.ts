#!/usr/bin/env node
/**
 * B-a2e3 CHK-004: smoke suite for the Experience Layer referential re-validation
 * leaf (`core/experience-revalidation.ts`) plus the finding.files -> anchorFiles
 * data flow (`core/finding-signals.ts`).
 *
 * Coverage (named `check:` lines; exits non-zero on any failure; prints
 * `smoke passed` at the very end):
 *   - HERMETIC LEAF: a synthetic FindingSignalsCache with known anchorFiles
 *     (some present, some all-missing, some unanchored) + an injected fileExists
 *     stub backed by a known Set =>
 *       • exact validRate / driftRate;
 *       • unanchored EXCLUDED from the denominator (1 stale among many unanchored
 *         => driftRate 1.0);
 *       • all-gone => stale; any-present => valid;
 *       • zero-anchored => validRate 0 AND driftRate 0 (no NaN; Number.isNaN guards).
 *   - INTEGRATION: deriveFindingSignals over synthetic source findings populates
 *     anchorFiles (sorted union, deduped, capped) and feeds revalidateSignals.
 *
 * Hermetic: no network, no reliance on real repo state.
 */

import assert from 'node:assert/strict';

import {
  revalidateSignals,
  computeValidRate,
} from '../core/experience-revalidation.js';
import { deriveFindingSignals } from '../core/finding-signals.js';
import type { FindingSignal, FindingSignalsCache, SignalSourceFinding } from '../core/experience-layer-types.js';

const PINNED_NOW = '2026-06-18T00:00:00.000Z';

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

/** Build a minimal FindingSignal with the fields the leaf reads. */
function sig(localSignature: string, category: string, anchorFiles?: string[]): FindingSignal {
  const s: FindingSignal = {
    localSignature,
    category,
    fileKinds: [],
    counts: { resolved: 0, dismissed: 0, falsePositive: 0, acceptedRisk: 0, unclear: 0, partiallyMitigated: 0 },
    signalScore: 0,
    support: 0,
    exampleStoryIds: [],
    exampleFindingIds: [],
  };
  if (anchorFiles !== undefined) s.anchorFiles = anchorFiles;
  return s;
}

function cacheOf(signals: FindingSignal[]): FindingSignalsCache {
  return { schemaVersion: 1, updatedAt: PINNED_NOW, signals };
}

function run(): void {
  // ─── HERMETIC LEAF: three-state classification + exact rates ────────────────
  check('leaf: valid/stale/unanchored classification + validRate=2/3 driftRate=1/3', () => {
    const live = new Set<string>(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    const fileExists = (p: string): boolean => live.has(p);
    const cache = cacheOf([
      sig('s|valid|ts|review', 'valid', ['a.ts', 'b.ts']),       // both present  => valid
      sig('s|alsoValid|ts|review', 'alsoValid', ['c.ts', 'gone.ts']), // 1 present => valid
      sig('s|stale|ts|review', 'stale', ['x.ts', 'y.ts']),       // all gone      => stale
      sig('s|unanchored|ts|review', 'unanchored'),               // no anchorFiles => unanchored
    ]);
    const validity = revalidateSignals(cache, fileExists);
    assert.equal(validity.length, 4);
    const byCat = Object.fromEntries(validity.map((v) => [v.category, v]));
    assert.equal(byCat.valid.state, 'valid');
    assert.deepEqual(byCat.valid.present, ['a.ts', 'b.ts']);
    assert.deepEqual(byCat.valid.missing, []);
    assert.equal(byCat.alsoValid.state, 'valid', 'any-present => valid (not stale)');
    assert.deepEqual(byCat.alsoValid.present, ['c.ts']);
    assert.deepEqual(byCat.alsoValid.missing, ['gone.ts']);
    assert.equal(byCat.stale.state, 'stale', 'all-gone => stale');
    assert.deepEqual(byCat.stale.missing, ['x.ts', 'y.ts']);
    assert.equal(byCat.unanchored.state, 'unanchored');
    assert.deepEqual(byCat.unanchored.anchorFiles, []);

    const report = computeValidRate(validity);
    assert.equal(report.total, 4);
    assert.equal(report.anchored, 3, 'anchored = valid + stale (unanchored excluded)');
    assert.equal(report.valid, 2);
    assert.equal(report.stale, 1);
    assert.equal(report.unanchored, 1);
    assert.ok(Math.abs(report.validRate - 2 / 3) < 1e-9, `validRate=${report.validRate}`);
    assert.ok(Math.abs(report.driftRate - 1 / 3) < 1e-9, `driftRate=${report.driftRate}`);
    assert.equal(report.staleSignals.length, 1);
    assert.equal(report.staleSignals[0].localSignature, 's|stale|ts|review');
  });

  // ─── HERMETIC LEAF: >=1 present threshold (5 anchors, 1 present, 4 missing) ──
  check('leaf: 1 present of 5 anchors => valid (>=1 threshold)', () => {
    const live = new Set<string>(['keep.ts']);
    const cache = cacheOf([sig('s|t|ts|review', 'c', ['keep.ts', 'g1.ts', 'g2.ts', 'g3.ts', 'g4.ts'])]);
    const v = revalidateSignals(cache, (p) => live.has(p));
    assert.equal(v[0].state, 'valid');
    assert.deepEqual(v[0].present, ['keep.ts']);
    assert.deepEqual(v[0].missing, ['g1.ts', 'g2.ts', 'g3.ts', 'g4.ts']);
  });

  // ─── HERMETIC LEAF: unanchored does NOT dilute the denominator ──────────────
  check('leaf: 1 stale among 100 unanchored => driftRate 1.0 (no dilution)', () => {
    const signals: FindingSignal[] = [sig('s|stale|ts|review', 'stale', ['gone.ts'])];
    for (let i = 0; i < 100; i += 1) signals.push(sig(`s|u${i}|ts|review`, `u${i}`));
    const report = computeValidRate(revalidateSignals(cacheOf(signals), () => false));
    assert.equal(report.total, 101);
    assert.equal(report.anchored, 1, 'only the stale signal is anchored');
    assert.equal(report.stale, 1);
    assert.equal(report.unanchored, 100);
    assert.equal(report.driftRate, 1.0, 'unanchored excluded => driftRate=1.0');
    assert.equal(report.validRate, 0);
    assert.ok(!Number.isNaN(report.driftRate) && !Number.isNaN(report.validRate));
  });

  // ─── HERMETIC LEAF: zero-anchored => validRate 0, driftRate 0, never NaN ─────
  check('leaf: all-unanchored (zero anchored) => validRate 0 / driftRate 0, no NaN', () => {
    const cache = cacheOf([sig('a|||review', 'a'), sig('b|||review', 'b', [])]);
    const report = computeValidRate(revalidateSignals(cache, () => true));
    assert.equal(report.anchored, 0);
    assert.equal(report.validRate, 0);
    assert.equal(report.driftRate, 0);
    assert.ok(!Number.isNaN(report.validRate), 'validRate not NaN');
    assert.ok(!Number.isNaN(report.driftRate), 'driftRate not NaN');
  });

  // ─── HERMETIC LEAF: empty array anchorFiles == absent (unanchored) ──────────
  check('leaf: anchorFiles [] is treated as unanchored (same as absent)', () => {
    const v = revalidateSignals(cacheOf([sig('s|t|ts|review', 'c', [])]), () => true);
    assert.equal(v[0].state, 'unanchored');
    assert.deepEqual(v[0].present, []);
    assert.deepEqual(v[0].missing, []);
  });

  // ─── HERMETIC LEAF: empty / malformed cache => [] / zeroed report ────────────
  check('leaf: empty validity / malformed cache => total 0, never NaN', () => {
    const emptyReport = computeValidRate([]);
    assert.equal(emptyReport.total, 0);
    assert.equal(emptyReport.anchored, 0);
    assert.equal(emptyReport.validRate, 0);
    assert.equal(emptyReport.driftRate, 0);
    assert.ok(!Number.isNaN(emptyReport.validRate) && !Number.isNaN(emptyReport.driftRate));
    // malformed cache (no signals array) => []
    const v = revalidateSignals({} as FindingSignalsCache, () => true);
    assert.deepEqual(v, []);
  });

  // ─── HERMETIC LEAF: all valid (zero stale) => driftRate 0, validRate 1.0 ─────
  check('leaf: all-valid => validRate 1.0, driftRate 0', () => {
    const cache = cacheOf([sig('a|t|ts|review', 'a', ['a.ts']), sig('b|t|ts|review', 'b', ['b.ts'])]);
    const report = computeValidRate(revalidateSignals(cache, () => true));
    assert.equal(report.validRate, 1.0);
    assert.equal(report.driftRate, 0);
    assert.equal(report.staleSignals.length, 0);
  });

  // ─── HERMETIC LEAF: a throwing fileExists propagates (not swallowed) ─────────
  check('leaf: fileExists that throws => exception propagates (handler concern)', () => {
    const cache = cacheOf([sig('s|t|ts|review', 'c', ['boom.ts'])]);
    assert.throws(() => revalidateSignals(cache, () => { throw new Error('fs error'); }), /fs error/);
  });

  // ─── INTEGRATION: deriveFindingSignals populates anchorFiles (sorted union) ──
  check('integration: deriveFindingSignals -> anchorFiles sorted union -> revalidateSignals', () => {
    const findings: SignalSourceFinding[] = [
      { category: 'security', signatureTag: 'XSS', files: ['src/z.ts', 'src/a.ts'] },
      { category: 'security', signatureTag: 'XSS', files: ['src/a.ts', 'src/m.ts'] }, // dup a.ts merges
    ];
    const cache = deriveFindingSignals(findings, { now: PINNED_NOW });
    assert.equal(cache.signals.length, 1, 'same localSignature aggregates');
    const s = cache.signals[0];
    assert.deepEqual(s.anchorFiles, ['src/a.ts', 'src/m.ts', 'src/z.ts'], 'sorted, deduped union');

    // Feed into the leaf: only src/a.ts lives => valid, with m/z missing.
    const live = new Set<string>(['src/a.ts']);
    const v = revalidateSignals(cache, (p) => live.has(p));
    assert.equal(v[0].state, 'valid');
    assert.deepEqual(v[0].present, ['src/a.ts']);
    assert.deepEqual(v[0].missing, ['src/m.ts', 'src/z.ts']);
  });

  // ─── INTEGRATION: findings with no files => no anchorFiles field (clean) ─────
  check('integration: empty/missing files => anchorFiles omitted (unanchored)', () => {
    const cache = deriveFindingSignals([{ category: 'c', files: [] }, { category: 'c' }], { now: PINNED_NOW });
    for (const s of cache.signals) {
      assert.equal(s.anchorFiles, undefined, 'no anchorFiles field when no files');
    }
    const report = computeValidRate(revalidateSignals(cache, () => true));
    assert.equal(report.anchored, 0);
    assert.equal(report.validRate, 0);
  });

  // ─── INTEGRATION: malformed finding.files (non-strings) only keeps strings ───
  check('integration: non-string files filtered; cap dedups within MAX_ANCHOR_FILES', () => {
    const dirty = {
      category: 'c',
      files: ['ok.ts', 123, null, {}, 'ok.ts', '', 'two.ts'] as unknown as string[],
    } as SignalSourceFinding;
    const cache = deriveFindingSignals([dirty], { now: PINNED_NOW });
    const s = cache.signals[0];
    assert.deepEqual(s.anchorFiles, ['ok.ts', 'two.ts'], 'only non-empty strings, deduped, sorted');
  });

  // ─── INTEGRATION: trailing :line[:col] suffix stripped to bare repo path ────
  // Both `foo/bar.ts:42` and `foo/bar.ts:42:7` must reduce to the bare repo path
  // `foo/bar.ts` in anchorFiles (deriveFileKind / localSignature are intentionally
  // NOT touched, so these stay as two signals — we assert each one independently).
  check('integration: anchor :line[:col] suffix stripped => bare path => valid at HEAD', () => {
    for (const raw of ['foo/bar.ts:42', 'foo/bar.ts:42:7']) {
      const cache = deriveFindingSignals([{ category: 'c', signatureTag: 't', files: [raw] }], { now: PINNED_NOW });
      assert.equal(cache.signals.length, 1, `one signal for ${raw}`);
      const s = cache.signals[0];
      assert.deepEqual(s.anchorFiles, ['foo/bar.ts'], `suffix stripped to bare path for ${raw}`);

      // fileExists holds only the bare path => the de-suffixed anchor classifies valid.
      const live = new Set<string>(['foo/bar.ts']);
      const v = revalidateSignals(cache, (p) => live.has(p));
      assert.equal(v[0].state, 'valid', `bare path matches HEAD => valid for ${raw}`);
      assert.deepEqual(v[0].present, ['foo/bar.ts']);
      assert.deepEqual(v[0].missing, []);
    }
  });

  // ─── LEAF ADVERSARIAL: duplicate anchorFiles do not double-count / flip state ─
  // CHK-002:adversarial:3 — if anchorFiles somehow carries duplicates, the
  // present/missing partition and the rolled-up counts must stay consistent: a
  // signal is counted ONCE and its state is duplicate-invariant.
  check('leaf: duplicate anchorFiles => dup-invariant state + no count inflation', () => {
    // dup present path => still one signal, state valid, counted once.
    const live = new Set<string>(['dup.ts']);
    const validity = revalidateSignals(
      cacheOf([sig('s|dup|ts|review', 'dup', ['dup.ts', 'dup.ts', 'gone.ts'])]),
      (p) => live.has(p),
    );
    assert.equal(validity.length, 1);
    assert.equal(validity[0].state, 'valid', 'present dup => valid (>=1 present)');
    const report = computeValidRate(validity);
    assert.equal(report.anchored, 1, 'one signal, not inflated by the duplicate');
    assert.equal(report.valid, 1);
    assert.equal(report.stale, 0);
    assert.equal(report.validRate, 1);
    assert.equal(report.driftRate, 0);

    // all-gone duplicates => state stale, duplicates don't change it.
    const staleValidity = revalidateSignals(
      cacheOf([sig('s|allgone|ts|review', 'allgone', ['gone.ts', 'gone.ts'])]),
      () => false,
    );
    assert.equal(staleValidity[0].state, 'stale', 'all-gone dup => stale');
    const staleReport = computeValidRate(staleValidity);
    assert.equal(staleReport.anchored, 1);
    assert.equal(staleReport.stale, 1);
    assert.equal(staleReport.driftRate, 1);
  });

  console.log(`TOTAL ${total} | PASS ${passed} | FAIL ${total - passed}`);
  if (passed !== total) {
    process.exitCode = 1;
    return;
  }
  console.log('smoke passed');
}

run();
