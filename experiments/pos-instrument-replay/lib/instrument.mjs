// Shared helpers for the proof-or-stop instrument replay & tamper harness (M0).
//
// The instrument (packages/**, exposed via the `lattice memory_playbook_baseline_*`
// CLI) is READ / CALLED ONLY here. Nothing in this file mutates the instrument.
//
// These helpers are deterministic: sha256 + canonicalJson give byte-stable
// digests, verifyDir shells the real verify CLI, refreshManifest replicates the
// instrument's manifest-refresh logic exactly (recompute recordsDigest +
// goldDigest from files on disk, apply overrides, rebuild manifestDigest over
// the canonical JSON of the domain object EXCLUDING manifestDigest itself), and
// fingerprintDomain extracts the exact observed domain the freeze pins.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** sha256 hex of a Buffer or string. */
export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Deterministic canonical JSON: object keys sorted, no incidental whitespace,
 * stable across runs. Matches the instrument's canonical-JSON digest input.
 */
export function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  return (
    '{' +
    Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k]))
      .join(',') +
    '}'
  );
}

/**
 * Shell the real verify CLI against a baseline directory and parse its JSON.
 * The instrument is invoked, never modified.
 *
 * If the verify CLI throws (nonzero exit) OR its output cannot be parsed as a
 * JSON object, we do NOT propagate the exception. Instead we return a crash
 * SENTINEL {status:'crash', crashed:true, error:<msg>}. A structural corruption
 * of manifest.json / gold-queries.json that makes the instrument throw is a
 * genuine detection outcome (the instrument refused to certify), not a harness
 * bug — so the harness must observe it as a first-class fail-closed signal
 * rather than aborting the whole run.
 */
export function verifyDir(dir) {
  let out;
  try {
    out = execFileSync(
      'lattice',
      ['memory_playbook_baseline_verify', `--inputDir=${dir}`, '--json'],
      { encoding: 'utf8', maxBuffer: 1 << 26 },
    );
  } catch (e) {
    return { status: 'crash', crashed: true, error: String(e.message || e).slice(0, 400) };
  }
  const jsonStart = out.indexOf('{');
  if (jsonStart < 0) {
    return {
      status: 'crash',
      crashed: true,
      error: 'verify produced no JSON object:\n' + out.slice(0, 400),
    };
  }
  try {
    return JSON.parse(out.slice(jsonStart));
  } catch (e) {
    return {
      status: 'crash',
      crashed: true,
      error: 'verify JSON parse failed: ' + String(e.message || e).slice(0, 200),
    };
  }
}

/**
 * Rebuild a self-consistent manifest from the current files on disk.
 * Recomputes recordsDigest + goldDigest from the actual bytes, applies the
 * supplied overrides onto the manifest domain, and rebuilds manifestDigest over
 * the canonical JSON of the domain object EXCLUDING manifestDigest itself.
 *
 * This mirrors refreshManifest in
 * packages/main/src/tasks/playbook-runtime-memory-baseline-smoke.ts.
 */
export function refreshManifest(dir, overrides = {}) {
  const mp = join(dir, 'manifest.json');
  const m = JSON.parse(readFileSync(mp, 'utf8'));
  const domain = {
    schemaVersion: m.schemaVersion,
    profile: m.profile,
    seed: m.seed,
    recordCount: m.recordCount,
    partitionCounts: m.partitionCounts,
    fullProfileExactMillion: m.fullProfileExactMillion,
    recordsDigest: sha256(readFileSync(join(dir, 'records.jsonl'))),
    goldDigest: sha256(readFileSync(join(dir, 'gold-queries.json'))),
    corruptRows: m.corruptRows,
    authority: m.authority,
    gateEvidence: m.gateEvidence,
    ...overrides,
  };
  domain.manifestDigest = sha256(canonicalJson(domain));
  writeFileSync(mp, JSON.stringify(domain, null, 2));
}

/**
 * Extract the observed fingerprint DOMAIN we freeze: {status, flags:{...},
 * metrics:{...}}. Exactly the domain the viability spike measured — the set of
 * boolean flags and numeric correctness metrics that distinguish a fail-closed
 * fingerprint from an accepted one.
 *
 * Accepts a crash sentinel (status:'crash') too. On a crash there is no
 * correctness payload, so flags/metrics come out all-undefined; the 'crash'
 * status is itself the failure signal (see failureSignals below), which is the
 * honest observation "the instrument refused to certify — it threw".
 */
export function fingerprintDomain(verifyResult) {
  const v = verifyResult;
  // On a crash there is no flag/metric payload. Return empty maps (NOT
  // undefined-filled ones): undefined values are not JSON-serializable and
  // would poison the canonical JSON. The 'crash' status is the failure signal.
  if (v.status === 'crash') {
    return { status: 'crash', flags: {}, metrics: {} };
  }
  const c = v.correctness || {};
  return {
    status: v.status,
    flags: {
      recordsDigestStable: v.recordsDigestStable,
      goldDigestStable: v.goldDigestStable,
      manifestDigestStable: v.manifestDigestStable,
      staleDetected: v.staleDetected,
      requestedProfileMatches: v.requestedProfileMatches,
      profileRecordCountMatches: v.profileRecordCountMatches,
      fullProfileExactMillionMatches: v.fullProfileExactMillionMatches,
      partitionContractPass: c.partitionContractPass,
      sourceDigestMutationMatrixPass: c.sourceDigestMutationMatrixPass,
    },
    metrics: {
      expectedIdsFoundRate: c.expectedIdsFoundRate,
      goldQueryPresenceRate: c.goldQueryPresenceRate,
      goldRecordPresenceRate: c.goldRecordPresenceRate,
      expectedSuppressedIdsFoundRate: c.expectedSuppressedIdsFoundRate,
      expectedDeprecatedTermHitsFoundRate: c.expectedDeprecatedTermHitsFoundRate,
      currentOverSupersededPreferenceRate: c.currentOverSupersededPreferenceRate,
      candidateFalseSurfaceRate: c.candidateFalseSurfaceRate,
      supersededFalseSurfaceRate: c.supersededFalseSurfaceRate,
      deprecatedFalseSurfaceRate: c.deprecatedFalseSurfaceRate,
      malformedRowsSkipped: c.malformedRowsSkipped,
    },
  };
}

// ---------------------------------------------------------------------------
// Failure-signal predicate (the two-pronged viability invariant).
//
// A fail-closed fingerprint must carry at least one FAILURE SIGNAL: either a
// required-true boolean flag observed false, OR a numeric metric off its clean
// gold value. A clean baseline has every listed flag true and every listed
// metric at its gold value, so any deviation is a genuine signal.
// ---------------------------------------------------------------------------

/** Clean-baseline gold values: flags all true; metrics at these exact values. */
export const CLEAN_FLAGS = [
  'recordsDigestStable',
  'goldDigestStable',
  'manifestDigestStable',
  'staleDetected', // note: staleDetected true means "stale WAS detected"; see below
  'requestedProfileMatches',
  'profileRecordCountMatches',
  'fullProfileExactMillionMatches',
  'partitionContractPass',
  'sourceDigestMutationMatrixPass',
];

// On a CLEAN baseline, staleDetected is FALSE (nothing stale). So the gold value
// for staleDetected is false, and a failure signal for it is staleDetected===true.
// All OTHER listed flags are TRUE on clean, and their failure signal is ===false.
export const CLEAN_FLAG_GOLD = {
  recordsDigestStable: true,
  goldDigestStable: true,
  manifestDigestStable: true,
  staleDetected: false,
  requestedProfileMatches: true,
  profileRecordCountMatches: true,
  fullProfileExactMillionMatches: true,
  partitionContractPass: true,
  sourceDigestMutationMatrixPass: true,
};

export const CLEAN_METRIC_GOLD = {
  expectedIdsFoundRate: 1,
  goldQueryPresenceRate: 1,
  goldRecordPresenceRate: 1,
  expectedSuppressedIdsFoundRate: 1,
  expectedDeprecatedTermHitsFoundRate: 1,
  currentOverSupersededPreferenceRate: 1,
  candidateFalseSurfaceRate: 0,
  supersededFalseSurfaceRate: 0,
  deprecatedFalseSurfaceRate: 0,
  malformedRowsSkipped: 1, // 1 corrupt row on small profile, skipped by design
};

/**
 * True iff the fingerprint carries at least one failure signal (a flag off its
 * clean gold OR a metric off its clean gold). Returns the list of signals for
 * diagnostics.
 */
export function failureSignals(fingerprint) {
  const signals = [];
  // A crash (the instrument threw / produced no parseable JSON) is itself a
  // first-class failure signal: the instrument refused to certify. No flags or
  // metrics are available in that case, so surface the status directly.
  if (fingerprint.status === 'crash') {
    signals.push({ kind: 'status', field: 'status', gold: 'pass', observed: 'crash' });
    return signals;
  }
  const flags = fingerprint.flags || {};
  const metrics = fingerprint.metrics || {};
  for (const [k, gold] of Object.entries(CLEAN_FLAG_GOLD)) {
    if (k in flags && flags[k] !== gold) {
      signals.push({ kind: 'flag', field: k, gold, observed: flags[k] });
    }
  }
  for (const [k, gold] of Object.entries(CLEAN_METRIC_GOLD)) {
    if (k in metrics && metrics[k] !== gold) {
      signals.push({ kind: 'metric', field: k, gold, observed: metrics[k] });
    }
  }
  return signals;
}

export function hasFailureSignal(fingerprint) {
  return failureSignals(fingerprint).length > 0;
}
