#!/usr/bin/env node
// leakage-audit.mjs — M6 mechanical fixture-leakage audit (experience-ablation).
//
// Plan section 9 last row (docs/requirements/decisions/
// experience-layer-ablation-causal-validation-execution-plan.md): mechanically
// verify that neither arm can reconstruct the trap answer from the
// host-visible fixture surface. For every fixture in a generated corpus:
//
//   structure                       — task.json parseable (trapClass present),
//                                     prompt.md exists, workspace/ is a directory.
//   workspaceMarkers / promptMarkers — scan workspace/** and prompt.md against
//                                     the full LEAKAGE_STRIP_LIST (its class name
//                                     plus every other class name, lesson
//                                     signature phrases, answer prose, executable
//                                     residue tool names, meta) via the shared
//                                     leakageAudit() from fixture-generator.mjs —
//                                     a single marker-semantics source, so this
//                                     audit cannot silently diverge from the
//                                     generator selfcheck (F-005 pattern).
//   hiddenArtifactsOutsideWorkspace — oracle.mjs, reference-good/, reference-bad/
//                                     exist at the fixture root (OUTSIDE workspace/)
//                                     and nothing with those names appears anywhere
//                                     under workspace/.
//   promptOmitsTrapClass            — prompt.md never contains the fixture's own
//                                     trapClass (case-insensitive).
//
// Writes leakage-audit.jsonl rows {fixtureId, checks, pass} in deterministic
// (sorted fixtureId) order. Exit 0 with per-fixture PASS lines and a final
// "leakage-audit: all fixtures clean (N fixtures)" when clean; nonzero with
// LEAK lines naming fixture + marker on any leak.
//
// CLI:
//   node leakage-audit.mjs --corpus=<dir> [--out=<file>]
//   node leakage-audit.mjs --selftest
//
// --selftest is hermetic: it generates a small corpus via fixture-generator.mjs
// into a mkdtemp root, asserts the clean corpus passes, then poisons a COPY
// (injects a strip-list marker into one workspace file) and asserts the audit
// exits nonzero naming the fixture and the marker. No network, no repo writes.

import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emitCorpus, leakageAudit } from './fixture-generator.mjs';

const HIDDEN_ARTIFACTS = ['oracle.mjs', 'reference-good', 'reference-bad'];

// --- fixture discovery (deterministic: sorted union of manifest ids and
// subdirectories carrying a task.json) ----------------------------------------
export function discoverFixtureIds(corpusDir) {
  const ids = new Set();
  const manifestPath = join(corpusDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    const rows = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(rows)) throw new Error('manifest.json is not an array');
    for (const r of rows) if (r && typeof r.fixtureId === 'string') ids.add(r.fixtureId);
  }
  for (const e of readdirSync(corpusDir, { withFileTypes: true })) {
    if (e.isDirectory() && existsSync(join(corpusDir, e.name, 'task.json'))) ids.add(e.name);
  }
  return [...ids].sort();
}

function walkFiles(base, relBase, out) {
  let entries = [];
  try { entries = readdirSync(join(base, relBase)).sort(); } catch { return out; }
  for (const e of entries) {
    const rel = `${relBase}/${e}`;
    if (statSync(join(base, rel)).isDirectory()) walkFiles(base, rel, out);
    else out.push(rel);
  }
  return out;
}

// --- per-fixture audit -------------------------------------------------------
export function auditFixture(corpusDir, fixtureId) {
  const dir = join(corpusDir, fixtureId);
  const checks = {};
  const check = (name, hits) => { checks[name] = { pass: hits.length === 0, hits }; };

  // structure: the surfaces the other checks rely on must exist — the shared
  // marker scan silently skips unreadable files, so a missing prompt.md must
  // fail loudly here instead of passing silently there.
  const structureHits = [];
  let trapClass = null;
  try {
    const task = JSON.parse(readFileSync(join(dir, 'task.json'), 'utf8'));
    if (typeof task.trapClass === 'string' && task.trapClass) trapClass = task.trapClass;
    else structureHits.push('task.json has no trapClass');
  } catch (err) {
    structureHits.push(`task.json unreadable: ${err.message}`);
  }
  if (!existsSync(join(dir, 'prompt.md'))) structureHits.push('prompt.md missing');
  let workspaceIsDir = false;
  try { workspaceIsDir = statSync(join(dir, 'workspace')).isDirectory(); } catch { /* missing */ }
  if (!workspaceIsDir) structureHits.push('workspace/ missing or not a directory');
  check('structure', structureHits);

  // marker scan (shared semantics with the generator selfcheck): hits are
  // "<relPath>: '<marker>'"; partition prompt.md vs workspace/** hits.
  const markerHits = leakageAudit(dir);
  check('promptMarkers', markerHits.filter((h) => h.startsWith('prompt.md')));
  check('workspaceMarkers', markerHits.filter((h) => !h.startsWith('prompt.md')));

  // hidden artifacts: present at the fixture root, absent under workspace/.
  const hiddenHits = [];
  if (!existsSync(join(dir, 'oracle.mjs'))) hiddenHits.push('oracle.mjs missing at fixture root');
  for (const ref of ['reference-good', 'reference-bad']) {
    let isDir = false;
    try { isDir = statSync(join(dir, ref)).isDirectory(); } catch { /* missing */ }
    if (!isDir) hiddenHits.push(`${ref}/ missing at fixture root`);
  }
  for (const rel of walkFiles(dir, 'workspace', [])) {
    const segments = rel.split('/');
    for (const seg of segments.slice(1)) {
      if (HIDDEN_ARTIFACTS.includes(seg)) hiddenHits.push(`${rel} must live outside workspace/`);
    }
  }
  check('hiddenArtifactsOutsideWorkspace', hiddenHits);

  // prompt must never name the fixture's own trap class.
  const promptClassHits = [];
  if (trapClass) {
    let prompt = null;
    try { prompt = readFileSync(join(dir, 'prompt.md'), 'utf8').toLowerCase(); } catch { /* structure already failed */ }
    if (prompt !== null && prompt.includes(trapClass.toLowerCase())) {
      promptClassHits.push(`prompt.md names the trap class '${trapClass}'`);
    }
  }
  check('promptOmitsTrapClass', promptClassHits);

  const pass = Object.values(checks).every((c) => c.pass);
  return { fixtureId, checks, pass };
}

// --- corpus audit ------------------------------------------------------------
export function auditCorpus(corpusDir, outFile) {
  const ids = discoverFixtureIds(corpusDir);
  if (ids.length === 0) throw new Error(`no fixtures found under ${corpusDir}`);
  const rows = ids.map((id) => auditFixture(corpusDir, id));
  const jsonl = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(outFile, jsonl);
  return { rows, pass: rows.every((r) => r.pass) };
}

function runAudit(corpusDir, outFile) {
  const { rows, pass } = auditCorpus(corpusDir, outFile);
  for (const row of rows) {
    if (row.pass) {
      console.log(`PASS ${row.fixtureId}`);
    } else {
      for (const [name, c] of Object.entries(row.checks)) {
        for (const hit of c.hits) console.error(`LEAK ${row.fixtureId}: [${name}] ${hit}`);
      }
    }
  }
  if (pass) {
    console.log(`leakage-audit: all fixtures clean (${rows.length} fixtures)`);
    return 0;
  }
  const failed = rows.filter((r) => !r.pass).length;
  console.error(`leakage-audit: ${failed} of ${rows.length} fixture(s) leaked (see LEAK lines above)`);
  return 1;
}

// --- selftest ------------------------------------------------------------------
function assert(cond, msg) {
  if (!cond) throw new Error(`selftest assertion failed: ${msg}`);
}

function runSelf(corpusDir, outFile) {
  const self = fileURLToPath(import.meta.url);
  const res = spawnSync(process.execPath, [self, `--corpus=${corpusDir}`, `--out=${outFile}`], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function selftest() {
  const base = mkdtempSync(join(tmpdir(), 'leakage-audit-selftest-'));
  try {
    // 1) clean corpus straight from the generator must pass.
    const cleanDir = join(base, 'clean');
    const { emitted } = emitCorpus({ outDir: cleanDir, seed: 'leakage-audit-selftest', perClass: 1 });
    const cleanOut = join(base, 'clean-leakage-audit.jsonl');
    const clean = runSelf(cleanDir, cleanOut);
    assert(clean.status === 0, `clean corpus exit ${clean.status}, expected 0\n${clean.stdout}${clean.stderr}`);
    const passLines = clean.stdout.split('\n').filter((l) => l.startsWith('PASS fx-'));
    assert(passLines.length === emitted.length, `expected ${emitted.length} PASS lines, got ${passLines.length}`);
    assert(clean.stdout.includes(`leakage-audit: all fixtures clean (${emitted.length} fixtures)`), 'final clean summary line missing');
    const rows = readFileSync(cleanOut, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert(rows.length === emitted.length, `jsonl rows ${rows.length} != fixtures ${emitted.length}`);
    assert(rows.every((r) => r.pass === true && r.fixtureId && r.checks), 'clean jsonl rows must all pass with {fixtureId, checks, pass}');
    const sorted = [...rows.map((r) => r.fixtureId)].sort();
    assert(rows.map((r) => r.fixtureId).join(',') === sorted.join(','), 'jsonl rows must be sorted by fixtureId');
    console.log(`selftest: clean corpus -> exit 0, ${passLines.length} PASS lines, ${rows.length} jsonl rows all pass`);

    // 2) poison a COPY: inject a strip-list marker ('memory pack', a lesson
    //    signature phrase) into one workspace file; audit must exit nonzero
    //    naming the fixture and the marker.
    const poisonedDir = join(base, 'poisoned');
    cpSync(cleanDir, poisonedDir, { recursive: true });
    const victimId = discoverFixtureIds(poisonedDir)[0];
    const victimFiles = walkFiles(join(poisonedDir, victimId), 'workspace', []);
    assert(victimFiles.length > 0, `fixture ${victimId} has no workspace files to poison`);
    const victimFile = join(poisonedDir, victimId, victimFiles[0]);
    writeFileSync(victimFile, readFileSync(victimFile, 'utf8') + '\nAlso consult the memory pack for this.\n');
    const poisonedOut = join(base, 'poisoned-leakage-audit.jsonl');
    const poisoned = runSelf(poisonedDir, poisonedOut);
    assert(poisoned.status !== 0, `poisoned corpus exit ${poisoned.status}, expected nonzero`);
    assert(poisoned.stderr.includes(victimId), `failure output must name fixture ${victimId}\n${poisoned.stderr}`);
    assert(poisoned.stderr.includes(`'memory pack'`), `failure output must name the injected marker\n${poisoned.stderr}`);
    assert(poisoned.stderr.includes(victimFiles[0]), `failure output must name the poisoned file ${victimFiles[0]}`);
    const poisonedRows = readFileSync(poisonedOut, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const victimRow = poisonedRows.find((r) => r.fixtureId === victimId);
    assert(victimRow && victimRow.pass === false, 'poisoned fixture row must have pass=false');
    assert(victimRow.checks.workspaceMarkers.pass === false, 'workspaceMarkers check must fail for the poisoned fixture');
    assert(poisonedRows.filter((r) => r.fixtureId !== victimId).every((r) => r.pass === true), 'unpoisoned fixtures must still pass');
    console.log(`selftest: poisoned copy -> exit ${poisoned.status}, names ${victimId} + '${'memory pack'}' in ${victimFiles[0]}`);

    console.log('leakage-audit selftest: ALL PASS');
    return 0;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// --- CLI --------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) out[a.slice(2)] = true;
      else out[a.slice(2, eq)] = a.slice(eq + 1);
    } else out._.push(a);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.selftest) {
      process.exit(selftest());
    }
    if (args.corpus) {
      const outFile = args.out ? String(args.out) : join(String(args.corpus), 'leakage-audit.jsonl');
      process.exit(runAudit(String(args.corpus), outFile));
    }
    console.error('usage:');
    console.error('  node leakage-audit.mjs --corpus=<dir> [--out=<file>]');
    console.error('  node leakage-audit.mjs --selftest');
    process.exit(2);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
