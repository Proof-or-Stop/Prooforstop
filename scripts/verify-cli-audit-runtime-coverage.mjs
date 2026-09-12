import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import * as budget from './verification-subprocess-budget.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spawn = budget.prepareVerification(repo);
const scratch = fs.mkdtempSync(join(tmpdir(), 'cli-runtime-coverage-'));
const groups = [], measurements = {};
const read = path => fs.readFileSync(join(repo, path), 'utf8');
const source = path => ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functionText = (path, name) => {
  const node = source(path).statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, `production function missing: ${name}`); return node.getText();
};
const variableText = (path, name) => {
  let result; const walk = node => { if (ts.isVariableDeclaration(node) && node.name.getText() === name) result = node.initializer?.getText(); ts.forEachChild(node, walk); };
  walk(source(path)); assert.ok(result, `production variable missing: ${name}`); return result;
};
const check = async (id, run) => { try { await run(); groups.push({ id, pass: true }); } catch (error) { groups.push({ id, pass: false, error: error.message }); } };
try {
  await check('generated-desktop-entry-version-guard', () => {
    const snapshot = join(scratch, 'desktop-snapshot'), desktopDir = join(snapshot, 'dist/desktop');
    fs.mkdirSync(desktopDir, { recursive: true });
    const context = vm.createContext({ ...fs, join, dirname, repoRoot: repo, desktopDir,
      entryPath: join(desktopDir, 'pkg-entry.cjs'), assetManifestPath: join(desktopDir, 'asset-manifest.json') });
    for (const name of ['listFiles', 'writeAssetManifest', 'writePkgEntrypoint']) vm.runInContext(functionText('scripts/package-desktop.mjs', name), context);
    const files = vm.runInContext('writeAssetManifest()', context);
    assert.ok(files.includes('packages/main/package.json'), 'runtime manifest must be shipped');
    for (const rel of files) { const dest = join(snapshot, rel); fs.mkdirSync(dirname(dest), { recursive: true }); fs.copyFileSync(join(repo, rel), dest); }
    vm.runInContext('writePkgEntrypoint()', context);
    const env = { ...process.env };
    for (const key of ['NODE_OPTIONS', 'PROOF_OR_STOP_IMPLEMENTATION_MANIFEST', 'PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN', 'PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST']) delete env[key];
    const invoke = () => spawn(process.execPath, [join(desktopDir, 'pkg-entry.cjs'), '--version'], { cwd: scratch, env, encoding: 'utf8', timeout: 30000 });
    const manifest = join(snapshot, 'packages/main/package.json'), original = fs.readFileSync(manifest, 'utf8');
    const version = JSON.parse(original).version;
    const good = invoke(); assert.equal(good.status, 0, good.stderr); assert.ok(good.stdout.includes(version));
    fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(original), version: '999.1.0' }));
    const bad = invoke(); assert.notEqual(bad.status, 0); assert.match(bad.stderr, /CLI_RUNTIME_VERSION_MISMATCH/);
    fs.writeFileSync(manifest, original); assert.equal(invoke().status, 0);
    measurements.desktop = { manifestFiles: files.length, canonicalAccepted: true, staleRefused: true, restoredAccepted: true };
  });
  await check('two-new-executable-pins-against-built-dist', async () => {
    const { assertCanonicalActiveIdentityBoundary } = await import('../packages/main/dist/core/runtime-environment-checks.js');
    const root = join(scratch, 'pins'); fs.mkdirSync(root); fs.cpSync(join(repo, 'packages/main/dist'), join(root, 'dist'), { recursive: true });
    const rows = [];
    for (const [boundaryId, rel] of [['lifecycle-control', 'core/lifecycle-control/control-status.js'], ['learning-source-lineage', 'core/experience-layer-types.js']]) {
      const path = join(root, 'dist', rel); assert.ok(fs.existsSync(path), `required emitted module missing: ${rel}`);
      const verify = () => assertCanonicalActiveIdentityBoundary({ boundaryId, runtimePackageRoot: root, projectRoot: root });
      const original = fs.readFileSync(path, 'utf8'); verify();
      fs.writeFileSync(path, original + '\nexport const unreviewedAuditMutation = true;\n');
      assert.throws(verify, /consumer rejected active identity bytes/);
      fs.rmSync(path); assert.throws(verify, /registered executable bytes are missing/);
      fs.writeFileSync(path, original); verify(); rows.push({ boundaryId, canonicalAccepted: true, changedRefused: true, missingRefused: true, restoredAccepted: true });
    }
    measurements.pins = rows;
  });
  await check('identity-free-explanations-match-emitted-modules', () => {
    const text = read('packages/main/src/core/runtime-environment-checks.ts');
    assert.match(text, /classification\/lane\/status vocabulary.*independently pinned/);
    assert.match(text, /type-only source.*emitted module.*independently pinned/);
    assert.doesNotMatch(text, /type-only schema declarations compile to no emitted identity bytes/);
  });
  await check('lock-claims-distinguish-policy-from-callers', () => {
    assert.match(read('docs/reviewer-read-boundaries.md'), /only proves phase-advance and DONE preflight wiring/);
    assert.match(read('packages/main/src/core/runtime-fact-registry.ts'), /other operation kinds are evaluator policy, not a claim of all caller integration/);
    const wired = read('packages/main/src/handlers/transition-orchestrator.ts');
    assert.match(wired, /projectRuntimeClosure\(ctx.store, ctx.root/);
    assert.match(wired, /validationLock: runtimeRow.locks.validationLock/);
  });
  await check('budget-exhaustion-is-unavailable-not-assertion-red', () => {
    let exhausted; const run = budget.verificationSpawner(1); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    try { run(process.execPath, ['-e', 'process.exit(0)']); } catch (error) { exhausted = error; }
    assert.ok(exhausted); assert.equal(typeof budget.verificationFailureMessage, 'function');
    for (const error of [exhausted, new Error('SETUP_BUILD_TIMEOUT: fixture'), new Error('VERIFICATION_SUBPROCESS_TIMEOUT: fixture'), Object.assign(new Error('outer timeout'), { code: 'ETIMEDOUT' })]) {
      assert.match(budget.verificationFailureMessage('proof', error), /PROOF_UNAVAILABLE/);
    }
    assert.match(budget.verificationFailureMessage('proof', new Error('assertion mismatch')), /PROOF_ASSERTION_FAILED/);
    assert.match(read('scripts/verify-process-fact-contract.mjs'), /verificationFailureMessage\('maintenance preview'/);
    assert.match(read('scripts/verify-runtime-fact-contract.mjs'), /verificationFailureMessage\('CLI runtime version'/);
  });
  await check('asset-snapshot-permits-activity-keeps-managed-protection', () => {
    const root = join(scratch, 'assets'); fs.mkdirSync(join(root, '.proof-or-stop'), { recursive: true });
    fs.writeFileSync(join(root, 'AGENTS.md'), 'managed');
    const context = vm.createContext({ ...fs, createHash, join, root, Set });
    vm.runInContext('const snapshot = ' + variableText('scripts/verify-reviewer-read-boundaries.mjs', 'snapshot'), context);
    vm.runInContext('const assets = ' + variableText('scripts/verify-reviewer-read-boundaries.mjs', 'assets'), context);
    const snap = () => JSON.stringify(vm.runInContext('assets()', context)); const before = snap();
    fs.writeFileSync(join(root, '.proof-or-stop/activity.jsonl'), '{"allowed":"telemetry"}\n'); assert.equal(snap(), before);
    fs.writeFileSync(join(root, 'AGENTS.md'), 'changed'); assert.notEqual(snap(), before);
  });
  console.log(JSON.stringify({ groups, measurements, boundary: 'Desktop proof executes the actual generated materialization/bootstrap entry under Node, not the native pkg binary carrier. Existing correct behaviors are controls, not fabricated product RED. Lock wiring check is source binding; operational coverage is not inferred for other caller types.' }, null, 2));
  if (groups.some(g => !g.pass)) { console.error('CLI_AUDIT_RUNTIME_COVERAGE_RED'); process.exitCode = 1; } else console.log('CLI_AUDIT_RUNTIME_COVERAGE_GREEN');
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
