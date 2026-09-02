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
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tracerPath = resolve(fileURLToPath(new URL('../../src/core/validation-runtime-tracer.cjs', import.meta.url)));
const workDir = mkdtempSync(join(tmpdir(), 'tracer-transparency-smoke-'));
const traceFile = join(workDir, 'trace.jsonl');

const childScript = `
const { execFile, exec } = require('node:child_process');
const { promisify } = require('node:util');
const marker = process.env.SMOKE_MARKER;
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
  console.log('CHILD-OK promisify shape preserved');
}).catch(error => {
  console.error('BROKEN: ' + error.message);
  process.exit(1);
});
`;

const marker = `f473-${process.pid}`;
try {
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
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.stdout.write('validation runtime tracer promisify transparency smoke PASS\n');
