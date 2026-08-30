#!/usr/bin/env node
/**
 * B-7dff CHK-003 — `executeValidationPlan` on the shared keyed scheduler.
 *
 * The red harness (tests/red/red-B-7dff-sequential-validate-plan.mjs) proves the
 * plan can now OVERLAP two resource-disjoint commands. This file proves the four
 * properties that overlapping must not cost, because gates and receipts read
 * them:
 *
 *   1. PLAN ORDER. `commands[]` and `details[]` are emitted in plan order even
 *      when completion order is the exact reverse, and each entry still carries
 *      its own label / args / code / optional / durationMs.
 *   2. RUN-ALL. A failing command in the middle cancels nothing:
 *      `commands.length === plan.commands.length` and every later command
 *      really executed (each prints a marker, asserted present in its output).
 *   3. DEADLINE. An exceeded `deadlineAt` still THROWS the caller's deadline
 *      error; it never returns the partial run, and never returns it as a pass.
 *      An aborted `abortSignal` likewise cannot produce allPass.
 *   4. WORKER COUNT. Configurable through the `jobs` option and the
 *      PROOF_OR_STOP_VALIDATE_JOBS env var, refused when set to something unusable,
 *      reported in `details`, and `jobs=1` restores strict sequential
 *      execution — i.e. the parallelism is genuinely switchable, not implicit.
 *
 * Timing is only used where a claim is inherently about time (jobs=1 must not
 * overlap). Ordering claims are proven structurally, so they cannot flake.
 *
 * Every plan below passes `jobs` EXPLICITLY, so an operator running the whole
 * validate under `PROOF_OR_STOP_VALIDATE_JOBS=<n>` does not silently change what this
 * file asserts. The default itself is checked through `resolveValidatePlanJobs`
 * with an explicit env object instead.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const executorRel = 'packages/main/dist/core/validation-executor.js';
const executorPath = resolve(repoRoot, executorRel);

if (!existsSync(executorPath)) {
  console.error(`validate-plan-scheduling: missing build artifact ${executorPath}; run npm --prefix packages/main run build first`);
  process.exit(1);
}

const {
  DEFAULT_VALIDATE_PLAN_JOBS,
  executeValidationPlan,
  resolveValidatePlanJobs,
} = await import(pathToFileURL(executorPath).href);

let assertions = 0;
const ok = (message, condition = true) => {
  assert.ok(condition, message);
  assertions++;
};

const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-b7dff-chk003-'));

/**
 * A command that prints `marker`, optionally sleeps, and exits `code`. Each one
 * declares an EXCLUSIVE claim on its OWN key, so the entries are pairwise
 * disjoint and the scheduler is free to overlap them: anything that still comes
 * out in plan order below did so because the executor restored it, not because
 * the scheduler happened to serialize.
 */
const probe = (label, { sleepMs = 0, code = 0, optional = false, timeoutMs = 60_000 } = {}) => ({
  label,
  command: process.execPath,
  args: ['-e', `process.stdout.write('MARKER_${label}');setTimeout(() => process.exit(${code}), ${sleepMs})`],
  timeoutMs,
  ...(optional ? { optional: true } : {}),
  resources: [{ class: 'fixed-path', key: `probe-${label}`, access: 'exclusive' }],
});

const labelsOf = (result) => result.commands.map((command) => command.label);
const schedulerLine = (result) => result.details.filter((line) => line.startsWith('validate scheduler:')).at(-1);

try {
  // ── 1. PLAN ORDER, with completion order deliberately reversed ────────────
  const ordered = await executeValidationPlan({
    provider: 'b7dff-chk003-order',
    commands: [
      probe('alpha', { sleepMs: 900 }),
      probe('bravo', { sleepMs: 600 }),
      probe('charlie', { sleepMs: 300 }),
      probe('delta', { sleepMs: 10 }),
    ],
  }, root, 'HEAD-ORDER', undefined, { jobs: 4 });

  assert.deepEqual(labelsOf(ordered), ['alpha', 'bravo', 'charlie', 'delta']);
  // The first command is the slowest, so a completion-ordered array would be
  // exactly the reverse. Prove the durations really were inverted, otherwise
  // the ordering assertion above could be vacuous.
  const durations = ordered.commands.map((command) => command.durationMs);
  ok('B7DFF-CHK003-COMPLETION-ORDER-INVERTED completion order was the reverse of plan order', durations[0] > durations[3]);
  const detailOrder = ordered.details
    .filter((line) => /^[✓✗⚠] /.test(line))
    .map((line) => line.slice(2).split(':')[0]);
  assert.deepEqual(detailOrder, ['alpha', 'bravo', 'charlie', 'delta']);
  for (const command of ordered.commands) {
    assert.equal(command.code, 0);
    assert.equal(command.command, process.execPath);
    assert.equal(command.timeoutMs, 60_000);
    assert.match(command.output, new RegExp(`MARKER_${command.label}`));
    assert.ok(command.durationMs >= 0);
  }
  assert.equal(ordered.status, 'pass');
  assert.equal(ordered.allPass, true);
  assert.equal(ordered.headSha, 'HEAD-ORDER');
  assertions += 4;
  console.log('VI-OK B7DFF-CHK003-PLAN-ORDER commands[] and details[] are emitted in plan order while completion order is reversed');

  // ── 2. RUN-ALL: a failure in the middle cancels nothing ───────────────────
  const withFailure = await executeValidationPlan({
    provider: 'b7dff-chk003-run-all',
    commands: [
      probe('first'),
      probe('failing', { code: 7 }),
      probe('third'),
      probe('optional-failing', { code: 5, optional: true }),
      probe('last'),
    ],
  }, root, undefined, undefined, { jobs: 4 });

  assert.equal(withFailure.commands.length, 5);
  assert.deepEqual(labelsOf(withFailure), ['first', 'failing', 'third', 'optional-failing', 'last']);
  for (const command of withFailure.commands) {
    assert.match(command.output, new RegExp(`MARKER_${command.label}`), `${command.label} did not execute`);
  }
  assert.equal(withFailure.commands[1].code, 7);
  assert.equal(withFailure.commands[3].code, 5);
  assert.equal(withFailure.commands[3].optional, true);
  assert.equal(withFailure.status, 'fail');
  assert.equal(withFailure.allPass, false);
  assert.equal(withFailure.failureKind, 'validation_failure');
  assert.match(withFailure.warnings.join('\n'), /optional validation failed: optional-failing/);
  assertions += 9;
  console.log('VI-OK B7DFF-CHK003-RUN-ALL-COMPLETE a failing command cancels nothing: every plan command ran and commands[].length equals the plan length');

  // ── 3a. DEADLINE: exceeded deadlineAt throws, never returns a partial pass ─
  const deadlineError = new Error('B7DFF_CHK003_DEADLINE_SENTINEL');
  let deadlineOutcome = 'returned';
  try {
    const partial = await executeValidationPlan({
      provider: 'b7dff-chk003-deadline',
      commands: [probe('slow-a', { sleepMs: 5_000 }), probe('slow-b', { sleepMs: 5_000 })],
    }, root, undefined, undefined, {
      jobs: 4,
      deadlineAt: Date.now() - 1_000,
      deadlineError: () => deadlineError,
    });
    deadlineOutcome = `returned status=${partial.status} allPass=${partial.allPass}`;
  } catch (error) {
    deadlineOutcome = error === deadlineError ? 'threw-sentinel' : `threw-other:${error?.message}`;
  }
  assert.equal(deadlineOutcome, 'threw-sentinel', `exceeded deadline must raise the caller's deadline error, got: ${deadlineOutcome}`);
  assertions++;
  console.log('VI-OK B7DFF-CHK003-DEADLINE-THROWS an exceeded deadlineAt raises the caller deadline error instead of returning a partial run');

  // ── 3b. ABORT: an aborted signal reaches every concurrent command ──────────
  const controller = new AbortController();
  controller.abort();
  const aborted = await executeValidationPlan({
    provider: 'b7dff-chk003-abort',
    commands: [probe('abort-a', { sleepMs: 5_000 }), probe('abort-b', { sleepMs: 5_000 })],
  }, root, undefined, undefined, { jobs: 4, abortSignal: controller.signal });
  assert.equal(aborted.commands.length, 2);
  assert.equal(aborted.allPass, false);
  assert.equal(aborted.status, 'fail');
  assert.equal(aborted.failureKind, 'infra_failure');
  for (const command of aborted.commands) {
    assert.equal(command.timedOut, true, `${command.label} was not aborted`);
    assert.equal(command.code, 124);
  }
  assertions += 8;
  console.log('VI-OK B7DFF-CHK003-ABORT-NOT-PASS an aborted abortSignal reaches every concurrently scheduled command and cannot report a pass');

  // ── 4. WORKER COUNT: configurable, refused when unusable, reported ────────
  assert.equal(resolveValidatePlanJobs({}), DEFAULT_VALIDATE_PLAN_JOBS);
  assert.equal(DEFAULT_VALIDATE_PLAN_JOBS, 4);
  assert.equal(resolveValidatePlanJobs({ PROOF_OR_STOP_VALIDATE_JOBS: '7' }), 7);
  assert.equal(resolveValidatePlanJobs({ PROOF_OR_STOP_VALIDATE_JOBS: '  ' }), DEFAULT_VALIDATE_PLAN_JOBS);
  assert.equal(resolveValidatePlanJobs({ PROOF_OR_STOP_VALIDATE_JOBS: '99' }, 3), 3);
  for (const bad of ['0', '-2', 'abc', '2.5', '65']) {
    assert.throws(() => resolveValidatePlanJobs({ PROOF_OR_STOP_VALIDATE_JOBS: bad }), /PROOF_OR_STOP_VALIDATE_JOBS/, `PROOF_OR_STOP_VALIDATE_JOBS=${bad} must be refused`);
  }
  for (const bad of [0, -1, 2.5, 65]) {
    assert.throws(() => resolveValidatePlanJobs({}, bad), /jobs must be an integer/, `jobs=${bad} must be refused`);
  }
  assertions += 14;
  console.log('VI-OK B7DFF-CHK003-JOBS-CONFIGURABLE worker count comes from the jobs option or PROOF_OR_STOP_VALIDATE_JOBS, defaults to 4, and refuses an unusable value');

  const SLEEP_MS = 700;
  const sequentialStart = Date.now();
  const sequential = await executeValidationPlan({
    provider: 'b7dff-chk003-jobs-1',
    commands: [probe('seq-a', { sleepMs: SLEEP_MS }), probe('seq-b', { sleepMs: SLEEP_MS })],
  }, root, undefined, undefined, { jobs: 1 });
  const sequentialWallMs = Date.now() - sequentialStart;
  const sequentialSumMs = sequential.commands.reduce((total, command) => total + command.durationMs, 0);
  assert.deepEqual(labelsOf(sequential), ['seq-a', 'seq-b']);
  ok(
    `B7DFF-CHK003-JOBS-ONE-SEQUENTIAL jobs=1 did not overlap (wall ${sequentialWallMs}ms >= 90% of ${sequentialSumMs}ms summed)`,
    sequentialWallMs >= sequentialSumMs * 0.9,
  );
  assertions++;

  assert.equal(schedulerLine(sequential), 'validate scheduler: jobs=1 commands=2 declared=2 exclusiveByDefault=0');
  assert.equal(schedulerLine(ordered), 'validate scheduler: jobs=4 commands=4 declared=4 exclusiveByDefault=0');
  // The barrier default must still be visible in the report: an undeclared
  // command is counted as exclusiveByDefault, not as a declared one.
  const undeclared = await executeValidationPlan({
    provider: 'b7dff-chk003-undeclared',
    commands: [
      { label: 'bare-a', command: process.execPath, args: ['-e', 'process.exit(0)'] },
      probe('declared-b'),
    ],
  }, root, undefined, undefined, { jobs: 2 });
  assert.equal(schedulerLine(undeclared), 'validate scheduler: jobs=2 commands=2 declared=1 exclusiveByDefault=1');
  assert.equal(schedulerLine(undeclared), undeclared.details.at(-1), 'the scheduler line is appended last so details[0] stays the headline');
  assertions += 4;
  console.log('VI-OK B7DFF-CHK003-WORKER-COUNT-REPORTED details reports the worker count, the declared count and the fail-closed exclusive count');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`validate-plan-scheduling: PASS (${assertions} assertions)`);
