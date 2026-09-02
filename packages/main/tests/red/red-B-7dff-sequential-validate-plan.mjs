#!/usr/bin/env node
/**
 * RED (repro-first) for B-7dff — executeValidationPlan must be able to run two
 * resource-disjoint commands CONCURRENTLY, not one after the other.
 *
 * Pre-fix, packages/main/src/core/validation-executor.ts runs the plan in a strict
 * sequential `for` loop (`for (let i = 0; i < plan.commands.length; i++) { await
 * runValidationCommand(...) }`), with no concurrency control anywhere on the routine
 * validate path. Measured consequence: a 99-102 command plan takes 858s wall, the sum
 * of every command, even though 78 of those commands finish in under 5s and only
 * quorum-submit-smoke.js (267-271s) is genuinely long.
 *
 * This red proves the defect behaviourally rather than structurally: two commands that
 * declare disjoint exclusive resource claims and each sleep SLEEP_MS must finish in
 * roughly SLEEP_MS wall, not 2 x SLEEP_MS. Pre-fix the observed wall time is the sum,
 * because the sequential loop never consults a claim at all. Post-fix (the plan runs
 * through the shared keyed scheduler with at least 2 workers) the same assertion passes
 * with no further change to this file.
 *
 * The threshold is deliberately loose (< 80% of the summed command time). It is not a
 * benchmark: it only has to separate "ran one after the other" from "ran together", and
 * it must not flake on a loaded host.
 *
 * Proof:
 *   1. Both commands actually ran and both passed (we are not measuring a broken plan).
 *   2. The summed per-command durationMs is at least 2 x SLEEP_MS (each really slept).
 *   3. Wall time is below 80% of that sum, which is only possible if they overlapped.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const executorPath = resolve(repoRoot, 'packages/main/dist/core/validation-executor.js');

if (!existsSync(executorPath)) {
  console.error(`red-B-7dff: missing build artifact ${executorPath}; run npm run build first`);
  process.exit(1);
}

const { executeValidationPlan } = await import(pathToFileURL(executorPath).href);

const SLEEP_MS = 1200;
// Each probe declares an EXCLUSIVE claim on its own distinct key, so the two are
// resource-disjoint and nothing may serialize them. Leaving them undeclared would be
// wrong: an undeclared command fails closed to a plan-wide barrier by design, so two
// undeclared commands must never overlap and this probe would be asserting against the
// safety default rather than against the sequential loop.
const sleeper = (label, key) => ({
  label,
  command: process.execPath,
  args: ['-e', `setTimeout(() => process.exit(0), ${SLEEP_MS})`],
  timeoutMs: 60_000,
  resources: [{ class: 'fixed-path', key: `.proof-or-stop/runtime/red-b7dff-probe-${key}`, access: 'exclusive' }],
});

const plan = {
  provider: 'red-B-7dff-concurrency-probe',
  commands: [sleeper('red-B-7dff sleeper A', 'a'), sleeper('red-B-7dff sleeper B', 'b')],
};

const startedAt = Date.now();
const result = await executeValidationPlan(plan, repoRoot);
const wallMs = Date.now() - startedAt;

// 1. Both commands ran and passed.
assert.equal(result.commands.length, 2, `expected 2 command results, got ${result.commands.length}`);
for (const command of result.commands) {
  assert.equal(command.code, 0, `${command.label} exited ${command.code}, expected 0`);
  assert.notEqual(command.timedOut, true, `${command.label} timed out`);
}
console.log('VI-OK 1/3 both probe commands ran and passed');

// 2. Each command really consumed SLEEP_MS, so the sum is real work and not a no-op.
const summedMs = result.commands.reduce((total, command) => total + command.durationMs, 0);
assert.ok(
  summedMs >= 2 * SLEEP_MS * 0.9,
  `summed command time ${summedMs}ms is below the ${2 * SLEEP_MS}ms the probes should have slept`,
);
console.log(`VI-OK 2/3 summed per-command time is ${summedMs}ms across 2 probes`);

// 3. The plan overlapped them. Pre-fix this is where the red fails: wall == sum.
const threshold = summedMs * 0.8;
assert.ok(
  wallMs < threshold,
  `executeValidationPlan ran the plan sequentially: wall ${wallMs}ms is not below ${Math.round(threshold)}ms `
  + `(80% of the ${summedMs}ms summed command time). Two commands with no conflicting resource claim `
  + `must be admitted concurrently.`,
);
console.log(`VI-OK 3/3 wall ${wallMs}ms is below the ${Math.round(threshold)}ms sequential floor`);

console.log('red-B-7dff-sequential-validate-plan PASS');
