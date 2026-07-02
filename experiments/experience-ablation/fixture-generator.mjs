#!/usr/bin/env node
// fixture-generator.mjs — M1 deterministic trap-fixture generator
// (experience-ablation).
//
// Emits a seeded, byte-identical-on-same-seed corpus of lifecycle-trap
// fixtures in the recovery-runner corpus layout, per plan S13 M1:
//   <out>/<fixtureId>/
//     prompt.md        — the host-facing task (machine-checkable answer format)
//     task.json        — proofbound.experience-ablation-fixture.v1 metadata
//     workspace/       — leakage-stripped synthetic tree the host operates on
//     acceptance.mjs   — visible sanity check (answer-file format only)
//     oracle.mjs       — HIDDEN ground truth (plan S6.1 outcomes; M4 contract)
//     reference-good/  — selfcheck-only overlay: a correct solution
//     reference-bad/   — selfcheck-only overlay: the trap-hit solution
//   <out>/manifest.json — rows {fixtureId, trapClass, trapGroup, oracleRef}
//                         consumable by pair-ledger.mjs build (B-047f schema).
//
// DETERMINISM: every emitted byte derives from xmur3/mulberry32 over
// (seed, class, index); directory writes happen in sorted order; no
// timestamps, no environment reads. fixtureIds are NEUTRAL (fx-<hex>-<n>):
// the workspace directory name is host-visible, so class names must not
// appear in it (leakage via pwd).

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ORACLE_RUNTIME,
  TRAP_CLASSES,
  allLeakMarkers,
  pick,
} from './trap-templates.mjs';

export const FIXTURE_SCHEMA_VERSION = 'proofbound.experience-ablation-fixture.v1';

// --- seeded PRNG (xmur3 + mulberry32), the local pattern shared with
// pair-ledger.mjs / run-driver.mjs -------------------------------------------
export function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

export function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededHex(rand, chars = 8) {
  let s = '';
  for (let i = 0; i < chars; i++) s += Math.floor(rand() * 16).toString(16);
  return s;
}

// --- template context ---------------------------------------------------------
const MODULE_WORDS = ['harbor', 'lantern', 'quarry', 'meadow', 'timber', 'cobalt', 'juniper', 'saffron'];
const PRODUCT_OLD = ['Windgate', 'Ferrowick', 'Larkspur'];
const PRODUCT_NEW = ['Harborlight', 'Quillstone', 'Mistvale'];

function contextFor(rand) {
  const token = pick(rand, MODULE_WORDS);
  const oldIdx = Math.floor(rand() * PRODUCT_OLD.length);
  return {
    rand,
    token,
    Token: token[0].toUpperCase() + token.slice(1),
    oldBrand: PRODUCT_OLD[oldIdx],
    newBrand: PRODUCT_NEW[oldIdx],
  };
}

// --- acceptance script (visible; format-only, never correctness) --------------
function acceptanceSource(spec) {
  const answerFile = spec.answerFile ?? spec.doneFile ?? null;
  return [
    `#!/usr/bin/env node`,
    `// Visible sanity check: confirms the answer artifact exists. It does NOT`,
    `// judge correctness (that is the harness's job).`,
    `import { existsSync } from 'node:fs';`,
    `import { join, dirname } from 'node:path';`,
    `import { fileURLToPath } from 'node:url';`,
    `const ws = join(dirname(fileURLToPath(import.meta.url)), 'workspace');`,
    answerFile
      ? `if (!existsSync(join(ws, ${JSON.stringify(answerFile)}))) { console.log('MISSING: ${answerFile}'); process.exit(1); }`
      : `// no single answer artifact for this task shape`,
    `console.log('answer artifact present');`,
  ].join('\n') + '\n';
}

function oracleSource(spec) {
  return `// HIDDEN ground-truth oracle — harness-only; hosts never read this file.\n` +
    `// Output contract (M4 scorer input; plan S10/S6.1) documented in trap-templates.mjs.\n` +
    `const ORACLE_SPEC = ${JSON.stringify(spec)};\n` + ORACLE_RUNTIME;
}

// --- emission ---------------------------------------------------------------------
function writeTree(base, files) {
  for (const rel of Object.keys(files).sort()) {
    const p = join(base, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, files[rel]);
  }
}

export function emitCorpus({ outDir, seed, perClass, classes }) {
  if (typeof seed !== 'string' || !seed) throw new Error('seed must be a non-empty string');
  if (!(Number.isInteger(perClass) && perClass > 0)) throw new Error('perClass must be a positive integer');
  const roster = TRAP_CLASSES.filter((c) => !classes || classes.includes(c.name));
  if (roster.length === 0) throw new Error('no classes selected');
  const manifest = [];
  const emitted = [];
  for (const cls of roster) {
    for (let i = 0; i < perClass; i++) {
      const rand = mulberry32(xmur3(`${seed}::${cls.name}::${i}`)());
      const ctx = contextFor(rand);
      const fixtureId = `fx-${seededHex(rand)}-${i}`; // NEUTRAL id — no class name (pwd leakage)
      const dir = join(outDir, fixtureId);
      const workspaceFiles = cls.workspace(ctx);
      const spec = cls.oracleSpec(ctx);
      const files = {
        'prompt.md': cls.prompt(ctx) + '\n',
        'task.json': JSON.stringify({
          schemaVersion: FIXTURE_SCHEMA_VERSION,
          fixtureId,
          trapClass: cls.name,
          trapGroup: cls.group,
          oracleRef: 'oracle.mjs',
          workspaceRoot: 'workspace',
          seedTag: `${seed}::${cls.name}::${i}`,
        }, null, 2) + '\n',
        'acceptance.mjs': acceptanceSource(spec),
        'oracle.mjs': oracleSource(spec),
      };
      for (const [rel, content] of Object.entries(workspaceFiles)) files[`workspace/${rel}`] = content;
      for (const [rel, content] of Object.entries(cls.referenceGood(ctx, workspaceFiles))) files[`reference-good/${rel}`] = content;
      for (const [rel, content] of Object.entries(cls.referenceBad(ctx, workspaceFiles))) files[`reference-bad/${rel}`] = content;
      writeTree(dir, files);
      manifest.push({ fixtureId, trapClass: cls.name, trapGroup: cls.group, oracleRef: 'oracle.mjs' });
      emitted.push({ fixtureId, trapClass: cls.name });
    }
  }
  const ids = manifest.map((r) => r.fixtureId);
  if (new Set(ids).size !== ids.length) throw new Error('fixtureId collision — widen seededHex');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { manifest, emitted };
}

// --- leakage audit (exported so the selfcheck and future M6 audits share it) ---
// Scans the HOST-VISIBLE surface of one fixture (prompt.md + workspace/**)
// for the plan-S9 strip-list markers. Returns [] when clean.
export function leakageAudit(fixtureDir) {
  const hits = [];
  const markers = allLeakMarkers().map((m) => m.toLowerCase());
  const scan = (rel) => {
    let text;
    try { text = readFileSync(join(fixtureDir, rel), 'utf8').toLowerCase(); } catch { return; }
    for (const m of markers) if (text.includes(m)) hits.push(`${rel}: '${m}'`);
  };
  scan('prompt.md');
  const rec = (relBase) => {
    let entries = [];
    try { entries = readdirSync(join(fixtureDir, relBase)).sort(); } catch { return; }
    for (const e of entries) {
      const rel = `${relBase}/${e}`;
      if (statSync(join(fixtureDir, rel)).isDirectory()) rec(rel);
      else scan(rel);
    }
  };
  rec('workspace');
  return hits;
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
  const cmd = args._[0];
  try {
    if (cmd === 'generate') {
      if (!args.out || !args.seed) throw new Error('generate requires --out and --seed');
      const perClass = Number(args.perClass ?? 1);
      const classes = args.classes ? String(args.classes).split(',') : null;
      const { emitted } = emitCorpus({ outDir: args.out, seed: String(args.seed), perClass, classes });
      const byClass = {};
      for (const e of emitted) byClass[e.trapClass] = (byClass[e.trapClass] ?? 0) + 1;
      for (const [c, n] of Object.entries(byClass)) console.log(`${c}: ${n} fixture(s)`);
      console.log(`total ${emitted.length} fixtures -> ${args.out} (manifest.json included)`);
      return;
    }
    if (cmd === 'list-classes') {
      for (const c of TRAP_CLASSES) console.log(`${c.name} [${c.group}]`);
      return;
    }
    console.error('usage:');
    console.error('  node fixture-generator.mjs generate --out=<dir> --seed=<string> [--perClass=<n>] [--classes=<csv>]');
    console.error('  node fixture-generator.mjs list-classes');
    process.exit(2);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
