#!/usr/bin/env node

/**
 * Executable adapter for the story-aware validation verification intents.
 *
 * Bun runs the source TypeScript smokes directly. On hosts without Bun, the
 * adapter first performs the canonical packages/main build, then runs the exact
 * emitted task with Node. It does not print a pass marker until both smokes and
 * the requested selector have completed successfully.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
const selectors = {
  'change-manifest': 'change manifest PASS',
  'dual-graph': 'delete and rename coverage PASS',
  'scope-escalation': 'generated-output full escalation PASS',
  selection: 'complete ledger PASS',
  'selection-mutations': 'monotonicity PASS',
  'selection-fail-closed': 'fail-closed escalation PASS',
  'observe-equivalence': 'observe/full equivalence PASS',
  'trace-isolation': 'unrelated receipt revocation isolation PASS',
  'observe-mutations': 'observer mutation rejected',
  receipts: 'admissible per-command reuse PASS',
  'receipt-mutations': 'receipt rejection matrix PASS',
  'receipt-forgery': 'forged receipt rejected',
  'shadow-equivalence': 'oracle equivalence replay PASS',
  'shadow-rejections': 'oracle discrepancy replay PASS',
  'shadow-false-negative': 'false negative detected',
  'test-gate': 'low-risk dynamic TEST PASS',
  'test-gate-escalation': 'mandatory full escalation PASS',
  'test-gate-mutations': 'authority mutations rejected',
  operations: 'valid two-command schedule PASS',
  'operations-mutations': 'operations mutation rejected',
};
const selector = selectors[mode];
if (!selector) throw new Error(`unknown dynamic validation audit mode: ${mode || '<missing>'}`);

function runSourceTask(task, taskArgs = []) {
  const sourcePath = join(root, task);
  let result = spawnSync(process.env.BUN_BINARY || 'bun', [sourcePath, ...taskArgs], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  // Release verification must remain runnable on hosts without Bun. The build
  // emits the same registered task under dist, so an ENOENT launch (status
  // null) falls back to Node over that exact compiled task, never to a second
  // test implementation.
  if (result.status === null && result.error?.code === 'ENOENT') {
    const build = spawnSync('npm', ['--prefix', 'packages/main', 'run', 'build'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (build.status !== 0) {
      process.stdout.write(`${build.stdout || ''}${build.stderr || ''}`);
      throw new Error('Node fallback refused because the canonical packages/main build failed');
    }
    const compiledTask = task.replace('/src/', '/dist/').replace(/\.ts$/, '.js');
    process.stdout.write(`dynamic-validation-audit runtime=node compiledArtifact=${compiledTask} freshness=canonical-build\n`);
    result = spawnSync(process.execPath, [join(root, compiledTask), ...taskArgs], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  }
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status !== 0) {
    process.stdout.write(output);
    throw new Error(`${task} exited with ${result.status}`);
  }
  return output;
}

const coreOutput = runSourceTask('packages/main/src/tasks/story-aware-validation-smoke.ts');
if (!coreOutput.includes('story-aware-validation smoke passed')) throw new Error('core smoke selector missing');
const mutationOutput = runSourceTask('packages/main/src/tasks/story-aware-validation-mutation-smoke.ts', [`--audit-mode=${mode}`]);
if (!mutationOutput.includes('dynamic-validation mutation audit PASS')) throw new Error('mutation audit selector missing');
if (!mutationOutput.includes('replay classes: 30')) throw new Error('replay threshold selector missing');
if (!mutationOutput.includes(`DYNAMIC_VALIDATION_ASSERTION:${mode}:${selector}`)) {
  throw new Error(`requested assertion marker missing: ${mode}`);
}

// Gate modes require both layers: the complete core/mutation smokes above must
// pass first; this in-process fixture then proves the resulting signed evidence
// crosses the real TEST/DONE gates. The public selector is emitted by this
// adapter only after both layers complete, never trusted from a tail marker.
if (mode === 'test-gate' || mode === 'test-gate-mutations') {
  const build = spawnSync('npm', ['--prefix', 'packages/main', 'run', 'build'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (build.status !== 0) {
    process.stdout.write(`${build.stdout || ''}${build.stderr || ''}`);
    throw new Error('dynamic TEST/DONE fixture refused stale dist because the canonical packages/main build failed');
  }
  await import('./verify-dynamic-test-admission.mjs');
}

process.stdout.write(`${selector}\n`);
