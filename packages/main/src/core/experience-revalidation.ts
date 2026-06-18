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
