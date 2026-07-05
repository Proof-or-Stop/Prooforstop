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
//   4. compare the LIVE fingerprint to the entry's FROZEN fingerprint over the
//      frozen domain ONLY (flags: strict boolean equality; metrics: honor the
//      frozen predicate form — exact == for gold/int values, threshold < where
//      the frozen failureSignals declare op:'<', with an epsilon-tolerant float
//      compare so a legitimate repr does not spuriously fail),
//   5. emit ONE canonical, volatile-field-free JSONL line to tamper-verdicts.jsonl.
//
// H2 conformance (CHK-002): every failClosed entry must verify fail|crash AND
// fingerprintMatch true; every acceptanceBucket + acknowledgedLimitations entry
// must verify pass AND fingerprintMatch true; every dropped entry must verify
// pass. Any mismatch prints the offending class + expected-vs-actual and exits
// nonzero.

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
 *             FORM rather than raw float equality:
 *               - if a failureSignal declares this field with op '<' and a
 *                 threshold, the frozen value is an observed value strictly below
 *                 that threshold; the live value must ALSO be strictly below the
 *                 threshold AND numerically equal (epsilon) to the frozen value.
 *                 (The epsilon guards a legitimate float repr; the threshold
 *                 guard proves we do not spuriously treat a >=threshold value as
 *                 a pass-gold.)
 *               - otherwise (exact == form, e.g. gold values 0/1/2), an
 *                 epsilon-tolerant numeric equality.
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
    const pred = metricPredicates[k];
    if (pred && pred.op === '<') {
      // Threshold form: the frozen value is strictly < threshold. The live value
      // must (a) also be strictly < threshold (do NOT accept a >=threshold
      // pass-gold as a match) AND (b) reproduce the frozen value within epsilon.
      if (!(lv < pred.value)) {
        diffs.push(
          `metrics.${k}: frozen predicate '<${pred.value}' but actual=${lv} is NOT below threshold`,
        );
      } else if (Math.abs(lv - fv) > EPS) {
        diffs.push(`metrics.${k}: expected~=${fv} actual=${lv} (below threshold but differs)`);
      }
    } else {
      // Exact == form (gold 0/1/2 etc.): epsilon-tolerant numeric equality.
      if (Math.abs(lv - fv) > EPS) {
        diffs.push(`metrics.${k}: expected=${fv} actual=${lv}`);
      }
    }
  }

  return { match: diffs.length === 0, diffs };
}

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

  const clean = generateCleanBaseline();
  const cleanRecBefore = sha256(readFileSync(recPath(clean.dir)));
  const cleanGoldBefore = sha256(readFileSync(goldPath(clean.dir)));

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
      try {
        mutate(dir);
        fp = fingerprintDomain(verifyDir(dir));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }

      const verifyStatus = fp.status;
      const verifyFlags = fullFlagVector(fp);
      const goldMetrics = goldMetricVector(fp);

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

      // Disposition (mirrors viability-check.mjs's frozen disposition semantics,
      // recorded per-entry for the record).
      let disposition;
      if (verifyStatus === 'fail' || verifyStatus === 'crash') {
        disposition = 'fail-closed';
      } else if (entry.bucket === 'acknowledgedLimitations') {
        disposition = 'acknowledged-limitation';
      } else if (entry.bucket === 'dropped') {
        disposition = 'dropped';
      } else {
        disposition = 'accepted';
      }

      // Record the verdict (volatile-field-free by construction: no elapsedMs /
      // rss / absolute paths ever enter this object).
      verdicts.push({
        iterationId: iterationId(scale, entry.class, entry.handling),
        class: entry.class,
        handling: entry.handling,
        bucket: entry.bucket,
        verifyStatus,
        verifyFlags,
        goldMetrics,
        fingerprintMatch,
        disposition,
      });

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
    console.log(
      `  ${v.bucket.padEnd(24)} ${v.class.padEnd(30)} [${v.handling.padEnd(9)}] ` +
        `status=${String(v.verifyStatus).padEnd(5)} fp=${fpm} disp=${v.disposition}`,
    );
  }

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
