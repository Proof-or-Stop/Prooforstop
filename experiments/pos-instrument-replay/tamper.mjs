#!/usr/bin/env node
// M1 tamper-matrix conformance harness (B-bae9 CHK-001/CHK-002).
//
// Run by: node tamper.mjs   (exit 0 iff every frozen class conforms; mismatches=0)
//
// READS the frozen M0 protocol.json (default) or an alternate copy pointed to by
// $POS_PROTOCOL_PATH (used by selfcheck-m1.mjs's negative test). This harness
// NEVER mutates protocol.json / the instrument. It only READS the frozen
// artifacts and re-derives live fingerprints to prove they still conform.
//
// For every frozen tamperMatrix entry (failClosed + acceptanceBucket +
// acknowledgedLimitations + dropped), keyed by (class, handling):
//   1. copy the ONE clean small baseline (seed 42) to a fresh mkdtemp,
//   2. apply that class's DETERMINISTIC mutation (byte-for-byte the same logic
//      as viability-check.mjs — the mutation table below is a faithful replica),
//   3. run the real verify CLI (verifyDir) + compute fingerprintDomain,
//   4. compute a byteDiff of the mutated copy vs the clean baseline
//      ({recordsChanged, goldChanged, manifestChanged}), and RE-DERIVE the M0
//      disposition from (verifyStatus, class intent, byteDiff) exactly as
//      viability-check.mjs does,
//   5. compare the LIVE fingerprint to the entry's FROZEN fingerprint over the
//      frozen domain ONLY (flags: strict boolean equality; metrics: honor the
//      frozen predicate form — every op the format can express: '==', '<', '>',
//      '!=', with an epsilon-tolerant float compare so a legitimate repr does not
//      spuriously fail, and a loud THROW on any unrecognized op),
//   6. emit ONE canonical, volatile-field-free JSONL line to tamper-verdicts.jsonl.
//
// H2 conformance (CHK-002), extended for review findings F-001/F-002:
//   * every failClosed entry must verify fail|crash AND fingerprintMatch true;
//   * every acceptanceBucket + acknowledgedLimitations entry must verify pass AND
//     fingerprintMatch true;
//   * every dropped entry must verify pass;
//   * (F-001/F-002) the RE-DERIVED M0 disposition must MATCH the frozen bucket
//     for that class (dispositionMatch);
//   * (F-001) MUTATION-APPLIED: every NON-dropped class must show a real byteDiff
//     (records/gold/manifest changed) — a class whose mutation left records, gold
//     AND manifest ALL byte-identical to clean is a silent no-op / harness bug and
//     fails loudly (this closes the false-conformance hole where a no-op mutation
//     verifies pass on the clean corpus and "matches" the frozen pass fingerprint);
//   * (F-002) DROPPED-SEMANTICS: every dropped class must have records.jsonl AND
//     gold-queries.json byte-identical to clean (only manifest metadata may differ)
//     — dropped is defined by that content-inert property, not merely by pass.
// Any mismatch prints the offending class + expected-vs-actual and exits nonzero.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  sha256,
  verifyDir,
  refreshManifest,
  fingerprintDomain,
  canonicalJson,
} from './lib/instrument.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTOCOL_PATH = process.env.POS_PROTOCOL_PATH
  ? process.env.POS_PROTOCOL_PATH
  : join(HERE, 'protocol.json');
// The M0 viability results carry the authoritative per-(class,handling) intent
// ('benign' | 'malicious'), used to RE-DERIVE the M0 disposition (see
// deriveIntent below). It lives beside protocol.json in the experiment dir; the
// selfcheck sandbox copies it in so this harness resolves it the same way there.
const VIABILITY_PATH = join(HERE, 'viability-results.json');
const OUT_PATH = join(HERE, 'tamper-verdicts.jsonl');
const SCALE = 'small';

// ---------------------------------------------------------------------------
// Deterministic mutation table, keyed by "<class>|<handling>". This is a
// faithful byte-for-byte replica of the mutation logic in viability-check.mjs
// (fixed indices / fixed inputs, no randomness anywhere). The frozen fingerprint
// was produced by exactly these mutations, so replaying them reproduces it.
//
// 'refreshed' handling wraps the raw mutation with refreshManifest(dir, overrides)
// exactly as viability-check.mjs's addRefreshed helper does.
// ---------------------------------------------------------------------------
const recPath = (d) => join(d, 'records.jsonl');
const goldPath = (d) => join(d, 'gold-queries.json');
const manifestPath = (d) => join(d, 'manifest.json');
const readLines = (d) => readFileSync(recPath(d), 'utf8').split('\n');
const writeLines = (d, lines) => writeFileSync(recPath(d), lines.join('\n'));

// --- raw mutation primitives (identical to viability-check.mjs) ---
const mutByteFlip = (d) => {
  const b = readFileSync(recPath(d));
  b[100] = b[100] ^ 0x01;
  writeFileSync(recPath(d), b);
};
const mutDropRow = (d) => {
  const L = readLines(d);
  L.splice(5, 1);
  writeLines(d, L);
};
const mutDupRow = (d) => {
  const L = readLines(d);
  L.splice(5, 0, L[5]);
  writeLines(d, L);
};
const mutReorder = (d) => {
  const L = readLines(d);
  const i = 800;
  const j = 801;
  [L[i], L[j]] = [L[j], L[i]];
  writeLines(d, L);
};
const mutRename = (d) => {
  const L = readLines(d);
  for (let i = 0; i < L.length; i++) {
    if (!L[i].trim()) continue;
    try {
      const o = JSON.parse(L[i]);
      if (o && o.id && o.partition === 'general-irrelevant') {
        o.identifier = o.id;
        delete o.id;
        L[i] = JSON.stringify(o);
        break;
      }
    } catch {
      /* skip unparseable */
    }
  }
  writeLines(d, L);
};
const mutTrunc = (d) => {
  const L = readLines(d);
  writeLines(d, L.slice(0, 11));
};
const mutGoldEdit = (d) => {
  const g = JSON.parse(readFileSync(goldPath(d), 'utf8'));
  g.tampered = true;
  writeFileSync(goldPath(d), JSON.stringify(g, null, 2));
};
const mutManifestRecordCount = (d) => {
  const m = JSON.parse(readFileSync(manifestPath(d), 'utf8'));
  m.recordCount = 999;
  writeFileSync(manifestPath(d), JSON.stringify(m, null, 2));
};
const mutManifestProfile = (d) => {
  const m = JSON.parse(readFileSync(manifestPath(d), 'utf8'));
  m.profile = 'full';
  writeFileSync(manifestPath(d), JSON.stringify(m, null, 2));
};
const mutManifestDigest = (d) => {
  const m = JSON.parse(readFileSync(manifestPath(d), 'utf8'));
  m.recordsDigest = '0'.repeat(64);
  writeFileSync(manifestPath(d), JSON.stringify(m, null, 2));
};
const mutSeedSwapRaw = (d) => {
  const m = JSON.parse(readFileSync(manifestPath(d), 'utf8'));
  m.seed = 99;
  writeFileSync(manifestPath(d), JSON.stringify(m, null, 2));
};
const mutGoldWeakenExpectedIds = (d) => {
  const g = JSON.parse(readFileSync(goldPath(d), 'utf8'));
  for (const q of g.queries) {
    if (Array.isArray(q.expectedIds) && q.expectedIds.length > 1) {
      q.expectedIds = q.expectedIds.slice(0, q.expectedIds.length - 1);
      break;
    }
  }
  writeFileSync(goldPath(d), JSON.stringify(g, null, 2));
};
const mutGoldWeakenSuppressed = (d) => {
  const g = JSON.parse(readFileSync(goldPath(d), 'utf8'));
  for (const q of g.queries) {
    if (Array.isArray(q.expectedSuppressedIds) && q.expectedSuppressedIds.length >= 1) {
      q.expectedSuppressedIds = q.expectedSuppressedIds.slice(
        0,
        q.expectedSuppressedIds.length - 1,
      );
      break;
    }
  }
  writeFileSync(goldPath(d), JSON.stringify(g, null, 2));
};
const mutGoldWeakenMustNotSurface = (d) => {
  const g = JSON.parse(readFileSync(goldPath(d), 'utf8'));
  for (const q of g.queries) {
    if (Array.isArray(q.mustNotSurfaceIds) && q.mustNotSurfaceIds.length >= 1) {
      q.mustNotSurfaceIds = q.mustNotSurfaceIds.slice(0, q.mustNotSurfaceIds.length - 1);
      break;
    }
  }
  writeFileSync(goldPath(d), JSON.stringify(g, null, 2));
};
const mutDuplicateGoldId = (d) => {
  const L = readLines(d);
  let goldId = null;
  for (const ln of L) {
    if (!ln.trim()) continue;
    try {
      const o = JSON.parse(ln);
      if (o.id && /^mem-|^pb-/.test(o.id)) {
        goldId = o.id;
        break;
      }
    } catch {
      /* skip unparseable */
    }
  }
  for (let i = L.length - 1; i >= 0; i--) {
    if (!L[i].trim()) continue;
    try {
      const o = JSON.parse(L[i]);
      if (o.partition === 'general-irrelevant') {
        o.id = goldId;
        L[i] = JSON.stringify(o);
        break;
      }
    } catch {
      /* skip unparseable */
    }
  }
  writeLines(d, L);
};
const mutManifestStructuralCorruption = (d) => {
  writeFileSync(manifestPath(d), '{ "profile": "small"');
};
const mutGoldStructuralCorruption = (d) => {
  writeFileSync(goldPath(d), '{ invalid');
};
const noop = (_d) => {};

// Wrap a raw mutation with a manifest refresh (mirrors addRefreshed).
const refreshed = (mutate, overrides = {}) => (d) => {
  mutate(d);
  refreshManifest(d, overrides);
};

// The mutation table. Key = "<class>|<handling>". Every (class, handling) that
// appears in the frozen tamperMatrix (across all four buckets) must be present.
const MUTATIONS = {
  'records-byte-flip|raw': mutByteFlip,
  'records-row-drop|raw': mutDropRow,
  'records-row-drop|refreshed': refreshed(mutDropRow, { recordCount: 999 }),
  'records-row-duplicate|raw': mutDupRow,
  'records-row-duplicate|refreshed': refreshed(mutDupRow, { recordCount: 1001 }),
  'records-row-reorder|raw': mutReorder,
  'records-row-reorder|refreshed': refreshed(mutReorder),
  'records-field-rename|raw': mutRename,
  'records-field-rename|refreshed': refreshed(mutRename),
  'records-truncation|raw': mutTrunc,
  'records-truncation|refreshed': refreshed(mutTrunc, { recordCount: 11, corruptRows: 0 }),
  'gold-edit|raw': mutGoldEdit,
  'gold-additive-field|refreshed': refreshed(mutGoldEdit),
  'manifest-recordCount-edit|raw': mutManifestRecordCount,
  'manifest-profile-edit|raw': mutManifestProfile,
  'manifest-digest-edit|raw': mutManifestDigest,
  'cross-profile-swap|refreshed': refreshed(noop, {
    profile: 'full',
    recordCount: 1_000_000,
    fullProfileExactMillion: true,
  }),
  'seed-swap|raw': mutSeedSwapRaw,
  'seed-swap|refreshed': refreshed(noop, { seed: 99 }),
  'gold-weaken-expectedids|refreshed': refreshed(mutGoldWeakenExpectedIds),
  'corruptRows-lie|refreshed': refreshed(noop, { corruptRows: 0 }),
  'duplicate-gold-id|refreshed': refreshed(mutDuplicateGoldId),
  'manifest-structural-corruption|raw': mutManifestStructuralCorruption,
  'gold-structural-corruption|raw': mutGoldStructuralCorruption,
  'gold-weaken-suppressed|refreshed': refreshed(mutGoldWeakenSuppressed),
  'gold-weaken-mustnotsurface|refreshed': refreshed(mutGoldWeakenMustNotSurface),
  'manifest-metadata-lie|refreshed': refreshed(noop, { gateEvidence: true }),
};

// ---------------------------------------------------------------------------
// Fingerprint comparison over the FROZEN domain only.
// ---------------------------------------------------------------------------
const EPS = 1e-9;

/**
 * Compare a LIVE fingerprint to a FROZEN fingerprint over the frozen domain
 * ONLY. Returns { match:boolean, diffs:[...] }.
 *
 *   status  : strict equality.
 *   flags   : for every flag KEY present in the frozen fingerprint, the live
 *             flag must be strictly boolean-equal.
 *   metrics : for every metric KEY present in the frozen fingerprint, the live
 *             metric must match the frozen VALUE. We honor the frozen predicate
 *             FORM (recovered from the entry's failureSignals) rather than raw
 *             float equality. build-protocol.mjs can encode ANY of these ops for
 *             a numeric metric predicate, and this function handles EVERY op the
 *             format can express:
 *               - op '==' (default / no predicate): epsilon-tolerant numeric
 *                 equality to the frozen value (e.g. gold values 0/1/2 or an
 *                 exact integer off-gold count like malformedRowsSkipped).
 *               - op '<' (a rate whose gold is 1 and observed < 1): the live
 *                 value must ALSO be strictly below the threshold AND reproduce
 *                 the frozen value within epsilon. (The threshold guard proves we
 *                 do not spuriously treat a >=threshold pass-gold as a match; the
 *                 epsilon guards a legitimate float repr.)
 *               - op '>' (a false-surface metric whose gold is 0 and observed
 *                 > 0): symmetric to '<' — the live value must be strictly ABOVE
 *                 the threshold AND reproduce the frozen value within epsilon.
 *               - op '!=' (an off-gold value encoded as not-equal to gold): the
 *                 live value must be numerically NOT-equal (outside epsilon) to
 *                 the predicate value AND reproduce the frozen value within
 *                 epsilon.
 *             For ANY op the format does not recognize, we THROW (fail loudly)
 *             rather than silently epsilon-comparing, so a future predicate op is
 *             never treated as a no-op equality.
 *
 * frozenEntry carries the optional failureSignals array used to recover the
 * predicate form for numeric metrics.
 */
function compareFingerprint(live, frozen, frozenEntry) {
  const diffs = [];

  if (live.status !== frozen.status) {
    diffs.push(`status: expected=${frozen.status} actual=${live.status}`);
  }

  const fFlags = frozen.flags || {};
  const lFlags = live.flags || {};
  for (const k of Object.keys(fFlags)) {
    if (lFlags[k] !== fFlags[k]) {
      diffs.push(`flags.${k}: expected=${fFlags[k]} actual=${lFlags[k]}`);
    }
  }

  // Predicate-form lookup: field -> { op, value } from the frozen failureSignals
  // (only 'metric' kind matters for numeric predicate form).
  const metricPredicates = {};
  for (const sig of frozenEntry.failureSignals || []) {
    if (sig.kind === 'metric') {
      metricPredicates[sig.field] = { op: sig.op, value: sig.value };
    }
  }

  const fMetrics = frozen.metrics || {};
  const lMetrics = live.metrics || {};
  for (const k of Object.keys(fMetrics)) {
    const fv = fMetrics[k];
    const lv = lMetrics[k];
    if (typeof lv !== 'number' || typeof fv !== 'number') {
      // Non-numeric (should not happen for metrics), fall back to strict equality.
      if (lv !== fv) diffs.push(`metrics.${k}: expected=${fv} actual=${lv}`);
      continue;
    }
    // Default op is '==' when this metric carries no failureSignal predicate
    // (i.e. it is a pass-gold value in the frozen domain, not an off-gold one).
    const pred = metricPredicates[k];
    const op = pred ? pred.op : '==';
    switch (op) {
      case '==': {
        // Exact == form (gold 0/1/2, or an exact integer off-gold count):
        // epsilon-tolerant numeric equality to the frozen value.
        if (Math.abs(lv - fv) > EPS) {
          diffs.push(`metrics.${k}: expected=${fv} actual=${lv}`);
        }
        break;
      }
      case '<': {
        // Threshold form: the frozen value is strictly < threshold. The live
        // value must (a) also be strictly < threshold (do NOT accept a
        // >=threshold pass-gold as a match) AND (b) reproduce the frozen value
        // within epsilon.
        if (!(lv < pred.value)) {
          diffs.push(
            `metrics.${k}: frozen predicate '<${pred.value}' but actual=${lv} is NOT below threshold`,
          );
        } else if (Math.abs(lv - fv) > EPS) {
          diffs.push(`metrics.${k}: expected~=${fv} actual=${lv} (below threshold but differs)`);
        }
        break;
      }
      case '>': {
        // Symmetric threshold form: the frozen value is strictly > threshold
        // (a false-surface rate that fired). The live value must (a) also be
        // strictly > threshold AND (b) reproduce the frozen value within epsilon.
        if (!(lv > pred.value)) {
          diffs.push(
            `metrics.${k}: frozen predicate '>${pred.value}' but actual=${lv} is NOT above threshold`,
          );
        } else if (Math.abs(lv - fv) > EPS) {
          diffs.push(`metrics.${k}: expected~=${fv} actual=${lv} (above threshold but differs)`);
        }
        break;
      }
      case '!=': {
        // Not-equal form: the frozen value is an off-gold value encoded as
        // "not equal to gold". The live value must (a) be numerically NOT-equal
        // (outside epsilon) to the predicate (gold) value AND (b) reproduce the
        // frozen value within epsilon.
        if (Math.abs(lv - pred.value) <= EPS) {
          diffs.push(
            `metrics.${k}: frozen predicate '!=${pred.value}' but actual=${lv} EQUALS the predicate value`,
          );
        } else if (Math.abs(lv - fv) > EPS) {
          diffs.push(`metrics.${k}: expected~=${fv} actual=${lv} (not-equal predicate but differs)`);
        }
        break;
      }
      default:
        // A predicate op the fingerprint format is not known to express. Fail
        // loudly rather than silently epsilon-comparing (which could mask a
        // future op that the frozen predicate intends to be non-trivial).
        throw new Error(
          `compareFingerprint: unrecognized metric predicate op '${op}' for field '${k}' ` +
            `(entry ${frozenEntry.class} [${frozenEntry.handling}]); refusing to silently epsilon-compare`,
        );
    }
  }

  return { match: diffs.length === 0, diffs };
}

// ---------------------------------------------------------------------------
// Intent derivation (for the M0 disposition re-derivation, findings F-001/F-002).
//
// The M0 disposition rule (viability-check.mjs) branches on the class INTENT
// ('benign' | 'malicious'). We recover intent ROBUSTLY, in priority order:
//   (1) viability-results.json — the authoritative M0 source, which records an
//       explicit {class, handling, intent, disposition} per candidate. Keyed by
//       "<class>|<handling>" (proven unique across the 27 candidates), this is
//       the direct, non-inferred intent.
//   (2) Fallback derivation from the frozen protocol bucket, which by
//       construction pins intent for two buckets:
//         - acknowledgedLimitations: every entry is intent 'malicious' (a real
//           tamper the instrument did not detect — build-protocol.mjs REFUSES to
//           freeze a non-malicious acknowledged-limitation).
//         - acceptanceBucket: a benign content change the instrument accepted.
//       (failClosed / dropped never reach the intent branch of the re-derivation
//       — fail|crash short-circuits to 'fail-closed', and 'dropped' is decided by
//       the byte-identity test — so the fallback only needs the pass buckets.)
// If neither source yields an intent, we throw (a class we cannot classify is a
// harness gap, not a silent pass).
// ---------------------------------------------------------------------------
function loadIntentMap() {
  const map = {};
  try {
    const viability = JSON.parse(readFileSync(VIABILITY_PATH, 'utf8'));
    for (const c of viability.candidates || []) {
      if (c.class && c.handling && c.intent) {
        map[`${c.class}|${c.handling}`] = c.intent;
      }
    }
  } catch {
    // viability-results.json absent/unreadable — rely on the bucket fallback.
  }
  return map;
}

function deriveIntent(entry, intentMap) {
  const fromViability = intentMap[`${entry.class}|${entry.handling}`];
  if (fromViability === 'benign' || fromViability === 'malicious') {
    return { intent: fromViability, source: 'viability-results.json' };
  }
  // Fallback: infer from the frozen bucket for the pass buckets.
  if (entry.bucket === 'acknowledgedLimitations') {
    return { intent: 'malicious', source: 'protocol-bucket:acknowledgedLimitations' };
  }
  if (entry.bucket === 'acceptanceBucket') {
    return { intent: 'benign', source: 'protocol-bucket:acceptanceBucket' };
  }
  // failClosed / dropped do not need intent (the re-derivation short-circuits
  // before the intent branch), so a missing intent there is harmless. But a
  // pass-bucket entry with no recoverable intent is a real gap.
  return { intent: null, source: 'unresolved' };
}

// byteDiff of the mutated copy vs the clean baseline over the three artifacts.
// Uses sha256 of the on-disk bytes so it is exact and cheap.
function computeByteDiff(dir, cleanDigests) {
  const recordsChanged = sha256(readFileSync(recPath(dir))) !== cleanDigests.records;
  const goldChanged = sha256(readFileSync(goldPath(dir))) !== cleanDigests.gold;
  const manifestChanged = sha256(readFileSync(manifestPath(dir))) !== cleanDigests.manifest;
  return { recordsChanged, goldChanged, manifestChanged };
}

// Re-derive the M0 disposition EXACTLY as viability-check.mjs's disposition()
// does, from (verifyStatus, class intent, byteDiff-vs-clean). Note: M0's benign
// false-positive branch (benign + fail) cannot arise here because every frozen
// pass-bucket/dropped entry verified pass and every failClosed entry is a real
// tamper; we still return 'fail-closed' for any fail|crash for fidelity.
function rederiveDisposition(verifyStatus, intent, byteDiff) {
  // (1) A verify 'fail' OR a 'crash' is a genuine rejection.
  if (verifyStatus === 'fail' || verifyStatus === 'crash') return 'fail-closed';
  // status === 'pass' from here on.
  // (2) A malicious tamper that verify accepted is a documented blind spot.
  if (intent === 'malicious') return 'acknowledged-limitation';
  // (3) Content-inert no-op: records.jsonl AND gold-queries.json byte-identical
  //     to clean (only manifest metadata may differ).
  if (!byteDiff.recordsChanged && !byteDiff.goldChanged) return 'dropped';
  // (4) A benign content change the instrument correctly accepts.
  return 'accepted';
}

// Frozen bucket name -> the M0 disposition it represents.
const BUCKET_TO_DISPOSITION = {
  failClosed: 'fail-closed',
  acceptanceBucket: 'accepted',
  acknowledgedLimitations: 'acknowledged-limitation',
  dropped: 'dropped',
};

// ---------------------------------------------------------------------------
// Clean baseline generation (one shared clean baseline, seed 42, small).
// ---------------------------------------------------------------------------
function generateCleanBaseline() {
  const root = mkdtempSync(join(tmpdir(), 'pos-tamper-clean-'));
  const dir = join(root, 'base');
  execFileSync(
    'lattice',
    [
      'memory_playbook_baseline_generate',
      '--profile=small',
      `--outputDir=${dir}`,
      '--seed=42',
      '--json',
    ],
    { encoding: 'utf8', maxBuffer: 1 << 26 },
  );
  return { root, dir };
}

// iterationIdRule.tamper = "tamper/<scale>/<class>/<manifestHandling>"
function iterationId(scale, className, handling) {
  return `tamper/${scale}/${className}/${handling}`;
}

// Full boolean flag vector, in the frozen clean domain order (stable keys).
const FLAG_ORDER = [
  'recordsDigestStable',
  'goldDigestStable',
  'manifestDigestStable',
  'staleDetected',
  'requestedProfileMatches',
  'profileRecordCountMatches',
  'fullProfileExactMillionMatches',
  'partitionContractPass',
  'sourceDigestMutationMatrixPass',
];
function fullFlagVector(fp) {
  const flags = fp.flags || {};
  const out = {};
  for (const k of FLAG_ORDER) out[k] = flags[k] === undefined ? null : flags[k];
  return out;
}

const METRIC_ORDER = [
  'expectedIdsFoundRate',
  'goldQueryPresenceRate',
  'goldRecordPresenceRate',
  'expectedSuppressedIdsFoundRate',
  'expectedDeprecatedTermHitsFoundRate',
  'currentOverSupersededPreferenceRate',
  'candidateFalseSurfaceRate',
  'supersededFalseSurfaceRate',
  'deprecatedFalseSurfaceRate',
  'malformedRowsSkipped',
];
function goldMetricVector(fp) {
  const metrics = fp.metrics || {};
  const out = {};
  for (const k of METRIC_ORDER) out[k] = metrics[k] === undefined ? null : metrics[k];
  return out;
}

function main() {
  const protocol = JSON.parse(readFileSync(PROTOCOL_PATH, 'utf8'));
  const tm = protocol.tamperMatrix || {};
  const scale = SCALE;

  // Flatten every frozen entry across the four buckets, tagging its bucket.
  const entries = [];
  for (const e of tm.failClosed || []) entries.push({ ...e, bucket: 'failClosed' });
  for (const e of tm.acceptanceBucket || []) entries.push({ ...e, bucket: 'acceptanceBucket' });
  for (const e of tm.acknowledgedLimitations || [])
    entries.push({ ...e, bucket: 'acknowledgedLimitations' });
  for (const e of tm.dropped || []) entries.push({ ...e, bucket: 'dropped' });

  // Deterministic ordering: bucket order above, then class, then handling.
  const bucketRank = {
    failClosed: 0,
    acceptanceBucket: 1,
    acknowledgedLimitations: 2,
    dropped: 3,
  };
  entries.sort((a, b) => {
    if (bucketRank[a.bucket] !== bucketRank[b.bucket]) {
      return bucketRank[a.bucket] - bucketRank[b.bucket];
    }
    if (a.class !== b.class) return a.class.localeCompare(b.class);
    return a.handling.localeCompare(b.handling);
  });

  const intentMap = loadIntentMap();

  const clean = generateCleanBaseline();
  const cleanRecBefore = sha256(readFileSync(recPath(clean.dir)));
  const cleanGoldBefore = sha256(readFileSync(goldPath(clean.dir)));
  // Clean-baseline digests for the per-class byteDiff (records/gold/manifest).
  const cleanDigests = {
    records: cleanRecBefore,
    gold: cleanGoldBefore,
    manifest: sha256(readFileSync(manifestPath(clean.dir))),
  };

  const cleanFp = fingerprintDomain(verifyDir(clean.dir));
  if (cleanFp.status !== 'pass') {
    rmSync(clean.root, { recursive: true, force: true });
    console.error('FATAL: clean baseline did not verify pass:', JSON.stringify(cleanFp));
    process.exit(1);
  }

  const verdicts = [];
  const mismatches = [];

  try {
    for (const entry of entries) {
      const key = `${entry.class}|${entry.handling}`;
      const mutate = MUTATIONS[key];
      if (!mutate) {
        mismatches.push({
          class: entry.class,
          handling: entry.handling,
          bucket: entry.bucket,
          reason: `no mutation defined for (${key}) — frozen matrix has an entry the harness cannot replay`,
        });
        continue;
      }

      const root = mkdtempSync(join(tmpdir(), 'pos-tamper-'));
      const dir = join(root, 'base');
      cpSync(clean.dir, dir, { recursive: true });

      let fp;
      let byteDiff;
      try {
        mutate(dir);
        // byteDiff BEFORE verify (verify does not mutate, but compute it while
        // the mutated copy still exists on disk).
        byteDiff = computeByteDiff(dir, cleanDigests);
        fp = fingerprintDomain(verifyDir(dir));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }

      const verifyStatus = fp.status;
      const verifyFlags = fullFlagVector(fp);
      const goldMetrics = goldMetricVector(fp);

      // Re-derive the M0 disposition from (verifyStatus, intent, byteDiff) and
      // compare it to the frozen bucket for this class (findings F-001/F-002).
      const { intent, source: intentSource } = deriveIntent(entry, intentMap);
      const rederivedDisposition = rederiveDisposition(verifyStatus, intent, byteDiff);
      const expectedDisposition = BUCKET_TO_DISPOSITION[entry.bucket];
      const dispositionMatch = rederivedDisposition === expectedDisposition;

      // fingerprintMatch: dropped entries have no frozen fingerprint to match, so
      // fingerprintMatch is not applicable (recorded as null). For every other
      // bucket, compare live vs frozen over the frozen domain only.
      let fingerprintMatch = null;
      let cmpDiffs = [];
      if (entry.bucket !== 'dropped') {
        const cmp = compareFingerprint(fp, entry.fingerprint, entry);
        fingerprintMatch = cmp.match;
        cmpDiffs = cmp.diffs;
      }

      // Record the verdict (volatile-field-free by construction: no elapsedMs /
      // rss / absolute paths ever enter this object). `disposition` is now the
      // RE-DERIVED M0 disposition (findings F-001/F-002); byteDiff +
      // rederivedDisposition + dispositionMatch are recorded for auditability.
      verdicts.push({
        iterationId: iterationId(scale, entry.class, entry.handling),
        class: entry.class,
        handling: entry.handling,
        bucket: entry.bucket,
        intent,
        intentSource,
        verifyStatus,
        verifyFlags,
        goldMetrics,
        byteDiff,
        fingerprintMatch,
        disposition: rederivedDisposition,
        rederivedDisposition,
        expectedDisposition,
        dispositionMatch,
      });

      // (F-001/F-002) DISPOSITION-MATCH: the re-derived M0 disposition must equal
      // the frozen bucket's disposition for this class.
      if (!dispositionMatch) {
        mismatches.push({
          class: entry.class,
          handling: entry.handling,
          bucket: entry.bucket,
          reason:
            `re-derived disposition '${rederivedDisposition}' != frozen bucket disposition ` +
            `'${expectedDisposition}' (verifyStatus=${verifyStatus} intent=${intent}` +
            ` [${intentSource}] byteDiff=${JSON.stringify(byteDiff)})`,
        });
      }

      // (F-001) MUTATION-APPLIED: every NON-dropped class must show a real
      // byteDiff. A class whose mutation left records, gold AND manifest ALL
      // byte-identical to clean is a silent no-op / harness bug: the mutation was
      // never applied, so verify passes on the CLEAN corpus and the clean
      // fingerprint spuriously "matches" a frozen pass fingerprint. Fail loudly.
      if (entry.bucket !== 'dropped') {
        const anyChanged =
          byteDiff.recordsChanged || byteDiff.goldChanged || byteDiff.manifestChanged;
        if (!anyChanged) {
          mismatches.push({
            class: entry.class,
            handling: entry.handling,
            bucket: entry.bucket,
            reason:
              'MUTATION NOT APPLIED: records, gold AND manifest are ALL byte-identical to clean ' +
              '(silent no-op mutation / harness bug — conformance would be against the clean corpus)',
          });
        }
      }

      // (F-002) DROPPED-SEMANTICS: every dropped class must have records.jsonl
      // AND gold-queries.json byte-identical to clean (only manifest metadata may
      // differ). This is the DEFINING property of 'dropped', not merely pass.
      if (entry.bucket === 'dropped') {
        if (byteDiff.recordsChanged || byteDiff.goldChanged) {
          mismatches.push({
            class: entry.class,
            handling: entry.handling,
            bucket: entry.bucket,
            reason:
              `dropped entry must have records+gold byte-identical to clean, but byteDiff=` +
              `${JSON.stringify(byteDiff)} (records/gold changed — not content-inert)`,
          });
        }
      }

      // H2 conformance assertion per bucket (CHK-002).
      if (entry.bucket === 'failClosed') {
        if (!(verifyStatus === 'fail' || verifyStatus === 'crash')) {
          mismatches.push({
            class: entry.class,
            handling: entry.handling,
            bucket: entry.bucket,
            reason: `expected verifyStatus fail|crash, actual=${verifyStatus}`,
          });
        }
        if (fingerprintMatch !== true) {
          mismatches.push({
            class: entry.class,
            handling: entry.handling,
            bucket: entry.bucket,
            reason: `fingerprintMatch false: ${cmpDiffs.join('; ')}`,
          });
        }
      } else if (entry.bucket === 'acceptanceBucket' || entry.bucket === 'acknowledgedLimitations') {
        if (verifyStatus !== 'pass') {
          mismatches.push({
            class: entry.class,
            handling: entry.handling,
            bucket: entry.bucket,
            reason: `expected verifyStatus pass, actual=${verifyStatus}`,
          });
        }
        if (fingerprintMatch !== true) {
          mismatches.push({
            class: entry.class,
            handling: entry.handling,
            bucket: entry.bucket,
            reason: `fingerprintMatch false: ${cmpDiffs.join('; ')}`,
          });
        }
      } else if (entry.bucket === 'dropped') {
        if (verifyStatus !== 'pass') {
          mismatches.push({
            class: entry.class,
            handling: entry.handling,
            bucket: entry.bucket,
            reason: `dropped entry expected verifyStatus pass, actual=${verifyStatus}`,
          });
        }
      }
    }
  } finally {
    // Prove the source clean baseline was NOT polluted, then clean up.
    const recAfter = sha256(readFileSync(recPath(clean.dir)));
    const goldAfter = sha256(readFileSync(goldPath(clean.dir)));
    const polluted = recAfter !== cleanRecBefore || goldAfter !== cleanGoldBefore;
    rmSync(clean.root, { recursive: true, force: true });
    if (polluted) {
      console.error('FATAL: source clean baseline was mutated during the run (tree pollution).');
      process.exit(1);
    }
  }

  // Deterministic JSONL: one canonical line per verdict, sorted keys, trailing \n.
  const jsonl = verdicts.map((v) => canonicalJson(v)).join('\n') + '\n';
  writeFileSync(OUT_PATH, jsonl);

  // Per-class table.
  console.log('=== TAMPER CONFORMANCE TABLE ===');
  for (const v of verdicts) {
    const fpm =
      v.fingerprintMatch === null ? 'n/a  ' : v.fingerprintMatch ? 'MATCH' : 'DIFF ';
    const bd = `r${v.byteDiff.recordsChanged ? 1 : 0}g${v.byteDiff.goldChanged ? 1 : 0}m${
      v.byteDiff.manifestChanged ? 1 : 0
    }`;
    const dm = v.dispositionMatch ? 'OK  ' : 'DIFF';
    console.log(
      `  ${v.bucket.padEnd(24)} ${v.class.padEnd(30)} [${v.handling.padEnd(9)}] ` +
        `status=${String(v.verifyStatus).padEnd(5)} fp=${fpm} bd=${bd} ` +
        `disp=${v.disposition.padEnd(24)} dispMatch=${dm}`,
    );
  }

  // Summary of the new invariants (findings F-001/F-002).
  const dispMismatches = verdicts.filter((v) => !v.dispositionMatch);
  const noopMutations = verdicts.filter(
    (v) =>
      v.bucket !== 'dropped' &&
      !v.byteDiff.recordsChanged &&
      !v.byteDiff.goldChanged &&
      !v.byteDiff.manifestChanged,
  );
  const badDropped = verdicts.filter(
    (v) => v.bucket === 'dropped' && (v.byteDiff.recordsChanged || v.byteDiff.goldChanged),
  );
  console.log(
    `\ninvariants: dispositionMatch failures=${dispMismatches.length} ` +
      `no-op mutations (non-dropped, all-identical)=${noopMutations.length} ` +
      `dropped-semantics violations=${badDropped.length}`,
  );

  // Per-bucket counts.
  const byBucket = {};
  for (const v of verdicts) byBucket[v.bucket] = (byBucket[v.bucket] || 0) + 1;
  console.log(
    `\nverdicts: total=${verdicts.length} ` +
      `failClosed=${byBucket.failClosed || 0} ` +
      `acceptanceBucket=${byBucket.acceptanceBucket || 0} ` +
      `acknowledgedLimitations=${byBucket.acknowledgedLimitations || 0} ` +
      `dropped=${byBucket.dropped || 0}`,
  );

  // H2 conformance verdict.
  if (mismatches.length > 0) {
    console.error(`\nH2 conformance: FAIL (mismatches=${mismatches.length})`);
    for (const m of mismatches) {
      console.error(`  MISMATCH ${m.class} [${m.handling}] (${m.bucket}): ${m.reason}`);
    }
    process.exit(1);
  }

  console.log('H2 conformance: PASS (mismatches=0)');
  process.exit(0);
}

main();
