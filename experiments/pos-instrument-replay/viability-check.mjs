#!/usr/bin/env node
// Committed viability harness (M0 CHK-001 / CHK-005).
//
// Generates ONE clean small baseline (seed 42) in mkdtemp. For each candidate
// (tamper class x manifest handling) it copies the clean baseline to a fresh
// mkdtemp, applies a DETERMINISTIC mutation (fixed indices / fixed inputs, no
// randomness), runs the real verify CLI, and records the observed fingerprint
// over the explicit domain.
//
// Disposition rule (frozen):
//   fail-closed : verify status === 'fail'.
//   accepted    : status === 'pass' AND (records.jsonl OR gold-queries.json
//                 bytes DIFFER from the clean baseline).
//   dropped     : status === 'pass' AND records.jsonl AND gold-queries.json are
//                 BYTE-IDENTICAL to clean (only manifest/metadata changed) —
//                 the seed-swap no-op case.
//
// The harness NEVER mutates the source clean baseline; every mutation happens on
// an isolated copy that is removed afterward.
//
// Writes viability-results.json (canonical, byte-stable) and prints a
// disposition table + a summary line. Asserts the fail-closed set is non-empty
// and every fail-closed class carries a genuine failure signal; exits nonzero
// if any fail-closed class is vacuous.

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
  'manifest-recordCount-edit': { covered: false },
  'manifest-profile-edit': { covered: false },
  'manifest-digest-edit': { covered: false },
  'cross-profile-swap': { covered: false },
  'seed-swap': { covered: false },
};

// ---------------------------------------------------------------------------
// Deterministic candidate mutations. handling: 'raw' | 'refreshed'.
// All indices / inputs are fixed constants; no randomness anywhere.
// ---------------------------------------------------------------------------
const candidates = [];
const addRaw = (className, mutate) =>
  candidates.push({ className, handling: 'raw', mutate });
const addRefreshed = (className, mutate, overrides = {}) =>
  candidates.push({
    className,
    handling: 'refreshed',
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
addRaw('records-byte-flip', (d) => {
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
addRaw('records-row-drop', dropRow);
addRefreshed('records-row-drop', dropRow, { recordCount: 999 });

// row duplicate at fixed index 5.
const dupRow = (d) => {
  const L = readLines(d);
  L.splice(5, 0, L[5]);
  writeLines(d, L);
};
addRaw('records-row-duplicate', dupRow);
addRefreshed('records-row-duplicate', dupRow, { recordCount: 1001 });

// row reorder: swap two fixed non-gold noise lines near the end (indices 800/801).
const reorder = (d) => {
  const L = readLines(d);
  const i = 800;
  const j = 801;
  [L[i], L[j]] = [L[j], L[i]];
  writeLines(d, L);
};
addRaw('records-row-reorder', reorder);
addRefreshed('records-row-reorder', reorder);

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
addRaw('records-field-rename', rename);
addRefreshed('records-field-rename', rename);

// truncation to first 11 lines.
const trunc = (d) => {
  const L = readLines(d);
  writeLines(d, L.slice(0, 11));
};
addRaw('records-truncation', trunc);
addRefreshed('records-truncation', trunc, { recordCount: 11, corruptRows: 0 });

// gold edit: add a fixed field.
const goldEdit = (d) => {
  const g = JSON.parse(readFileSync(goldPath(d), 'utf8'));
  g.tampered = true;
  writeFileSync(goldPath(d), JSON.stringify(g, null, 2));
};
addRaw('gold-edit', goldEdit);
addRefreshed('gold-edit', goldEdit);

// manifest recordCount edit (raw only): claim 999.
addRaw('manifest-recordCount-edit', (d) => {
  const m = JSON.parse(readFileSync(manifestPath(d), 'utf8'));
  m.recordCount = 999;
  writeFileSync(manifestPath(d), JSON.stringify(m, null, 2));
});

// manifest profile edit small->full (raw only).
addRaw('manifest-profile-edit', (d) => {
  const m = JSON.parse(readFileSync(manifestPath(d), 'utf8'));
  m.profile = 'full';
  writeFileSync(manifestPath(d), JSON.stringify(m, null, 2));
});

// manifest digest edit (raw only): corrupt recordsDigest to all-zero.
addRaw('manifest-digest-edit', (d) => {
  const m = JSON.parse(readFileSync(manifestPath(d), 'utf8'));
  m.recordsDigest = '0'.repeat(64);
  writeFileSync(manifestPath(d), JSON.stringify(m, null, 2));
});

// cross-profile swap: claim profile=full + recordCount=1_000_000 over small
// records, with digests refreshed from the small files (refreshed only).
addRefreshed('cross-profile-swap', (_d) => {}, {
  profile: 'full',
  recordCount: 1_000_000,
  fullProfileExactMillion: true,
});

// seed-swap: the content-inert drop case. Records + gold are byte-identical
// across seeds; only manifest.seed + manifestDigest change. Exercised raw and
// refreshed to prove the drop mechanism.
//   raw: rewrite manifest.seed to 99, leave manifestDigest inconsistent.
//   refreshed: set seed=99, then rebuild a self-consistent manifest.
addRaw('seed-swap', (d) => {
  const m = JSON.parse(readFileSync(manifestPath(d), 'utf8'));
  m.seed = 99;
  writeFileSync(manifestPath(d), JSON.stringify(m, null, 2));
});
addRefreshed('seed-swap', (_d) => {}, { seed: 99 });

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

function disposition(status, dir, cleanDir) {
  if (status === 'fail') return 'fail-closed';
  // status === 'pass'
  const recordsSame = bytesIdentical(recPath(dir), recPath(cleanDir));
  const goldSame = bytesIdentical(goldPath(dir), goldPath(cleanDir));
  if (recordsSame && goldSame) return 'dropped';
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
        const disp = disposition(fp.status, dir, clean.dir);
        results.push({
          class: cand.className,
          handling: cand.handling,
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
      `  ${r.disposition.padEnd(12)} ${r.class} [${r.handling}]  ` +
        `status=${r.fingerprint.status} smokeCovered=${r.smokeOverlap.covered}`,
    );
  }

  const failClosed = results.filter((r) => r.disposition === 'fail-closed');
  const accepted = results.filter((r) => r.disposition === 'accepted');
  const dropped = results.filter((r) => r.disposition === 'dropped');
  console.log(
    `\nfail-closed=${failClosed.length} accepted=${accepted.length} dropped=${dropped.length}`,
  );

  // Two-pronged viability invariant: fail-closed set non-empty AND no vacuous
  // fail-closed class (each must carry >=1 failure signal).
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

  console.log(`viability-results.json written (${results.length} candidates); every fail-closed class carries a failure signal.`);
}

main();
