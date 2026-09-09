import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
// Auditor counterexample: does the review-inventory-epoch boundary observe the
// live producer/consumer of proof-or-stop.verification-receipt-bundle.v5 that
// lives OUTSIDE the two reviewed fingerprinted modules?
// Private temp fixture: a full copy of packages/main/dist. Repository untouched.
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const { assertCanonicalActiveIdentityBoundary: check } =
  await import(join(root, 'packages/main/dist/core/runtime-environment-checks.js'));

const fixture = mkdtempSync(join(tmpdir(), 'auditor-neighbour-'));
const pkg = join(fixture, 'packages/main');
mkdirSync(pkg, { recursive: true });
cpSync(join(root, 'packages/main/dist'), join(pkg, 'dist'), { recursive: true });

symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'), 'dir');
const publicHandler = () => {
  const script = `import {createCertificationWindowHandlers} from ${JSON.stringify(join(pkg,'dist/handlers/certification-window.js'))};try{createCertificationWindowHandlers({}).certification_window_status({storyId:''});throw Error('unexpected success')}catch(error){console.log(JSON.stringify({inputValidationReached:error.message==='certification_window_status: storyId is required',identityRefused:/consumer rejected/.test(error.message),message:error.message}));}`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:fixture,encoding:'utf8',timeout:30000});
  assert.equal(child.status,0,child.stdout+child.stderr);return JSON.parse(child.stdout);
};
const rows = [];
const run = (name, boundaryId, relPath, transform) => {
  const path = join(pkg, relPath);
  const original = readFileSync(path, 'utf8');
  const input = { boundaryId, projectRoot: fixture, runtimePackageRoot: pkg };
  let baseline = '';
  try { check(input); } catch (e) { baseline = String(e.message); }
  assert.equal(baseline,'','unmodified registered boundary must pass');
  const handlerBaseline = boundaryId==='review-inventory-epoch' ? publicHandler() : null;
  if(handlerBaseline) assert.equal(handlerBaseline.inputValidationReached,true,JSON.stringify(handlerBaseline));
  const mutated = transform(original);
  if (mutated === original) { rows.push({ name, error: 'MUTATION_NO_OP' }); return; }
  writeFileSync(path, mutated);
  let error = '';
  try { check(input); } catch (e) { error = String(e.message); }
  const handlerMutation = boundaryId==='review-inventory-epoch' ? publicHandler() : null;
  writeFileSync(path, original);
  rows.push({ name, boundaryId, mutatedFile: relPath, baselineClean: baseline === '', handlerBaseline, handlerMutation, refused: /consumer rejected/.test(error), error: error || '(accepted)' });
};

// 1. Live exported producer constant of the same identity, in a module the
//    boundary does not register.
run('N1-producer-const-outside-registered-path', 'review-inventory-epoch',
  'dist/core/verification-execution-evidence.js',
  t => t.replace("export const VERIFICATION_RECEIPT_BUNDLE_V5 = 'proof-or-stop.verification-receipt-bundle.v5';",
                 "export const VERIFICATION_RECEIPT_BUNDLE_V5 = 'proof-or-stop.verification-receipt-bundle.v999';"));

// 2. Live acceptance comparison on the same identity in handlers/checklist.js.
run('N2-acceptance-gate-outside-registered-path', 'review-inventory-epoch',
  'dist/handlers/checklist.js',
  t => t.replaceAll("receipt.schemaVersion !== 'proof-or-stop.verification-receipt-bundle.v5'",
                    "receipt.schemaVersion !== 'proof-or-stop.verification-receipt-bundle.v999'"));

// 3. Control: comment-only edit inside a fingerprinted module must stay accepted
//    (claimed allowance) and prove the fingerprint is not a raw byte hash.
run('N3-comment-only-edit-in-fingerprinted-module', 'review-inventory-epoch',
  'dist/core/review-inventory-epoch.js',
  t => '// auditor comment-only edit\n' + t.replace('\n', '\n/* auditor block comment */\n'));

// 4. Control: pure whitespace edit inside a fingerprinted module.
run('N4-whitespace-only-edit-in-fingerprinted-module', 'review-incremental-context',
  'dist/core/evidence-freshness.js', t => t.replace('\n', '\n\n\n    \n'));

// 5. Novel bypass attempt: keep the reviewed module's AST identical but shadow
//    the live value through a re-exported alias module the boundary never reads.
run('N5-alias-module-rewire', 'review-incremental-context',
  'dist/core/artifact-schema.js',
  t => t.includes("export const EVIDENCE_HASH_SNAPSHOT_SCHEMA")
    ? t.replace(/export const EVIDENCE_HASH_SNAPSHOT_SCHEMA = '[^']*';/,
        "export const EVIDENCE_HASH_SNAPSHOT_SCHEMA = 'proof-or-stop.evidence_hash_snapshot.v999';")
    : t);

console.log(JSON.stringify({ rows }, null, 2));
rmSync(fixture, { recursive: true, force: true });
for(const row of rows){
 const refuse=!['N3-comment-only-edit-in-fingerprinted-module','N4-whitespace-only-edit-in-fingerprinted-module'].includes(row.name);
 assert.equal(row.refused,refuse,'LIVE_SCHEMA_PRODUCER_CONSUMER_UNBOUND: '+row.name);
 if(row.handlerMutation) assert.equal(row.handlerMutation.identityRefused,refuse,'PUBLIC_SCHEMA_CONSUMER_GATE_UNBOUND: '+row.name);
}
console.log('LIVE_SCHEMA_PRODUCER_CONSUMER_GREEN');
