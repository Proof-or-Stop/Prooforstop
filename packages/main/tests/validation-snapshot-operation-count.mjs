// Count top-level serialization of the captured baseline objects while executing
// the real shared validation path. The hook observes calls; it does not skip work.
import assert from 'node:assert/strict';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import cp from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = process.cwd();
let canonicalCounts = new WeakMap();
let baseline;
let inputs;
let hookMatches = 0;
globalThis.__snapshotCount = value => {
  if (value && typeof value === 'object') canonicalCounts.set(value, (canonicalCounts.get(value) ?? 0) + 1);
};
globalThis.__snapshotBaseline = (facts, files) => { baseline = facts; inputs = files; };
const hook = registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith('/core/shared-validation-execution.js')) return result;
  const source = String(result.source);
  const importToken = 'causalCanonical,';
  const baselineToken = 'const initial = probe();';
  assert.equal(source.split(importToken).length, 2, 'Canonical import observation must bind exactly once');
  assert.equal(source.split(baselineToken).length, 2, 'Baseline observation must bind exactly once');
  hookMatches++;
  return { ...result, source: source.replace(importToken, 'causalCanonical as originalCanonical,')
    .replace(baselineToken, baselineToken + '\nglobalThis.__snapshotBaseline(initial, inputFiles);')
    + '\nfunction causalCanonical(value) { globalThis.__snapshotCount(value); return originalCanonical(value); }\n' };
} });
const { runValidationCommand } = await import('../dist/core/validation-executor.js');
const { StoryStore } = await import('../dist/core/store.js');
const { acquireOwnerLease, releaseOwnerLease } = await import('../dist/core/story-owner-lease.js');
const { probeValidationCausalPreflightFacts } = await import('../dist/handlers/verifier.js');
const root = mkdtempSync(join(tmpdir(), 'snapshot-operation-count-'));
const oldCwd = process.cwd();
const originalExec = cp.execFileSync;
const git = args => originalExec('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
let store;
const storyId = 'B-snapshot-count';
try {
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Lab fixture']);
  git(['config', 'user.email', 'lab@example.invalid']);
  mkdirSync(join(root, 'packages/main'), { recursive: true });
  writeFileSync(join(root, 'packages/main/package.json'), readFileSync(join(repo, 'packages/main/package.json')));
  writeFileSync(join(root, 'package.json'), '{"name":"snapshot-count-fixture"}');
  writeFileSync(join(root, '.gitignore'), '.proof-or-stop/\n');
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: 'src' }));
  writeFileSync(join(root, 'witness.mjs'), 'console.log("REAL_SNAPSHOT_WITNESS");\n');
  git(['add', '.']); git(['commit', '-qm', 'fixed snapshot fixture']);
  process.chdir(root);
  store = new StoryStore(root);
  acquireOwnerLease(store.storyDirPath(storyId), { command: 'validate', cwd: root });
  const ctx = { root, store, scanRoot: root };
  const probe = input => probeValidationCausalPreflightFacts(ctx, storyId, input);
  const measureProbe = () => {
    let mergeBaseCalls = 0;
    cp.execFileSync = function (command, args, ...rest) {
      if (command === 'git' && args[0] === 'merge-base') mergeBaseCalls++;
      return originalExec.call(this, command, args, ...rest);
    };
    syncBuiltinESMExports();
    let facts;
    try { facts = probe({ command: 'node witness.mjs', cwd: root, timeoutMs: 10000 }); }
    finally { cp.execFileSync = originalExec; syncBuiltinESMExports(); }
    assert.equal(facts.gitMaterial.available, true);
    return { mergeBaseCalls, materialHash: facts.gitMaterial.materialHash };
  };
  const freshProbes = [measureProbe(), measureProbe()];
  console.log('MERGE_BASE_COUNTS ' + JSON.stringify(freshProbes));
  assert.deepEqual(freshProbes.map(row => row.mergeBaseCalls), [1, 1], 'ONE_MERGE_BASE_PER_FRESH_PROBE');
  const generated = join(root, '.proof-or-stop/generated');
  mkdirSync(generated, { recursive: true });
  const input = join(generated, 'input.txt');
  writeFileSync(input, 'stable');
  const command = { command: process.execPath, args: [join(root, 'witness.mjs')], executionReuse: 'exact-inputs', executionInputs: [input] };
  const context = { storyId, receiptStore: store, probe };
  const measurements = [];
  for (const phase of ['executed', 'reused']) {
    canonicalCounts = new WeakMap(); baseline = undefined; inputs = undefined;
    const start = performance.now();
    const result = await runValidationCommand(command, root, 10000, { sharedExecution: context });
    assert.equal(result.code, 0); assert.match(result.output, /REAL_SNAPSHOT_WITNESS/);
    assert.equal(result.executionReceipt?.disposition, phase);
    assert(baseline && inputs, 'Instrumentation must observe both actual baseline objects');
    measurements.push({ phase, initialSerializations: canonicalCounts.get(baseline) ?? 0,
      inputSerializations: canonicalCounts.get(inputs) ?? 0, ms: performance.now() - start });
  }
  assert.equal(hookMatches, 1);
  console.log('SNAPSHOT_OPERATION_COUNTS ' + JSON.stringify(measurements));
  // These controls run before the performance assertion, on both RED and GREEN.
  // A newly observed input must execute; neither snapshot strings nor old PASS
  // may be used as authority across calls.
  writeFileSync(input, 'changed');
  const changed = await runValidationCommand(command, root, 10000, { sharedExecution: context });
  assert.equal(changed.executionReceipt?.disposition, 'executed');
  const selfWriter = join(generated, 'writer.mjs');
  writeFileSync(selfWriter, "import {writeFileSync} from 'node:fs';writeFileSync(new URL('./input.txt',import.meta.url),'in-flight drift');console.log('CHILD_COMPLETED');");
  await assert.rejects(runValidationCommand({ ...command, args: [selfWriter], executionInputs: [generated] }, root, 10000,
    { sharedExecution: context }), /inputs changed|publication/);
  assert.equal(readFileSync(input, 'utf8'), 'in-flight drift');
  console.log('SNAPSHOT_DRIFT_CONTROLS_PASS');
  assert(measurements.every(row => row.initialSerializations === 1 && row.inputSerializations === 1),
    'INITIAL_SNAPSHOT_SERIALIZED_REPEATEDLY: baseline facts and input bytes must each be canonicalized once per invocation');
  console.log('SNAPSHOT_OPERATION_GREEN');
} finally {
  if (store) releaseOwnerLease(store.storyDirPath(storyId));
  process.chdir(oldCwd); cp.execFileSync = originalExec; syncBuiltinESMExports();
  hook.deregister(); delete globalThis.__snapshotCount; delete globalThis.__snapshotBaseline;
  rmSync(root, { recursive: true, force: true });
}
