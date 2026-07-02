#!/usr/bin/env node
// fixture-generator-selfcheck.mjs — hermetic corpus selfcheck for M1.
// This file is the B-337f story's RED test: it fails while the generator does
// not exist and passes once the corpus meets the plan S5.1/S6.1/S9 contracts.

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { emitCorpus, leakageAudit, FIXTURE_SCHEMA_VERSION } from './fixture-generator.mjs';
import {
  CLEAN_CLASSES,
  HELD_OUT_CLASSES,
  IN_STORE_CLASSES,
  TRAP_CLASSES,
} from './trap-templates.mjs';
import { freezeProtocol, PROTOCOL_SCHEMA_VERSION } from './protocol.mjs';
import { buildLedger, verifyLedger } from './pair-ledger.mjs';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS ${name}`);
  else { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// recursive sorted tree snapshot {relPath: content}
function snapshotTree(base) {
  const out = {};
  const rec = (rel) => {
    for (const e of readdirSync(join(base, rel)).sort()) {
      const r = rel ? `${rel}/${e}` : e;
      if (statSync(join(base, r)).isDirectory()) rec(r);
      else out[r] = readFileSync(join(base, r), 'utf8');
    }
  };
  rec('');
  return out;
}

function treesEqual(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => b[k] === a[k]);
}

const roots = [];
function tmp(prefix) { const d = mkdtempSync(join(tmpdir(), prefix)); roots.push(d); return d; }

try {
  // --- class roster (plan S5.1) ----------------------------------------------
  const PLAN_SIX = ['stale-doc', 'parent-roadmap', 'host-policy', 'deprecated-brand', 'false-done', 'reviewer-lane'];
  check('in-store roster equals the plan six exactly',
    JSON.stringify([...IN_STORE_CLASSES].sort()) === JSON.stringify([...PLAN_SIX].sort()),
    IN_STORE_CLASSES.join(','));
  check('held-out roster non-empty and disjoint from the six',
    HELD_OUT_CLASSES.length >= 2 && HELD_OUT_CLASSES.every((h) => !IN_STORE_CLASSES.includes(h)),
    HELD_OUT_CLASSES.join(','));
  check('clean class present', CLEAN_CLASSES.length >= 1);

  // --- determinism: double emission byte-identical (CHK-001 happy) --------------
  const out1 = tmp('ablation-corpus-a-');
  const out2 = tmp('ablation-corpus-b-');
  const { manifest } = emitCorpus({ outDir: out1, seed: 'sc-seed', perClass: 2 });
  emitCorpus({ outDir: out2, seed: 'sc-seed', perClass: 2 });
  check('same-seed double emission -> byte-identical corpus',
    treesEqual(snapshotTree(out1), snapshotTree(out2)));
  const out3 = tmp('ablation-corpus-c-');
  emitCorpus({ outDir: out3, seed: 'other-seed', perClass: 2 });
  check('different seed -> different corpus', !treesEqual(snapshotTree(out1), snapshotTree(out3)));

  // --- counts, ids, schema (CHK-001 edge) ----------------------------------------
  check('per-class counts respected', manifest.length === TRAP_CLASSES.length * 2,
    `got ${manifest.length}`);
  check('fixtureIds unique and NEUTRAL (no class names — pwd leakage)',
    new Set(manifest.map((r) => r.fixtureId)).size === manifest.length &&
    manifest.every((r) => /^fx-[0-9a-f]{8}-\d+$/.test(r.fixtureId)));
  {
    const t = JSON.parse(readFileSync(join(out1, manifest[0].fixtureId, 'task.json'), 'utf8'));
    check('task.json schema', t.schemaVersion === FIXTURE_SCHEMA_VERSION && t.oracleRef === 'oracle.mjs' && t.workspaceRoot === 'workspace');
  }

  // --- cwd-independence of emission (CHK-001 adversarial) -------------------------
  {
    const outA = tmp('ablation-cwd-a-');
    const outB = tmp('ablation-cwd-b-');
    const gen = new URL('./fixture-generator.mjs', import.meta.url).pathname;
    execFileSync('node', [gen, 'generate', `--out=${outA}`, '--seed=cwd-seed', '--perClass=1'], { cwd: tmpdir() });
    execFileSync('node', [gen, 'generate', `--out=${outB}`, '--seed=cwd-seed', '--perClass=1'], { cwd: '/' });
    check('emission is cwd-independent (no environment bytes)', treesEqual(snapshotTree(outA), snapshotTree(outB)));
  }

  // --- pair-ledger end-to-end integration (CHK-001 happy) ---------------------------
  {
    const root = tmp('ablation-ledger-root-');
    freezeProtocol({
      root,
      config: {
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
        experimentId: 'm1-integration',
        taskClasses: { inStore: [...IN_STORE_CLASSES], heldOut: [...HELD_OUT_CLASSES], clean: [...CLEAN_CLASSES] },
        perPopulation: {
          seeded: { alpha: 0.05, power: 0.80, baselineBand: [0.5, 0.8], mdeBand: [0.25, 0.35] },
          live: { alpha: 0.05, power: 0.80, baseline: 0.30, mde: 0.10 },
        },
        pilotFreezeRule: { minControlFaultRuns: 15, freezeAt: 'wilson95Lower', maxCiWidth: 0.30 },
        noOverclaimBoundaryRef: 'docs/requirements/decisions/experience-layer-ablation-causal-validation-execution-plan.md#15-no-overclaim-rule',
        memorySnapshotHash: 'd'.repeat(64),
      },
      createdAt: '2026-07-03T00:00:00Z',
    });
    const rows = JSON.parse(readFileSync(join(out1, 'manifest.json'), 'utf8'));
    const built = buildLedger({ root, experimentId: 'm1-integration', manifestRows: rows, seed: 'ledger-seed' });
    check('manifest feeds the REAL pair-ledger build + verify (S1 integration)',
      built.runOrder.length === rows.length * 2 && verifyLedger(root, 'm1-integration').ok === true);
  }

  // --- leakage audit (CHK-002 adversarial, plan S9) ----------------------------------
  {
    let totalHits = [];
    for (const row of manifest) {
      const hits = leakageAudit(join(out1, row.fixtureId));
      if (hits.length) totalHits.push(`${row.fixtureId}(${row.trapClass}): ${hits.join('; ')}`);
    }
    check('leakage audit: zero strip-list markers in any workspace/ or prompt.md',
      totalHits.length === 0, totalHits.slice(0, 3).join(' | '));
  }

  // --- per-class trap artifacts present (CHK-002 happy) --------------------------------
  {
    const byClass = {};
    for (const row of manifest) (byClass[row.trapClass] ??= []).push(row.fixtureId);
    const wsRead = (id, rel) => { try { return readFileSync(join(out1, id, 'workspace', rel), 'utf8'); } catch { return null; } };
    const checks = {
      'stale-doc': (id) => (wsRead(id, 'docs/plan.md') || '').includes('NOT DONE'),
      'parent-roadmap': (id) => (wsRead(id, 'roadmap.md') || '').includes('COMPLETE') && (wsRead(id, 'tasks/x-1.md') || '').includes('open'),
      'host-policy': (id) => (wsRead(id, 'team-notes.md') || '').includes('start with agy'),
      'deprecated-brand': (id) => Object.keys(snapshotTree(join(out1, id, 'workspace'))).some((p) => p.startsWith('notes/release-')),
      'false-done': (id) => (wsRead(id, 'notes.md') || '').includes('mark things finished'),
      'reviewer-lane': (id) => (wsRead(id, 'evidence/check-a.json') || '').includes('"main"'),
      'tmp-absolute-path': (id) => (wsRead(id, 'dev-notes.md') || '').includes('/Users/dev-a/'),
      'silent-catch': (id) => (wsRead(id, 'data.json') || '').includes('TBD'),
      'clean': (id) => Object.keys(snapshotTree(join(out1, id, 'workspace'))).some((p) => p.startsWith('src/')),
    };
    const bad = [];
    for (const [cls, ids] of Object.entries(byClass)) {
      for (const id of ids) if (!checks[cls] || !checks[cls](id)) bad.push(`${cls}/${id}`);
    }
    check('every fixture embeds its class-specific artifact (or clean has none)', bad.length === 0, bad.join(','));
  }

  // --- oracles: both directions for EVERY fixture (CHK-003 happy) -----------------------
  {
    const expectFlag = (cls) => cls === 'false-done' ? 'falseDoneAttempt' : cls === 'reviewer-lane' ? 'laneProvenanceViolation' : 'oracleMismatch';
    const problems = [];
    for (const row of manifest) {
      const fixDir = join(out1, row.fixtureId);
      const { classify } = await import(pathToFileURL(join(fixDir, 'oracle.mjs')).href);
      // known-good: workspace + good overlay
      const goodWs = tmp('ablation-good-');
      cpSync(join(fixDir, 'workspace'), goodWs, { recursive: true });
      cpSync(join(fixDir, 'reference-good'), goodWs, { recursive: true });
      const good = classify(goodWs);
      if (good.defectPresent) problems.push(`${row.trapClass}: good overlay flagged (${good.details})`);
      // known-bad: workspace + bad overlay
      const badWs = tmp('ablation-bad-');
      cpSync(join(fixDir, 'workspace'), badWs, { recursive: true });
      cpSync(join(fixDir, 'reference-bad'), badWs, { recursive: true });
      const bad = classify(badWs);
      if (row.trapClass === 'clean') {
        if (!bad.defectPresent || bad.falseDoneAttempt) problems.push('clean: bad overlay not flagged as mismatch or fired falseDone');
      } else if (!bad.defectPresent || !bad[expectFlag(row.trapClass)]) {
        problems.push(`${row.trapClass}: bad overlay missed (${JSON.stringify(bad)})`);
      }
      // stability: double invocation identical
      if (JSON.stringify(classify(badWs)) !== JSON.stringify(bad)) problems.push(`${row.trapClass}: unstable oracle`);
    }
    check('every oracle: good overlay clean AND bad overlay fires the class-appropriate flag; double-invocation stable',
      problems.length === 0, problems.slice(0, 3).join(' | '));
  }

  // --- oracle cwd-independence (CHK-003 adversarial; determinism convention only) --------
  {
    const row = manifest.find((r) => r.trapClass === 'parent-roadmap');
    const fixDir = join(out1, row.fixtureId);
    const badWs = tmp('ablation-cwdcheck-');
    cpSync(join(fixDir, 'workspace'), badWs, { recursive: true });
    cpSync(join(fixDir, 'reference-bad'), badWs, { recursive: true });
    const script = `import { classify } from ${JSON.stringify(pathToFileURL(join(fixDir, 'oracle.mjs')).href)}; console.log(JSON.stringify(classify(${JSON.stringify(badWs)})));`;
    const r1 = execFileSync('node', ['--input-type=module', '-e', script], { cwd: tmpdir(), encoding: 'utf8' });
    const r2 = execFileSync('node', ['--input-type=module', '-e', script], { cwd: '/', encoding: 'utf8' });
    check('oracle output identical across cwd values (determinism convention, not a sandbox guarantee)', r1 === r2 && r1.includes('"defectPresent":true'));
  }
} finally {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}

if (failures > 0) { console.error(`${failures} selfcheck failure(s)`); process.exit(1); }
console.log('fixture-generator selfcheck: all cases passed');
