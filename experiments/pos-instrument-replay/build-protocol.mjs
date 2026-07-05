#!/usr/bin/env node
// Deterministic protocol producer (M0 CHK-002 / CHK-005).
//
// Reads viability-results.json + calibration.json + frozen constants and emits
// protocol.json (canonical JSON, byte-stable) plus protocol.json.sha256
// (sha256 of protocol.json). Running this twice MUST produce a byte-identical
// protocol.json and therefore a stable sha256.
//
// protocol.json is the frozen M0 contract consumed by M1-M4.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256, canonicalJson } from './lib/instrument.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VIABILITY_PATH = join(HERE, 'viability-results.json');
const CALIBRATION_PATH = join(HERE, 'calibration.json');
const PROTOCOL_PATH = join(HERE, 'protocol.json');
const PROTOCOL_SHA_PATH = join(HERE, 'protocol.json.sha256');

// ---------------------------------------------------------------------------
// Frozen constants.
// ---------------------------------------------------------------------------
const SCHEMA_VERSION = 1;
const SEED = 42;

const STOP_REASON_ENUM = [
  'budget_cap',
  'verify_crash',
  'precondition_failed',
  'operator_abort',
];

// iterationId rules (documented, not free-form): replay arms use
// <arm>/<scale>/<index> for index 1..N; tamper iterations use
// tamper/<scale>/<class>/<manifestHandling>.
const ITERATION_ID_RULE = {
  replay: '<arm>/<scale>/<index>  (index 1..N)',
  tamper: 'tamper/<scale>/<class>/<manifestHandling>',
};

// recordDigest preimage rule: sha256 of the canonical JSON of the record with
// the recordDigest field ABSENT.
const RECORD_DIGEST_PREIMAGE_RULE = {
  algorithm: 'sha256',
  preimage: 'canonicalJson(record) with the recordDigest field removed',
  note: 'canonicalJson = keys sorted, no incidental whitespace (see lib/instrument.mjs).',
};

// Gold values for the clean baseline (used to derive metric-predicate encodings
// and to state the failure-signal semantics without embedding raw floats).
const FLAG_GOLD = {
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
const METRIC_GOLD = {
  expectedIdsFoundRate: 1,
  goldQueryPresenceRate: 1,
  goldRecordPresenceRate: 1,
  expectedSuppressedIdsFoundRate: 1,
  expectedDeprecatedTermHitsFoundRate: 1,
  currentOverSupersededPreferenceRate: 1,
  candidateFalseSurfaceRate: 0,
  supersededFalseSurfaceRate: 0,
  deprecatedFalseSurfaceRate: 0,
  malformedRowsSkipped: 1,
};

// ---------------------------------------------------------------------------
// Failure-signal derivation.
//
// For a fail-closed fingerprint we emit an EXACT-comparison predicate list so
// the freeze does not embed raw floats: a flag off gold becomes
// {field, kind:'flag', op:'==', value:<observed-boolean>}; a metric off gold
// becomes an exact predicate {field, kind:'metric', op, value} where:
//   - a rate whose gold is 1 and observed < 1  -> {op:'<', value:1}
//   - a false-surface metric whose gold is 0 and observed > 0 -> {op:'>', value:0}
//   - an integer count (malformedRowsSkipped) off gold -> {op:'==', value:<observed-int>}
// These predicates are exact and float-drift-free.
// ---------------------------------------------------------------------------
function flagSignal(field, observed) {
  return { field, kind: 'flag', op: '==', value: observed };
}

function metricPredicate(field, observed) {
  const gold = METRIC_GOLD[field];
  if (field === 'malformedRowsSkipped') {
    // integer count: encode the exact observed value.
    return { field, kind: 'metric', op: '==', value: observed };
  }
  if (gold === 1 && observed < 1) {
    return { field, kind: 'metric', op: '<', value: 1 };
  }
  if (gold === 0 && observed > 0) {
    return { field, kind: 'metric', op: '>', value: 0 };
  }
  // Fallback (should not occur for the frozen set): exact off-gold flag.
  return { field, kind: 'metric', op: '!=', value: gold };
}

function deriveFailureSignals(fingerprint) {
  const signals = [];
  const flags = fingerprint.flags || {};
  const metrics = fingerprint.metrics || {};
  for (const [field, gold] of Object.entries(FLAG_GOLD)) {
    if (field in flags && flags[field] !== gold) {
      signals.push(flagSignal(field, flags[field]));
    }
  }
  for (const [field, gold] of Object.entries(METRIC_GOLD)) {
    if (field in metrics && metrics[field] !== gold) {
      signals.push(metricPredicate(field, metrics[field]));
    }
  }
  // Deterministic ordering by field for byte stability.
  signals.sort((a, b) => a.field.localeCompare(b.field));
  return signals;
}

// ---------------------------------------------------------------------------
// Build.
// ---------------------------------------------------------------------------
function main() {
  const viability = JSON.parse(readFileSync(VIABILITY_PATH, 'utf8'));
  const calibration = JSON.parse(readFileSync(CALIBRATION_PATH, 'utf8'));

  const cands = [...viability.candidates].sort((a, b) =>
    a.class === b.class ? a.handling.localeCompare(b.handling) : a.class.localeCompare(b.class),
  );

  const failClosed = [];
  const acceptanceBucket = [];
  const dropped = [];
  const smokeOverlapByClass = {};

  for (const c of cands) {
    // Record smokeOverlap per class (first occurrence; identical per class).
    if (!(c.class in smokeOverlapByClass)) {
      smokeOverlapByClass[c.class] = c.smokeOverlap ?? { covered: false };
    }
    if (c.disposition === 'fail-closed') {
      const failureSignals = deriveFailureSignals(c.fingerprint);
      if (failureSignals.length === 0) {
        throw new Error(
          `vacuous fail-closed class in viability results: ${c.class} [${c.handling}] — refusing to freeze`,
        );
      }
      failClosed.push({
        class: c.class,
        handling: c.handling,
        fingerprint: c.fingerprint,
        failureSignals,
      });
    } else if (c.disposition === 'accepted') {
      acceptanceBucket.push({
        class: c.class,
        handling: c.handling,
        fingerprint: c.fingerprint,
      });
    } else if (c.disposition === 'dropped') {
      dropped.push({ class: c.class, handling: c.handling });
    } else {
      throw new Error(`unknown disposition ${c.disposition} for ${c.class} [${c.handling}]`);
    }
  }

  // Ordered smokeOverlap map (class-sorted) for byte stability.
  const smokeOverlap = {};
  for (const cls of Object.keys(smokeOverlapByClass).sort()) {
    smokeOverlap[cls] = smokeOverlapByClass[cls];
  }

  const protocol = {
    schemaVersion: SCHEMA_VERSION,
    seed: { value: SEED, contentInert: true },
    N: {
      small: calibration.chosenN.small,
      full: calibration.chosenN.full,
    },
    tamperMatrix: {
      failClosed,
      acceptanceBucket,
      dropped,
    },
    iterationIdRule: ITERATION_ID_RULE,
    recordDigestPreimageRule: RECORD_DIGEST_PREIMAGE_RULE,
    metricGold: METRIC_GOLD,
    flagGold: FLAG_GOLD,
    budgetCaps: {
      msPerVerify: calibration.budgetCapMsPerVerify,
      safetyFactor: calibration.budgetSafetyFactor,
      fullVerifyElapsedMs: calibration.fullProfile.elapsedMs,
      fullVerifyPeakRssBytes: calibration.fullProfile.peakRssBytes,
      smallVerifyMsObserved: calibration.smallVerifyMsObserved,
    },
    stopReasonEnum: STOP_REASON_ENUM,
    envPins: {
      nodeVersion: calibration.env.nodeVersion,
      platform: calibration.env.platform,
      instrumentCommit: calibration.env.instrumentCommit,
    },
    smokeOverlap,
  };

  const serialized = canonicalJson(protocol) + '\n';
  writeFileSync(PROTOCOL_PATH, serialized);
  const hash = sha256(readFileSync(PROTOCOL_PATH));
  writeFileSync(PROTOCOL_SHA_PATH, hash + '\n');

  console.log(
    `protocol.json written: failClosed=${failClosed.length} accepted=${acceptanceBucket.length} dropped=${dropped.length}`,
  );
  console.log(`protocol.json sha256 = ${hash}`);
}

main();
