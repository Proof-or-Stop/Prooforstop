#!/usr/bin/env node
// Committed viability harness (M0 CHK-001 / CHK-005).
//
// Generates ONE clean small baseline (seed 42) in mkdtemp. For each candidate
// (tamper class x manifest handling) it copies the clean baseline to a fresh
// mkdtemp, applies a DETERMINISTIC mutation (fixed indices / fixed inputs, no
// randomness), runs the real verify CLI, and records the observed fingerprint
// over the explicit domain.
//
// Every candidate carries an `intent`: 'benign' | 'malicious'. A malicious
// candidate is a real tamper we WANT the instrument to reject; a benign one is
// a content-inert change (reorder-then-refresh, additive-field, seed-swap) that
// the instrument is CORRECT to accept.
//
// Disposition rule (frozen, evaluated IN THIS ORDER):
//   (1) fail-closed          : verify status === 'fail' OR 'crash' (a crash is
//                              the instrument refusing to certify — a genuine
//                              detection outcome).
//   (2) acknowledged-limitation : else if intent==='malicious'. A real tamper
//                              the instrument does NOT detect — a DOCUMENTED
//                              blind spot. An editor who recomputes the digests
//                              (refresh) defeats the digest mechanism; that is
//                              out of H2 scope and would be addressed by Tier-C
//                              signing (the plan claim boundary).
//   (3) dropped              : else if records.jsonl AND gold-queries.json are
//                              BYTE-IDENTICAL to clean (only manifest/metadata
//                              changed) — the content-inert no-op case.
//   (4) accepted             : else (a benign content change the instrument
//                              correctly accepts).
//   SAFETY: intent==='benign' AND status==='fail' -> 'false-positive' and exit
//   nonzero. The instrument must NEVER reject a benign change; if it does the
//   harness fails loudly.
//
// The harness NEVER mutates the source clean baseline; every mutation happens on
// an isolated copy that is removed afterward.
//
// Writes viability-results.json (canonical, byte-stable) with per-candidate
// {class, handling, intent, disposition, fingerprint, smokeOverlap} and prints a
// disposition table + a summary line. Asserts the fail-closed set is non-empty
// and every fail-closed class carries a genuine failure signal (a flag/metric
// off gold OR a crash status); exits nonzero on any vacuous fail-closed class or
// any false-positive.

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
  failureSignals,
} from './lib/instrument.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(HERE, 'viability-results.json');

// ---------------------------------------------------------------------------
// smokeOverlap audit map (CHK-005).
// Audited against packages/main/src/tasks/playbook-runtime-memory-baseline-smoke.ts.
// gold tamper (raw), corruptRows/recordCount override + refreshed truncation
// variant are covered there; byte-flip / row-drop / duplicate / reorder /
// field-rename / manifest profile+digest edits / cross-profile swap / seed-swap
// are net-new (no equivalent smoke case exists).
// ---------------------------------------------------------------------------
const SMOKE_OVERLAP = {
  'records-byte-flip': { covered: false },
  'records-row-drop': { covered: false },
  'records-row-duplicate': { covered: false },
  'records-row-reorder': { covered: false },
  'records-field-rename': { covered: false },
  'records-truncation': {
    covered: true,
    smokeCase: 'assertTruncatedSelfConsistentManifestWouldFail',
  },
  'gold-edit': { covered: true, smokeCase: 'assertGoldTamperWouldFail' },
  // additive-field variant (adds tampered:true then refreshes) — renamed out of
  // gold-edit so it does not collide with the new gold-semantic-weaken tamper.
  'gold-additive-field': { covered: false },
  'manifest-recordCount-edit': { covered: false },
  'manifest-profile-edit': { covered: false },
  'manifest-digest-edit': { covered: false },
  'cross-profile-swap': { covered: false },
  'seed-swap': { covered: false },
  // Net-new classes enumerating the missing tamper matrix (Codex F-001..F-004).
  // All net-new -> covered:false; the two gold-structural / gold-semantic
  // classes relate to gold-queries.json but are still net-new (no smoke case
  // exercises a semantic-weaken or a structural-corruption of gold).
  'gold-weaken-expectedids': { covered: false },
  'corruptRows-lie': { covered: false },
  'duplicate-gold-id': { covered: false },
  'manifest-structural-corruption': { covered: false },
  'gold-structural-corruption': { covered: false },
  // Net-net representative classes for the digest-recompute blind-spot family
  // (Codex re-check F-005/F-006). The family is UNBOUNDED (every gold-derived
  // oracle obligation + every unasserted manifest metadata field is a
  // refreshed-lie blind spot); these are representative confirmed instances.
  'gold-weaken-suppressed': { covered: false },
  'gold-weaken-mustnotsurface': { covered: false },
  'manifest-metadata-lie': { covered: false },
};

// ---------------------------------------------------------------------------
// Deterministic candidate mutations. handling: 'raw' | 'refreshed'.
// All indices / inputs are fixed constants; no randomness anywhere.
// ---------------------------------------------------------------------------
// intent: 'malicious' (a real tamper we want rejected) | 'benign' (a
// content-inert change the instrument is correct to accept).
const candidates = [];
const addRaw = (className, intent, mutate) =>
  candidates.push({ className, handling: 'raw', intent, mutate });
const addRefreshed = (className, intent, mutate, overrides = {}) =>
  candidates.push({
    className,
    handling: 'refreshed',
    intent,
    mutate: (d) => {
      mutate(d);
      refreshManifest(d, overrides);
    },
  });

const recPath = (d) => join(d, 'records.jsonl');
const goldPath = (d) => join(d, 'gold-queries.json');
const manifestPath = (d) => join(d, 'manifest.json');
const readLines = (d) => readFileSync(recPath(d), 'utf8').split('\n');
const writeLines = (d, lines) => writeFileSync(recPath(d), lines.join('\n'));

// records byte-flip (raw): flip one bit at a fixed byte offset.
addRaw('records-byte-flip', 'malicious', (d) => {
  const b = readFileSync(recPath(d));
  b[100] = b[100] ^ 0x01;
  writeFileSync(recPath(d), b);
});

// row drop at fixed index 5.
const dropRow = (d) => {
  const L = readLines(d);
  L.splice(5, 1);
  writeLines(d, L);
};
addRaw('records-row-drop', 'malicious', dropRow);
addRefreshed('records-row-drop', 'malicious', dropRow, { recordCount: 999 });

// row duplicate at fixed index 5.
const dupRow = (d) => {
  const L = readLines(d);
  L.splice(5, 0, L[5]);
  writeLines(d, L);
};
addRaw('records-row-duplicate', 'malicious', dupRow);
addRefreshed('records-row-duplicate', 'malicious', dupRow, { recordCount: 1001 });

// row reorder: swap two fixed non-gold noise lines near the end (indices 800/801).
// raw is a real tamper (digest breaks); refreshed is content-inert (the set of
// records is unchanged, only order), so it is BENIGN and correctly accepted.
const reorder = (d) => {
  const L = readLines(d);
  const i = 800;
  const j = 801;
  [L[i], L[j]] = [L[j], L[i]];
  writeLines(d, L);
};
addRaw('records-row-reorder', 'malicious', reorder);
addRefreshed('records-row-reorder', 'benign', reorder);

// field rename in the first general-irrelevant noise record (deterministic scan).
const rename = (d) => {
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
addRaw('records-field-rename', 'malicious', rename);
addRefreshed('records-field-rename', 'malicious', rename);

// truncation to first 11 lines.
const trunc = (d) => {
  const L = readLines(d);
  writeLines(d, L.slice(0, 11));
};
addRaw('records-truncation', 'malicious', trunc);
addRefreshed('records-truncation', 'malicious', trunc, { recordCount: 11, corruptRows: 0 });

// gold edit: add a fixed field.
const goldEdit = (d) => {
  const g = JSON.parse(readFileSync(goldPath(d), 'utf8'));
  g.tampered = true;
  writeFileSync(goldPath(d), JSON.stringify(g, null, 2));
};
// raw = a real gold tamper (the on-disk bytes diverge from the pinned digest).
addRaw('gold-edit', 'malicious', goldEdit);
// refreshed = an ADDITIVE field (tampered:true) with digests recomputed. The
// added field is inert w.r.t. correctness, so the instrument is correct to
// accept it. Renamed to gold-additive-field to distinguish it from the new
// gold-semantic-weaken tamper (which drops an expectedId).
addRefreshed('gold-additive-field', 'benign', goldEdit);

// manifest recordCount edit (raw only): claim 999.
addRaw('manifest-recordCount-edit', 'malicious', (d) => {
  const m = JSON.parse(readFileSync(manifestPath(d), 'utf8'));
  m.recordCount = 999;
  writeFileSync(manifestPath(d), JSON.stringify(m, null, 2));
});

// manifest profile edit small->full (raw only).
addRaw('manifest-profile-edit', 'malicious', (d) => {
  const m = JSON.parse(readFileSync(manifestPath(d), 'utf8'));
  m.profile = 'full';
  writeFileSync(manifestPath(d), JSON.stringify(m, null, 2));
});

// manifest digest edit (raw only): corrupt recordsDigest to all-zero.
addRaw('manifest-digest-edit', 'malicious', (d) => {
  const m = JSON.parse(readFileSync(manifestPath(d), 'utf8'));
  m.recordsDigest = '0'.repeat(64);
  writeFileSync(manifestPath(d), JSON.stringify(m, null, 2));
});

// cross-profile swap: claim profile=full + recordCount=1_000_000 over small
// records, with digests refreshed from the small files (refreshed only).
addRefreshed('cross-profile-swap', 'malicious', (_d) => {}, {
  profile: 'full',
  recordCount: 1_000_000,
  fullProfileExactMillion: true,
});

// seed-swap: the content-inert drop case. Records + gold are byte-identical
// across seeds; only manifest.seed + manifestDigest change. Exercised raw and
// refreshed to prove the drop mechanism.
//   raw: rewrite manifest.seed to 99, leave manifestDigest inconsistent (a real
//        tamper: the manifest is internally inconsistent).
//   refreshed: set seed=99, then rebuild a self-consistent manifest — BENIGN
//        (seed is content-inert; records + gold are byte-identical to clean).
addRaw('seed-swap', 'malicious', (d) => {
  const m = JSON.parse(readFileSync(manifestPath(d), 'utf8'));
  m.seed = 99;
  writeFileSync(manifestPath(d), JSON.stringify(m, null, 2));
});
addRefreshed('seed-swap', 'benign', (_d) => {}, { seed: 99 });

// ---------------------------------------------------------------------------
// Net-new tamper classes enumerated from Codex host-2 findings F-001..F-004.
// Each is a MALICIOUS refresh/structural attack. The refreshed digest-recompute
// ones (gold-weaken-expectedids, corruptRows-lie, duplicate-gold-id) are the
// honest blind spots: an editor who recomputes the digests defeats the digest
// mechanism. The structural-corruption ones make the instrument THROW (crash
// sentinel).
// ---------------------------------------------------------------------------

// F1 gold-weaken-expectedids (refreshed): drop the LAST expectedId of the FIRST
// gold query that has >1 expectedId, then refresh the manifest. The tampered
// gold silently weakens the acceptance criteria yet verify still passes.
// (Renamed from gold-semantic-weaken for family clarity: it is the expectedIds
// representative of the unbounded oracle-weaken family — see F-005/F-006.)
addRefreshed('gold-weaken-expectedids', 'malicious', (d) => {
  const g = JSON.parse(readFileSync(goldPath(d), 'utf8'));
  for (const q of g.queries) {
    if (Array.isArray(q.expectedIds) && q.expectedIds.length > 1) {
      q.expectedIds = q.expectedIds.slice(0, q.expectedIds.length - 1);
      break;
    }
  }
  writeFileSync(goldPath(d), JSON.stringify(g, null, 2));
});

// F2 corruptRows-lie (refreshed): records + gold UNCHANGED, but the manifest
// claims corruptRows:0 (the truth is 1). Verify passes and still reports
// malformedRowsSkipped=1 — the manifest's corruptRows count is not enforced.
addRefreshed('corruptRows-lie', 'malicious', (_d) => {}, { corruptRows: 0 });

// F3 duplicate-gold-id (refreshed): rewrite the id of the LAST
// general-irrelevant noise row to the FIRST gold record id (/^mem-|^pb-/),
// creating a duplicate id, then refresh. Verify still passes.
addRefreshed('duplicate-gold-id', 'malicious', (d) => {
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
});

// F4 manifest-structural-corruption (raw): manifest.json := invalid JSON. The
// instrument throws; verifyDir returns the crash sentinel -> fail-closed.
addRaw('manifest-structural-corruption', 'malicious', (d) => {
  writeFileSync(manifestPath(d), '{ "profile": "small"');
});

// gold-structural-corruption (raw): gold-queries.json := invalid JSON. Same
// crash-sentinel -> fail-closed path.
addRaw('gold-structural-corruption', 'malicious', (d) => {
  writeFileSync(goldPath(d), '{ invalid');
});

// ---------------------------------------------------------------------------
// Representative coverage of the digest-recompute blind-spot family (Codex
// re-check F-005/F-006). The family is UNBOUNDED: every gold-derived oracle
// obligation (expectedIds, expectedSuppressedIds, mustNotSurfaceIds,
// expectedDeprecatedTermHits, supersededPreference, ...) AND every unasserted
// manifest metadata field (corruptRows, authority, gateEvidence, ...) is a
// refreshed-lie blind spot. We add REPRESENTATIVE confirmed instances (not an
// exhaustive enumeration) plus an explicit general statement in protocol.json.
// Each is expected status:pass -> acknowledged-limitation.
// ---------------------------------------------------------------------------

// F5a gold-weaken-suppressed (refreshed): drop the LAST entry of the FIRST gold
// query with >=1 expectedSuppressedIds, then refresh. The truth-first-query
// suppression obligation is silently weakened yet verify still passes — the
// expectedSuppressedIds representative of the oracle-weaken family.
addRefreshed('gold-weaken-suppressed', 'malicious', (d) => {
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
});

// F5b gold-weaken-mustnotsurface (refreshed): drop the LAST entry of the FIRST
// gold query with >=1 mustNotSurfaceIds, then refresh. The host-policy
// must-not-surface obligation is silently weakened yet verify still passes —
// the mustNotSurfaceIds representative of the oracle-weaken family.
addRefreshed('gold-weaken-mustnotsurface', 'malicious', (d) => {
  const g = JSON.parse(readFileSync(goldPath(d), 'utf8'));
  for (const q of g.queries) {
    if (Array.isArray(q.mustNotSurfaceIds) && q.mustNotSurfaceIds.length >= 1) {
      q.mustNotSurfaceIds = q.mustNotSurfaceIds.slice(0, q.mustNotSurfaceIds.length - 1);
      break;
    }
  }
  writeFileSync(goldPath(d), JSON.stringify(g, null, 2));
});

// F6 manifest-metadata-lie (refreshed): records + gold UNCHANGED, but the
// manifest claims gateEvidence:true (an unasserted metadata field), digests
// refreshed. Verify passes — the gateEvidence representative of the
// manifest-metadata-lie family (sibling of corruptRows-lie).
addRefreshed('manifest-metadata-lie', 'malicious', (_d) => {}, { gateEvidence: true });

// ---------------------------------------------------------------------------
// Run: one clean baseline, then every candidate on an isolated copy.
// ---------------------------------------------------------------------------
function generateCleanBaseline() {
  const root = mkdtempSync(join(tmpdir(), 'pos-clean-'));
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

function bytesIdentical(aPath, bPath) {
  return readFileSync(aPath).equals(readFileSync(bPath));
}

// Disposition rule (frozen, evaluated IN THIS ORDER). Returns one of:
//   'fail-closed' | 'acknowledged-limitation' | 'dropped' | 'accepted' |
//   'false-positive'.
function disposition(status, intent, dir, cleanDir) {
  // (1) A verify 'fail' OR a 'crash' (instrument threw) is a genuine rejection.
  if (status === 'fail' || status === 'crash') {
    // SAFETY: a benign change must never be rejected. If it is, that is a
    // false-positive the harness must surface loudly.
    if (intent === 'benign') return 'false-positive';
    return 'fail-closed';
  }
  // status === 'pass' from here on.
  // (2) A malicious tamper that verify accepted is a DOCUMENTED blind spot.
  if (intent === 'malicious') return 'acknowledged-limitation';
  // (3) Content-inert no-op: records + gold byte-identical to clean.
  const recordsSame = bytesIdentical(recPath(dir), recPath(cleanDir));
  const goldSame = bytesIdentical(goldPath(dir), goldPath(cleanDir));
  if (recordsSame && goldSame) return 'dropped';
  // (4) A benign content change the instrument correctly accepts.
  return 'accepted';
}

function main() {
  const clean = generateCleanBaseline();
  const cleanRecordsDigestBefore = sha256(readFileSync(recPath(clean.dir)));
  const cleanGoldDigestBefore = sha256(readFileSync(goldPath(clean.dir)));

  const cleanFp = fingerprintDomain(verifyDir(clean.dir));
  if (cleanFp.status !== 'pass') {
    console.error('clean baseline did not verify pass:', JSON.stringify(cleanFp));
    process.exit(1);
  }

  const results = [];
  try {
    for (const cand of candidates) {
      const root = mkdtempSync(join(tmpdir(), 'pos-viab-'));
      const dir = join(root, 'base');
      cpSync(clean.dir, dir, { recursive: true });
      try {
        cand.mutate(dir);
        const fp = fingerprintDomain(verifyDir(dir));
        const disp = disposition(fp.status, cand.intent, dir, clean.dir);
        results.push({
          class: cand.className,
          handling: cand.handling,
          intent: cand.intent,
          disposition: disp,
          fingerprint: fp,
          smokeOverlap: SMOKE_OVERLAP[cand.className] ?? { covered: false },
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  } finally {
    // Verify the source clean baseline was NOT polluted, then clean it up.
    const recAfter = sha256(readFileSync(recPath(clean.dir)));
    const goldAfter = sha256(readFileSync(goldPath(clean.dir)));
    if (recAfter !== cleanRecordsDigestBefore || goldAfter !== cleanGoldDigestBefore) {
      rmSync(clean.root, { recursive: true, force: true });
      console.error('FATAL: source clean baseline was mutated during the run (tree pollution).');
      process.exit(1);
    }
    rmSync(clean.root, { recursive: true, force: true });
  }

  // Deterministic ordering: sort by class then handling for byte-stable output.
  results.sort((a, b) =>
    a.class === b.class
      ? a.handling.localeCompare(b.handling)
      : a.class.localeCompare(b.class),
  );

  const doc = { schemaVersion: 1, generatedFrom: 'small-seed-42', candidates: results };
  writeFileSync(OUT_PATH, canonicalJson(doc) + '\n');

  // Disposition table.
  console.log('=== DISPOSITION TABLE ===');
  for (const r of results) {
    console.log(
      `  ${r.disposition.padEnd(24)} ${r.class} [${r.handling}]  ` +
        `intent=${r.intent} status=${r.fingerprint.status} smokeCovered=${r.smokeOverlap.covered}`,
    );
  }

  const failClosed = results.filter((r) => r.disposition === 'fail-closed');
  const accepted = results.filter((r) => r.disposition === 'accepted');
  const acknowledged = results.filter((r) => r.disposition === 'acknowledged-limitation');
  const dropped = results.filter((r) => r.disposition === 'dropped');
  const falsePositive = results.filter((r) => r.disposition === 'false-positive');
  console.log(
    `\nfail-closed=${failClosed.length} accepted=${accepted.length} ` +
      `acknowledged-limitation=${acknowledged.length} dropped=${dropped.length}`,
  );

  // SAFETY invariant: NO benign change may be rejected. A false-positive is a
  // hard failure of the instrument's honesty and must abort loudly.
  if (falsePositive.length > 0) {
    console.error(
      'SAFETY VIOLATION: benign candidate(s) wrongly rejected (false-positive): ' +
        falsePositive.map((r) => `${r.class} [${r.handling}]`).join(', '),
    );
    process.exit(1);
  }

  // Two-pronged viability invariant: fail-closed set non-empty AND no vacuous
  // fail-closed class (each must carry >=1 failure signal, where a crash status
  // is itself a signal).
  if (failClosed.length === 0) {
    console.error('INVARIANT VIOLATION: fail-closed set is empty.');
    process.exit(1);
  }
  const vacuous = [];
  for (const r of failClosed) {
    const signals = failureSignals(r.fingerprint);
    if (signals.length === 0) {
      vacuous.push(`${r.class} [${r.handling}]`);
    }
  }
  if (vacuous.length > 0) {
    console.error(
      'INVARIANT VIOLATION: vacuous fail-closed class(es) with no failure signal: ' +
        vacuous.join(', '),
    );
    process.exit(1);
  }

  // Every acknowledged-limitation must be a MALICIOUS candidate the instrument
  // accepted (status:pass) — a documented blind spot, not a benign change.
  const badAck = acknowledged.filter(
    (r) => r.intent !== 'malicious' || r.fingerprint.status !== 'pass',
  );
  if (badAck.length > 0) {
    console.error(
      'INVARIANT VIOLATION: acknowledged-limitation entr(y/ies) not malicious+pass: ' +
        badAck.map((r) => `${r.class} [${r.handling}]`).join(', '),
    );
    process.exit(1);
  }

  console.log(
    `viability-results.json written (${results.length} candidates); ` +
      `every fail-closed class carries a failure signal; ` +
      `${acknowledged.length} acknowledged-limitation (malicious blind spots); no false-positive.`,
  );
}

main();
