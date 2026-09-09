#!/usr/bin/env node
/**
 * B-45a0 F-473 regression smoke: the validation runtime tracer's
 * child_process wrappers must be transparent to util.promisify.
 *
 * exec/execFile carry a util.promisify.custom symbol property so that
 * util.promisify(execFile) resolves {stdout, stderr}. A bare wrapper drops
 * that own property and traced descendants silently fall back to generic
 * promisify, which resolves the bare stdout STRING — destructuring
 * {stdout} then yields undefined and downstream .split() throws
 * (observed: run-proofstory-acceptance-rollout-cohort.mjs aborting the
 * root full suite 0/58 under done_required_validate).
 *
 * This smoke spawns a fresh node child with the tracer preloaded via
 * NODE_OPTIONS (the same injection path validation-executor uses) and
 * asserts BOTH properties:
 *   1. promisify(execFile) / promisify(exec) still resolve an object with
 *      string stdout/stderr under the tracer (transparency), and
 *   2. the tracer still records the spawned command in its sidecar
 *      fragment (the descriptor copy did not disable tracing).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const tracerPath = resolve(fileURLToPath(new URL('../../src/core/validation-runtime-tracer.cjs', import.meta.url)));
const workDir = mkdtempSync(join(tmpdir(), 'tracer-transparency-smoke-'));
const traceFile = join(workDir, 'trace.jsonl');
const firstRead = join(workDir, 'first.txt');
const secondRead = join(workDir, 'second.txt');
const firstModule = join(workDir, 'first.cjs');
const secondModule = join(workDir, 'second.cjs');

const childScript = `
const { execFile, exec, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const marker = process.env.SMOKE_MARKER;
fs.readFileSync(${JSON.stringify(firstRead)});
fs.readFileSync(${JSON.stringify(firstRead)});
fs.readFileSync(${JSON.stringify(secondRead)});
require(${JSON.stringify(firstModule)});
require(${JSON.stringify(firstModule)});
require(${JSON.stringify(secondModule)});
void process.env.TRACE_ORDER_FIRST;
void process.env.TRACE_ORDER_FIRST;
void process.env.TRACE_ORDER_SECOND;
spawnSync(process.execPath, ['-e', '']);
spawnSync(process.execPath, ['-e', '']);
Promise.all([
  promisify(execFile)(process.execPath, ['-e', 'console.log("execfile-" + process.env.SMOKE_MARKER)']),
  promisify(exec)(JSON.stringify(process.execPath) + ' -e "console.log(\\'exec-\\' + process.env.SMOKE_MARKER)"'),
]).then(([fileResult, execResult]) => {
  if (typeof fileResult !== 'object' || typeof fileResult.stdout !== 'string' || typeof fileResult.stderr !== 'string') {
    console.error('BROKEN: promisify(execFile) resolved ' + typeof fileResult);
    process.exit(1);
  }
  if (!fileResult.stdout.includes('execfile-' + marker)) {
    console.error('BROKEN: execFile stdout missing marker: ' + fileResult.stdout);
    process.exit(1);
  }
  if (typeof execResult !== 'object' || typeof execResult.stdout !== 'string' || !execResult.stdout.includes('exec-' + marker)) {
    console.error('BROKEN: promisify(exec) resolved ' + typeof execResult);
    process.exit(1);
  }
  console.log('CHILD-OK promisify shape preserved pid=' + process.pid);
}).catch(error => {
  console.error('BROKEN: ' + error.message);
  process.exit(1);
});
`;

const marker = `f473-${process.pid}`;
try {
  for (const file of [firstRead, secondRead]) writeFileSync(file, 'trace read fixture\n');
  for (const file of [firstModule, secondModule]) writeFileSync(file, 'module.exports = {};\n');
  const result = spawnSync(process.execPath, ['-e', childScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_OPTIONS: `--require ${tracerPath}`,
      PROOF_OR_STOP_RUNTIME_TRACE_FILE: traceFile,
      SMOKE_MARKER: marker,
    },
  });

  assert.equal(result.status, 0, `traced child failed (exit ${result.status}): ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /CHILD-OK promisify shape preserved/, `missing child pass marker: ${result.stdout}${result.stderr}`);

  // The wrapper must still trace after the descriptor copy: at least one
  // sidecar fragment records the spawned node executable.
  const fragments = readdirSync(workDir).filter(name => name.startsWith('trace.jsonl.') && name.endsWith('.json'));
  assert.ok(fragments.length > 0, `tracer wrote no sidecar fragments in ${workDir}`);
  const spawned = fragments.flatMap(name => {
    const parsed = JSON.parse(readFileSync(join(workDir, name), 'utf8')) as { spawnedPaths?: string[] };
    return parsed.spawnedPaths ?? [];
  });
  assert.ok(spawned.includes(process.execPath), `tracer sidecars did not record the spawned executable: ${JSON.stringify(spawned)}`);
  const parentPid = Number(result.stdout.match(/CHILD-OK promisify shape preserved pid=(\d+)/)?.[1]);
  const parent = fragments.map(name => JSON.parse(readFileSync(join(workDir, name), 'utf8')))
    .find(fragment => fragment.pid === parentPid) as Record<string, unknown> | undefined;
  assert.ok(parent, 'the actual preloaded parent tracer must emit its own sidecar');
  for (const category of ['readPaths', 'loadedPaths', 'spawnedPaths', 'registryKeys', 'environmentKeys', 'events']) {
    const values: unknown = parent[category];
    assert.ok(Array.isArray(values), `${category}: trace output must remain an array`);
    assert.ok(values.every(value => typeof value === 'string' && value.length > 0), `${category}: invalid trace value`);
    assert.equal(new Set(values).size, values.length, `${category}: duplicated trace output`);
  }
  for (const [category, expected] of [
    ['readPaths', [firstRead, secondRead]],
    ['loadedPaths', [realpathSync(firstModule), realpathSync(secondModule)]],
    ['registryKeys', [realpathSync(firstModule), realpathSync(secondModule)]],
    ['environmentKeys', ['TRACE_ORDER_FIRST', 'TRACE_ORDER_SECOND']],
  ] as const) {
    assert.deepEqual((parent[category] as string[]).filter(value => (expected as readonly string[]).includes(value)), expected,
      `${category}: first-observation order or duplicate suppression changed`);
  }
  assert.equal((parent.spawnedPaths as string[]).filter(value => value === process.execPath).length, 1,
    'repeated real spawns must keep exactly one executable observation');
  assert.deepEqual((parent.spawnedPaths as string[]).filter(value => value === process.execPath || value === '-e'),
    [process.execPath, '-e'], 'spawned command and argv must retain first-observation order');
  assert.deepEqual(parent.events, ['tracer-loaded'], 'initial events must remain unchanged');
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.stdout.write('validation runtime tracer promisify transparency smoke PASS\n');

// Execute the actual private source kernel, not a duplicate optimized helper.
// Keep a simple independent reference for the original observable array behavior.
const tracerSource = readFileSync(tracerPath, 'utf8');
const kernelStart = tracerSource.indexOf('const trace = {');
const kernelEnd = tracerSource.indexOf('const pathArg =');
assert.ok(kernelStart >= 0 && kernelEnd > kernelStart, 'actual tracer membership kernel anchors drifted');
const { add } = runInNewContext(`${tracerSource.slice(kernelStart, kernelEnd)}; ({ add });`) as {
  add: (list: string[], value: unknown) => void;
};
const reference = (list: string[], value: unknown) => {
  if (typeof value !== 'string' || value.length === 0) return;
  if (!list.includes(value)) list.push(value);
};
const input: unknown[] = [undefined, null, false, 0, {}, [], '', 'Ω', 'Ω', 'a', 'a', 'é', 'e\u0301', ' ', '\0', 'seed'];
for (const initial of [[], ['seed'], ['seed', 'seed']]) {
  const actual = [...initial];
  const expected = [...initial];
  const originalIdentity = actual;
  for (const value of input) {
    add(actual, value);
    reference(expected, value);
    assert.strictEqual(actual, originalIdentity, 'membership optimization must retain the original array');
    assert.deepEqual(actual, expected, 'trace kernel changed original insertion/filter semantics');
  }
}
const firstList: string[] = [];
const secondList: string[] = [];
add(firstList, 'shared');
add(secondList, 'shared');
assert.deepEqual(firstList, secondList, 'membership must be isolated by list identity');

// A deterministic cost control: observe the actual kernel's lookup primitive,
// rather than a wall-clock threshold affected by machine load.
let linearLookups = 0;
const observed: string[] = [];
Object.defineProperty(observed, 'includes', { value(value: string) {
  linearLookups++;
  return Array.prototype.includes.call(this, value);
} });
for (let index = 0; index < 2048; index++) add(observed, `observed-path-${index}`);
for (let index = 0; index < 2048; index++) add(observed, `observed-path-${index}`);
assert.equal(observed.length, 2048, 'cost control must still record every distinct observation');
assert.equal(linearLookups, 0, 'actual tracer membership must not linearly scan the growing trace array');
process.stdout.write('validation runtime tracer exact ordered membership and bounded lookup smoke PASS\n');
