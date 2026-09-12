#!/usr/bin/env node

/**
 * Executable adapter for the story-aware validation verification intents.
 *
 * Every selector is backed by the source TypeScript smokes. This adapter does
 * not print a pass marker until both the ordinary core smoke and the replay /
 * mutation audit have exited successfully and the requested selector was
 * emitted by those assertions.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
const selectors = {
  'change-manifest': 'change manifest PASS',
  'dual-graph': 'delete and rename coverage PASS',
  'scope-escalation': 'scope escalation PASS',
  selection: 'complete ledger PASS',
  'selection-mutations': 'monotonicity PASS',
  'selection-fail-closed': 'fail-closed escalation PASS',
  'observe-equivalence': 'observe/full equivalence PASS',
  'trace-isolation': 'isolated observe telemetry PASS',
  'observe-mutations': 'observer mutation rejected',
  receipts: 'admissible per-command reuse PASS',
  'receipt-mutations': 'receipt rejection matrix PASS',
  'receipt-forgery': 'forged receipt rejected',
  'shadow-equivalence': 'shadow/full oracle equivalent',
  'shadow-rejections': 'shadow discrepancy reported',
  'shadow-false-negative': 'false negative detected',
  'test-gate': 'low-risk dynamic TEST PASS',
  'test-gate-escalation': 'mandatory full escalation PASS',
  'test-gate-mutations': 'authority mutations rejected',
  operations: 'safe recovery and rollback PASS',
  'operations-mutations': 'operations mutation rejected',
};
const selector = selectors[mode];
if (!selector) throw new Error(`unknown dynamic validation audit mode: ${mode || '<missing>'}`);

function runSourceTask(task) {
  const sourcePath = join(root, task);
  let result = spawnSync(process.env.BUN_BINARY || 'bun', [sourcePath], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  // Release verification must remain runnable on hosts without Bun. The build
  // emits the same registered task under dist, so an ENOENT launch (status
  // null) falls back to Node over that exact compiled task, never to a second
  // test implementation.
  if (result.status === null && result.error?.code === 'ENOENT' && !process.env.BUN_BINARY) {
    const compiledTask = task.replace('/src/', '/dist/').replace(/\.ts$/, '.js');
    result = spawnSync(process.execPath, [join(root, compiledTask)], {
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
const mutationOutput = runSourceTask('packages/main/src/tasks/story-aware-validation-mutation-smoke.ts');
if (!mutationOutput.includes('dynamic-validation mutation audit PASS')) throw new Error('mutation audit selector missing');
if (!mutationOutput.includes('replay classes: 30')) throw new Error('replay threshold selector missing');
if (!mutationOutput.includes(selector)) throw new Error(`requested selector missing: ${selector}`);

process.stdout.write(`${selector}\n`);
