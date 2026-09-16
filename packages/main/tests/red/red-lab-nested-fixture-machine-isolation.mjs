#!/usr/bin/env node
/**
 * Lab regression: an isolated temporary-project fixture must own its own machine
 * admission registry, so a nested `validate` it launches never queues behind the
 * machine reservation its own ancestor already holds.
 *
 * The ancestor rule in validation-execution-lock is NOT relaxed by this witness.
 * Two negative controls prove it still refuses a genuinely deadlocking descendant,
 * both in the real machine registry and inside one isolated registry.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../../..');
const dist = path => pathToFileURL(join(root, path)).href;
const { withMachineValidationResources } = await import(dist('packages/main/dist/core/validation-execution-lock.js'));
const { createFixtureMachineEnvironment } = await import(dist('packages/main/dist/tasks/helpers/fixture-machine-environment.js'));

const RED = 'NESTED_FIXTURE_MACHINE_ISOLATION_RED';
const scratch = mkdtempSync(join(tmpdir(), 'nested-fixture-machine-isolation-'));
const failures = [];
const record = (label, detail) => { failures.push(`${label}: ${detail}`); console.log(`${RED} ${label}: ${detail}`); };

/** Run one child to completion, collecting its merged output. */
function runChild(argv, env = process.env) {
  return new Promise(done => {
    const child = spawn(process.execPath, argv, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('close', code => done({ code, output }));
  });
}

/** Hold the machine reservation exactly as a command executor does, then run `body`. */
const hold = (resources, body) => withMachineValidationResources(
  { root, workspaceRoot: root, command: 'nested-fixture-machine-isolation', resources, deadlineAt: Date.now() + 600000 },
  body,
);

// The declarations an official executor actually passes: `undefined` for a pinned
// verification command with no declared footprint, and the configured resources of
// `scripts/verify-process-fact-contract.mjs` for the ordinary validate path.
const ANCESTORS = [
  ['undeclared-ancestor', undefined],
  ['declared-ancestor', [{ class: 'git-common-dir', key: '.', access: 'shared' }]],
];

try {
  // TARGET: the real acceptance-closure fixture launches a nested CLI validate in a
  // temporary project. It must complete under an ancestor machine reservation.
  for (const [label, resources] of ANCESTORS) {
    const started = Date.now();
    const result = await hold(resources, () => runChild(['experiments/acceptance-closure/publication-lifecycle.mjs']));
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    if (result.code !== 0 || !result.output.includes('PUBLICATION_LIFECYCLE_GREEN')) {
      // The refusal is embedded in the fixture's JSON progress lines, so match the sentence itself.
      const refusal = /nested machine resource acquisition conflicts with an ancestor[^"\\\n]*/.exec(result.output)?.[0];
      record(`publication-lifecycle under ${label}`,
        `exit=${result.code} elapsed=${seconds}s ${refusal ? `refused: ${refusal}` : 'missing PUBLICATION_LIFECYCLE_GREEN'}`);
    } else {
      console.log(`PASS publication-lifecycle under ${label} (${seconds}s)`);
    }
  }

  // CONTROL 1: a descendant sharing the ancestor's machine registry and declaring
  // nothing would genuinely deadlock. It must still be refused, fast, without spawning.
  // CONTROL 2: the same pair inside one isolated registry must be refused identically,
  // proving an isolated namespace is a separate registry and not an ancestor-rule bypass.
  const controls = [
    ['control-shared-registry', undefined],
    ['control-isolated-registry', createFixtureMachineEnvironment()],
  ];
  for (const [label, fixture] of controls) {
    const marker = join(scratch, `${label}.leaf`);
    const worker = join(scratch, `${label}.mjs`);
    // The worker holds an undeclared reservation in whichever registry it runs in, then
    // asks its own child to run an undeclared validation command in that same registry.
    writeFileSync(worker, `import { withMachineValidationResources } from ${JSON.stringify(dist('packages/main/dist/core/validation-execution-lock.js'))};
import { spawn } from 'node:child_process';
const leaf = ${JSON.stringify(marker)};
const child = ${JSON.stringify(join(scratch, `${label}-child.mjs`))};
await withMachineValidationResources({ root: ${JSON.stringify(root)}, workspaceRoot: ${JSON.stringify(root)}, command: 'control-owner', resources: undefined, deadlineAt: Date.now() + 60000 }, async () => {
  const started = Date.now();
  const proc = spawn(process.execPath, [child], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', c => { out += c; });
  proc.stderr.on('data', c => { out += c; });
  const code = await new Promise(done => proc.once('close', done));
  console.log(JSON.stringify({ code, elapsedMs: Date.now() - started, out: out.slice(0, 400) }));
  if (code !== 0) process.exitCode = 4;
});
`);
    writeFileSync(join(scratch, `${label}-child.mjs`), `import { runValidationCommand } from ${JSON.stringify(dist('packages/main/dist/core/validation-executor.js'))};
try {
  await runValidationCommand({ label: 'control-leaf', command: process.execPath,
    args: ['-e', ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker)},'spawned')`)}], timeoutMs: 5000 }, ${JSON.stringify(root)});
  console.log('CONTROL_LEAF_ADMITTED');
  process.exitCode = 2;
} catch (error) {
  console.log('CONTROL_REFUSAL ' + error.message);
  process.exitCode = /conflicts with an ancestor/.test(error.message) ? 0 : 3;
}
`);
    const started = Date.now();
    const result = await runChild([worker], fixture ? fixture.env : process.env);
    const elapsed = Date.now() - started;
    if (result.code !== 0) record(label, `worker exit=${result.code} ${result.output.slice(0, 400)}`);
    else if (existsSync(marker)) record(label, 'a refused descendant still spawned its leaf command');
    else if (!result.output.includes('conflicts with an ancestor')) record(label, `missing ancestor refusal: ${result.output.slice(0, 400)}`);
    else console.log(`PASS ${label}: genuine ancestor deadlock still refused without spawning (${elapsed}ms)`);
    // A refused descendant must also leave no admission record behind.
    try { fixture?.cleanup(); } catch (error) { record(label, `isolated registry retained admission records: ${error.message}`); }
  }

  assert.deepEqual(failures, [], `${RED} ${failures.length} case(s) failed`);
  console.log('NESTED_FIXTURE_MACHINE_ISOLATION_PASS isolated fixture admitted under both ancestors; ancestor rule unchanged');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
