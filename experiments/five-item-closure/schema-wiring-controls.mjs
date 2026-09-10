#!/usr/bin/env node
// Independent auditor control: adversarial bypasses against assertIdentitySiteValueBinding.
// Private temp fixture only; repository files are never written.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const { ACTIVE_IDENTITY_OPERATION_BOUNDARIES: boundaries, assertCanonicalActiveIdentityBoundary: check } =
  await import(join(root, 'packages/main/dist/core/runtime-environment-checks.js'));

const fixture = mkdtempSync(join(tmpdir(), 'auditor-value-binding-'));
const pkg = join(fixture, 'packages/main'); mkdirSync(pkg, { recursive: true });
const rows = [];
const stage = (boundaryId) => {
  const boundary = boundaries.find(row => row.id === boundaryId);
  for (const p of boundary.paths) {
    const target = join(pkg, p.path); mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, 'packages/main', p.path), target);
  }
  for (const site of boundary.identitySites.filter(row => row.identityOrigin)) {
    const relative = site.identityOrigin.sourcePath.replace('packages/main/src/', 'dist/').replace(/\.ts$/, '.js');
    const target = join(pkg, relative); mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, 'packages/main', relative), target);
  }
};
stage('review-incremental-context');
stage('review-inventory-epoch');

const run = (boundaryId, distPath, name, transform, expectRefusal) => {
  const path = join(pkg, distPath);
  const original = readFileSync(path, 'utf8');
  const input = { boundaryId, projectRoot: fixture, runtimePackageRoot: pkg };
  try { check(input); } catch (e) { rows.push({ name, baseline: 'DIRTY', error: String(e.message) }); return; }
  const mutated = transform(original);
  assert.notEqual(mutated, original, 'each auditor counterexample must alter executable bytes: ' + name);
  writeFileSync(path, mutated);
  let error = '';
  try { check(input); } catch (caught) { error = String(caught.message); }
  writeFileSync(path, original);
  const refused = /consumer rejected/.test(error);
  rows.push({ name, refused, expectRefusal, bypass: expectRefusal && !refused, error: error || '(accepted)' });
};

const EF = 'dist/core/evidence-freshness.js';
const RIE = 'dist/core/review-inventory-epoch.js';

// A. export-const declaration intact, but the live producer emits a different literal.
run('review-incremental-context', EF, 'A-const-kept-producer-literal-diverges', t =>
  t.replace('schemaVersion: VERIFIER_DEPENDENCY_MANIFEST_VERSION,',
            "schemaVersion: 'proof-or-stop.verifier-dependency-manifest.v999',"), true);

// B. export-const intact, live acceptance comparison rewritten to a foreign value.
run('review-incremental-context', EF, 'B-const-kept-consumer-comparison-diverges', t =>
  t.replace('if (value.schemaVersion === VERIFIER_DEPENDENCY_MANIFEST_VERSION) {',
            "if (value.schemaVersion === 'proof-or-stop.verifier-dependency-manifest.v999') {"), true);

// C. export-const intact, binding producer emits a foreign literal.
run('review-incremental-context', EF, 'C-binding-const-kept-producer-diverges', t =>
  t.replace('schemaVersion: VERIFIER_DEPENDENCY_MANIFEST_BINDING_VERSION,',
            "schemaVersion: 'proof-or-stop.verifier-dependency-manifest-binding.v999',"), true);

// D. property site: live producer computed; decoy literal parked in a dead object
//    inside the SAME registered function.
run('review-inventory-epoch', RIE, 'D-property-decoy-dead-object-same-function', t =>
  t.replace("schemaVersion: 'proof-or-stop.inventory-verification-observation.v1',",
            "schemaVersion: ['proof-or-stop.inventory-verification-observation','v999'].join('.'),")
   .replace('const evidenceSemantics = (value, item) => {',
            "const evidenceSemantics = (value, item) => {\n        const _auditDecoy = { schemaVersion: 'proof-or-stop.inventory-verification-observation.v1' };"), true);

// E. comparison site: live gate uses an aliased left-hand + foreign literal; canonical
//    comparison retained as dead code in the SAME registered function.
run('review-inventory-epoch', RIE, 'E-comparison-alias-with-dead-canonical', t =>
  t.replace("if (evidence.receipt.schemaVersion === 'proof-or-stop.verification-receipt-bundle.v5') {",
            "const _sv = evidence.receipt.schemaVersion;\n                const _dead = evidence.receipt.schemaVersion === 'proof-or-stop.verification-receipt-bundle.v5';\n                if (_sv === 'proof-or-stop.verification-receipt-bundle.v999') {"), true);

// F. comparison site: canonical literal retained but the gate sense is inverted.
run('review-inventory-epoch', RIE, 'F-comparison-sense-inverted', t =>
  t.replace("if (evidence.receipt.schemaVersion === 'proof-or-stop.verification-receipt-bundle.v5') {",
            "if (!(evidence.receipt.schemaVersion === 'proof-or-stop.verification-receipt-bundle.v5')) {"), true);

// G. control: duplicate export-const declaration must be refused.
run('review-incremental-context', EF, 'G-duplicate-export-const', t =>
  t + "\nexport const VERIFIER_DEPENDENCY_MANIFEST_VERSION = 'proof-or-stop.verifier-dependency-manifest.v1';\n", true);

// H. control: non-exported const with canonical value must be refused.
run('review-incremental-context', EF, 'H-const-unexported', t =>
  t.replace("export const VERIFIER_DEPENDENCY_MANIFEST_VERSION = 'proof-or-stop.verifier-dependency-manifest.v1';",
            "const VERIFIER_DEPENDENCY_MANIFEST_VERSION = 'proof-or-stop.verifier-dependency-manifest.v1';\nexport { VERIFIER_DEPENDENCY_MANIFEST_VERSION };"), true);

// I. control: const value indirected through a concat expression must be refused.
run('review-incremental-context', EF, 'I-const-computed-value', t =>
  t.replace("export const VERIFIER_DEPENDENCY_MANIFEST_VERSION = 'proof-or-stop.verifier-dependency-manifest.v1';",
            "export const VERIFIER_DEPENDENCY_MANIFEST_VERSION = 'proof-or-stop.verifier-dependency-manifest' + '.v1';"), true);

// J. control: registered function renamed (site should fail closed).
run('review-inventory-epoch', RIE, 'J-registered-function-renamed', t =>
  t.replace('export function reviewInventoryAcceptanceSubjectDigest(',
            'export function reviewInventoryAcceptanceSubjectDigestRenamed(')
   .replace(/reviewInventoryAcceptanceSubjectDigest\(scopeContract/g, 'reviewInventoryAcceptanceSubjectDigestRenamed(scopeContract'), true);

// K. neighbour site in the SAME boundary with no valueBinding: decoy comment bypass.
run('review-inventory-epoch', RIE, 'K-unbound-neighbour-site-comment-decoy', t =>
  t.replaceAll('proof-or-stop.review_inventory_epoch.v1', 'proof-or-stop.review_inventory_epoch.v999')
   + "\n// proof-or-stop.review_inventory_epoch.v1\n", true);

// D2 preserves the auditor's computed-write bypass verbatim.
run('review-inventory-epoch', RIE, 'D2-property-elementaccess-live-with-dead-decoy', t =>
  t.replace("schemaVersion: 'proof-or-stop.inventory-verification-observation.v1',",
    "...(() => { const _o = {}; _o['schemaVersion'] = 'proof-or-stop.inventory-verification-observation.v999'; return _o; })(),")
   .replace('const evidenceSemantics = (value, item) => {',
    "const evidenceSemantics = (value, item) => {\n        const _auditDecoy = { schemaVersion: 'proof-or-stop.inventory-verification-observation.v1' };"), true);
for (const [boundaryId, relative] of [['review-incremental-context', EF], ['review-inventory-epoch', RIE]]) {
  const path = join(pkg, relative), original = readFileSync(path, 'utf8');
  writeFileSync(path, original.replaceAll('export const ', 'export   const ') + '\n// syntax-preserving diagnostic comment\n');
  check({boundaryId,projectRoot:fixture,runtimePackageRoot:pkg});
  writeFileSync(path, original);
}
console.log(JSON.stringify({ rows }, null, 2));
const bypasses = rows.filter(r => r.bypass);
console.log(bypasses.length ? 'AUDITOR_BYPASSES=' + bypasses.map(r => r.name).join(',') : 'AUDITOR_NO_BYPASS');
rmSync(fixture, { recursive: true, force: true });
assert.equal(bypasses.length, 0, 'LIVE_SCHEMA_PRODUCER_CONSUMER_DIVERGENCE');
assert.ok(rows.every(row => row.refused), 'every source divergence must be refused');
