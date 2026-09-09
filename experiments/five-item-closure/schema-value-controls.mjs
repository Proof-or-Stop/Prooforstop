import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { ACTIVE_IDENTITY_OPERATION_BOUNDARIES as boundaries, assertCanonicalActiveIdentityBoundary as check } from '../../packages/main/dist/core/runtime-environment-checks.js';
const root = resolve(import.meta.dirname, '../..');
const cases = [
  ['review-incremental-context', 'packages/main/src/core/evidence-freshness.ts', 'proof-or-stop.verifier-dependency-manifest.v1'],
  ['review-incremental-context', 'packages/main/src/core/evidence-freshness.ts', 'proof-or-stop.verifier-dependency-manifest-binding.v1'],
  ['review-inventory-epoch', 'packages/main/src/core/review-inventory-epoch.ts', 'proof-or-stop.inventory-verification-observation.v1'],
  ['review-inventory-epoch', 'packages/main/src/core/review-inventory-epoch.ts', 'proof-or-stop.verification-receipt-bundle.v5'],
];
const fixture = mkdtempSync(join(tmpdir(), 'proof-or-stop-value-binding-'));
const pkg = join(fixture, 'packages/main'); mkdirSync(pkg, { recursive: true });
const rows = [];
try {
  for (const boundaryId of new Set(cases.map(row => row[0]))) {
    const boundary = boundaries.find(row => row.id === boundaryId);
    for (const p of boundary.paths) {
      const target = join(pkg, p.path); mkdirSync(dirname(target), { recursive: true });
      cpSync(join(root, 'packages/main', p.path), target);
    }
    for (const site of boundary.identitySites.filter(row => row.identityOrigin)) {
      const relative = site.identityOrigin.sourcePath.replace('packages/main/src/', 'dist/').replace(/\.ts$/, '.js');
      const target = join(pkg, relative); mkdirSync(dirname(target), { recursive: true }); cpSync(join(root, 'packages/main', relative), target);
    }
  }
  for (const [boundaryId, source, canonical] of cases) {
    const path = join(pkg, source.replace('packages/main/src/', 'dist/').replace(/\.ts$/, '.js'));
    const original = readFileSync(path, 'utf8'), changed = canonical.replace(/v\d+$/, 'v999');
    const input = { boundaryId, projectRoot: fixture, runtimePackageRoot: pkg };
    check(input);
    const mutations = [
      ['canonical-token-inside-wrong-value', original.replaceAll(canonical, changed + ' supersedes ' + canonical)],
      ['canonical-only-in-comment', original.replaceAll(canonical, changed) + '\n// ' + canonical + '\n'],
      ['canonical-only-in-decoy-literal', original.replaceAll(canonical, changed) + '\nconst unrelatedIdentityText = ' + JSON.stringify(canonical) + ';\n'],
    ];
    for (const [name, text] of mutations) {
      writeFileSync(path, text);
      let error = '';
      try { check(input); } catch (caught) { error = String(caught.message); }
      rows.push({ canonical, mutation: name, refused: /consumer rejected.*identity/.test(error), error });
    }
    writeFileSync(path, original); check(input);
  }
  console.log(JSON.stringify({ rows }, null, 2));
  assert.ok(rows.every(row => row.refused), 'LIVE_SCHEMA_VALUE_NOT_BOUND: canonical text is not the live schema value');
  console.log('LIVE_SCHEMA_VALUE_CONTROLS_GREEN');
} finally { rmSync(fixture, { recursive: true, force: true }); }
