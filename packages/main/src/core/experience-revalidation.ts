/**
 * B-a2e3 CHK-002: Experience Layer — referential re-validation leaf.
 *
 * Conservative step ① after Baseline A (8% referential drift): given the derived
 * finding-signals cache and an injected `fileExists` predicate (the HEAD file
 * set), classify each signal by whether its recorded `anchorFiles` still exist,
 * and roll the classification up into a valid-rate / drift-rate report.
 *
 * This module is a LEAF: it imports ONLY the sibling leaf
 * `./experience-layer-types.js` (type-only). It does NO filesystem or git I/O of
 * its own — the `fileExists` predicate is injected by the handler, exactly so the
 * leaf stays deterministic, fs-free, and trivially testable. It returns plain
 * data and writes nothing.
 */

import type { FindingSignal, FindingSignalsCache } from './experience-layer-types.js';

/**
 * Classification of one signal's code anchors at the validation point:
 *   - `valid`      : at least one anchor file still exists.
 *   - `stale`      : the signal HAS anchor files, but every one of them is gone.
 *   - `unanchored` : the signal recorded no anchor files (nothing to re-validate).
 */
export type SignalState = 'valid' | 'stale' | 'unanchored';

/** Per-signal re-validation result. `present`/`missing` partition `anchorFiles`. */
export interface SignalValidity {
  localSignature: string;
  category: string;
  /** The anchor files re-validated (empty when the signal was unanchored). */
  anchorFiles: string[];
  /** Anchor files that still exist per the injected predicate. */
  present: string[];
  /** Anchor files that no longer exist per the injected predicate. */
  missing: string[];
  state: SignalState;
}

/**
 * Re-validate every signal in the cache against the injected `fileExists`
 * predicate. Defensive about a malformed cache (missing `signals` array => []).
 * `fileExists` is called once per anchor file; any exception it throws PROPAGATES
 * (the leaf never swallows caller I/O errors — that is the handler's job).
 */
export function revalidateSignals(
  cache: FindingSignalsCache,
  fileExists: (p: string) => boolean,
): SignalValidity[] {
  const signals: FindingSignal[] = Array.isArray(cache?.signals) ? cache.signals : [];
  const out: SignalValidity[] = [];
  for (const signal of signals) {
    const anchorFiles = Array.isArray(signal.anchorFiles) ? signal.anchorFiles : [];
    if (anchorFiles.length === 0) {
      out.push({
        localSignature: signal.localSignature,
        category: signal.category,
        anchorFiles: [],
        present: [],
        missing: [],
        state: 'unanchored',
      });
      continue;
    }
    const present: string[] = [];
    const missing: string[] = [];
    for (const file of anchorFiles) {
      if (fileExists(file)) present.push(file);
      else missing.push(file);
    }
    out.push({
      localSignature: signal.localSignature,
      category: signal.category,
      anchorFiles,
      present,
      missing,
      // >= 1 anchor live => valid; all anchors gone => stale.
      state: present.length >= 1 ? 'valid' : 'stale',
    });
  }
  return out;
}

/**
 * Aggregate valid-rate report. The rates use an ANCHORED-ONLY denominator
 * (`anchored = valid + stale`): unanchored signals carry no referential
 * information and MUST NOT dilute the rate. Both rates are 0 (never NaN) when
 * nothing is anchored.
 */
export interface ValidRateReport {
  total: number;
  anchored: number;
  valid: number;
  stale: number;
  unanchored: number;
  validRate: number;
  driftRate: number;
  staleSignals: SignalValidity[];
}

/**
 * B-1a91 CHK-003: coverage-gap report comparing a PERSISTED finding-signals cache's
 * coverage watermark against the CURRENT live counts (re-derived from the store).
 *
 * `gapFindings`/`gapStories` are how far BEHIND the persisted cache is — current
 * MINUS covered, floored at 0 (a cache that somehow covers more than the live store
 * never reports a negative gap). When the cache carries no watermark (a legacy cache
 * written before B-1a91, or a malformed/null cache), coverage is UNKNOWN (`known:
 * false`) and the covered counts default to 0 so nothing reads NaN.
 */
export interface CoverageGapReport {
  /** Findings the persisted cache summarized (its watermark); 0 when unknown. */
  coveredFindingCount: number;
  /** Findings the live store currently holds. */
  currentFindingCount: number;
  /** max(current - covered, 0): findings not yet folded into the cache. */
  gapFindings: number;
  /** Distinct stories the persisted cache summarized (its watermark); 0 when unknown. */
  coveredStoryCount: number;
  /** Distinct stories the live store currently holds findings for. */
  currentStoryCount: number;
  /** max(current - covered, 0): stories not yet folded into the cache. */
  gapStories: number;
  /** Persisted-cache coverage timestamp watermark, if recorded; else undefined. */
  coveredThrough?: string;
  /**
   * Whether the persisted cache carried a usable watermark. `false` => the cache
   * predates the watermark (or is absent/malformed); the gap is unknowable until a
   * full re-derive (learning_scan) re-stamps the watermark.
   */
  known: boolean;
}

/** Live current counts to compare a persisted watermark against (re-derived from the store). */
export interface CoverageCurrentCounts {
  currentFindingCount: number;
  currentStoryCount: number;
}

/** Coerce a watermark field to a non-negative integer; non-numbers => undefined. */
function nonNegInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value < 0 ? 0 : Math.floor(value);
}

/**
 * Compute the coverage gap between a persisted cache's watermark and the live store.
 * Defensive: a null/undefined/watermark-less cache => `known:false` with 0 covered
 * (gap then equals the full current counts). NEVER returns NaN.
 */
export function computeCoverageGap(
  cache: FindingSignalsCache | null | undefined,
  current: CoverageCurrentCounts,
): CoverageGapReport {
  const currentFindingCount = nonNegInt(current?.currentFindingCount) ?? 0;
  const currentStoryCount = nonNegInt(current?.currentStoryCount) ?? 0;

  const coveredFindingsRaw = nonNegInt(cache?.coveredFindingCount);
  const coveredStoriesRaw = nonNegInt(cache?.coveredStoryCount);
  // A watermark is "known" only when BOTH count fields are present + numeric.
  const known = coveredFindingsRaw !== undefined && coveredStoriesRaw !== undefined;

  const coveredFindingCount = coveredFindingsRaw ?? 0;
  const coveredStoryCount = coveredStoriesRaw ?? 0;

  const report: CoverageGapReport = {
    coveredFindingCount,
    currentFindingCount,
    gapFindings: Math.max(currentFindingCount - coveredFindingCount, 0),
    coveredStoryCount,
    currentStoryCount,
    gapStories: Math.max(currentStoryCount - coveredStoryCount, 0),
    known,
  };
  if (known && typeof cache?.coveredThrough === 'string') report.coveredThrough = cache.coveredThrough;
  return report;
}

/** Roll a `SignalValidity[]` up into a `ValidRateReport` (deterministic; never NaN). */
export function computeValidRate(validity: SignalValidity[]): ValidRateReport {
  const list = Array.isArray(validity) ? validity : [];
  let valid = 0;
  let stale = 0;
  let unanchored = 0;
  const staleSignals: SignalValidity[] = [];
  for (const v of list) {
    if (v.state === 'valid') valid += 1;
    else if (v.state === 'stale') {
      stale += 1;
      staleSignals.push(v);
    } else unanchored += 1;
  }
  const anchored = valid + stale;
  return {
    total: list.length,
    anchored,
    valid,
    stale,
    unanchored,
    // Anchored-only denominator; never NaN (0 when nothing is anchored).
    validRate: anchored > 0 ? valid / anchored : 0,
    driftRate: anchored > 0 ? stale / anchored : 0,
    staleSignals,
  };
}
