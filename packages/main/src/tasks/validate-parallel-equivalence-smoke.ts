/**
 * B-7dff CHK-004 — routine validate: parallel equals serial, with a MEASURED makespan.
 *
 * One process, one host, one run: the same plan is executed twice through the real
 * `executeValidationPlan` — once at jobs=1 (strict plan-order sequential, the
 * pre-scheduler behaviour) and once at jobs=N — and the two runs are compared.
 *
 * What it proves:
 *   1. HAPPY   — both modes produce commands[] of the SAME LENGTH in the SAME PLAN
 *      ORDER, and the printed line carries the serial / parallel / speedup numbers
 *      measured in this run. Nothing about the speedup is hardcoded: the parallel
 *      makespan is only ever compared against the serial makespan measured moments
 *      earlier on this machine.
 *   2. EDGE    — the per-command pass/fail verdicts (and exit codes) are IDENTICAL
 *      between the two modes. A single differing outcome fails the smoke. The
 *      comparator is then re-run against a deliberately mutated copy of the real
 *      parallel results, so an assertion that can no longer detect a difference
 *      fails here rather than passing vacuously.
 *   3. ADVERSARIAL — a resource collision is detected rather than being reported as
 *      a faster run. Two probes declare the SAME exclusive claim and must never
 *      overlap; the undeclared probe (fail-closed barrier) must overlap nobody.
 *      Overlap is observed from the CHILD PROCESSES themselves — each probe records
 *      the wall-clock interval it was alive — not inferred from the scheduler's own
 *      bookkeeping, which is the thing under test.
 *      NEGATIVE CONTROL: the same two probes are then run with DISJOINT claims, a
 *      plan in which overlapping them WOULD be wrong, and the same collision probe
 *      must report the overlap. Without this, "no collision observed" could equally
 *      mean "this probe cannot see a collision".
 *
 * Why a FIXTURE plan and not the real 104-command plan: the real plan takes 10-18
 * minutes per mode and this smoke is itself registered in validate.commands, so
 * running it here would make validate recursive and enormous. The fixture exercises
 * the same code path (`executeValidationPlan` → `canonicalizeEntries` → `runScheduled`)
 * with the same claim vocabulary in seconds. The real-plan makespan is measured by an
 * actual `proof-or-stop validate --json` run and recorded in the story's evidence, not here.
 *
 * Hermetic: projectRoot is a fresh mkdtemp directory, so every probe's cwd, marker
 * file and resource key lives outside the repository and no run touches repo state.
 *
 * Run: node packages/main/dist/tasks/validate-parallel-equivalence-smoke.js
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_VALIDATE_PLAN_JOBS,
  executeValidationPlan,
} from '../core/validation-executor.js';
import type {
  ValidationCommand,
  ValidationCommandResult,
  ValidationPlan,
  ValidationResult,
} from '../core/validation-types.js';

const NODE = process.execPath;
/**
 * How long each probe stays alive. Long enough that two genuinely concurrent
 * probes overlap by a margin far larger than any plausible process-startup skew
 * on a loaded host, short enough that the whole smoke stays in single digits of
 * seconds.
 */
const SLEEP_MS = 700;
const PARALLEL_JOBS = DEFAULT_VALIDATE_PLAN_JOBS;

let assertions = 0;
function check(name: string, condition: boolean): void {
  if (!condition) throw new Error(`FAIL: ${name}`);
  assertions += 1;
}

/** One fixture command: what it claims, how it exits. */
interface ProbeSpec {
  label: string;
  /** Resource key under the temp project root; null means DECLARE NOTHING (fail-closed barrier). */
  key: string | null;
  exitCode?: number;
  optional?: boolean;
}

/**
 * The fixture plan.
 *
 * - `declared A` / `declared B` / `failing F` hold distinct exclusive keys, so they
 *   are mutually compatible and may overlap.
 * - `conflict X` and `conflict Y` hold the SAME exclusive key: the scheduler must
 *   never admit them together.
 * - `barrier U` declares nothing, so it takes the exclusive fail-closed default and
 *   must overlap nothing at all.
 * - `failing F` exits non-zero on purpose, so the pass/fail comparison below is a
 *   comparison of a MIXED set and not of "everything passed" twice.
 *
 * Plan order deliberately interleaves the barrier into the middle, so completion
 * order in the parallel run is NOT plan order and the ordering assertion has
 * something to catch.
 */
const PROBES: ProbeSpec[] = [
  { label: 'declared A', key: 'probe-a' },
  { label: 'conflict X', key: 'contended' },
  { label: 'barrier U', key: null },
  { label: 'conflict Y', key: 'contended' },
  { label: 'declared B', key: 'probe-b' },
  { label: 'failing F', key: 'probe-f', exitCode: 3, optional: true },
];

const CONFLICT_LEFT = 'conflict X';
const CONFLICT_RIGHT = 'conflict Y';
const BARRIER = 'barrier U';

function slug(label: string): string {
  return label.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
}

/**
 * Build one probe command. The child records the interval it was ALIVE (a
 * timestamp taken at startup, another taken just before it exits) into its own
 * marker file — one file per probe, so two concurrent probes can never interleave
 * or clobber each other's record.
 */
function probeCommand(spec: ProbeSpec, runDir: string, keyOverride?: string | null): ValidationCommand {
  const marker = join(runDir, `${slug(spec.label)}.json`);
  const key = keyOverride === undefined ? spec.key : keyOverride;
  const script = [
    'const {writeFileSync}=require("fs");',
    'const start=Date.now();',
    'setTimeout(()=>{',
    `writeFileSync(${JSON.stringify(marker)},JSON.stringify({label:${JSON.stringify(spec.label)},start,end:Date.now()}));`,
    `process.exit(${spec.exitCode ?? 0});`,
    `},${SLEEP_MS});`,
  ].join('');
  return {
    label: spec.label,
    command: NODE,
    args: ['-e', script],
    timeoutMs: 60_000,
    ...(spec.optional ? { optional: true } : {}),
    // An undeclared command gets the exclusive fail-closed default from
    // resolveValidationCommandResources; declaring an empty array here would mean
    // the same thing, but leaving the field off is what a real plan entry looks like.
    ...(key ? { resources: [{ class: 'fixed-path' as const, key: `probes/${key}`, access: 'exclusive' as const }] } : {}),
  };
}

interface Interval { label: string; start: number; end: number }

/** Read back every probe's self-recorded alive interval for one run. */
function readIntervals(runDir: string, specs: ProbeSpec[]): Map<string, Interval> {
  const intervals = new Map<string, Interval>();
  for (const spec of specs) {
    const marker = join(runDir, `${slug(spec.label)}.json`);
    if (!existsSync(marker)) continue;
    const parsed = JSON.parse(readFileSync(marker, 'utf-8')) as Interval;
    intervals.set(parsed.label, parsed);
  }
  return intervals;
}

function overlapMs(a: Interval, b: Interval): number {
  return Math.min(a.end, b.end) - Math.max(a.start, b.start);
}

/** Every pair of probes observed alive at the same time, from the children's own clocks. */
function observedOverlaps(intervals: Map<string, Interval>): string[] {
  const found: string[] = [];
  const list = [...intervals.values()];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const overlap = overlapMs(list[i]!, list[j]!);
      if (overlap > 0) found.push(`${list[i]!.label} + ${list[j]!.label} (${overlap}ms)`);
    }
  }
  return found;
}

/**
 * The collision probe: for each pair that MUST NOT run together, report it when the
 * two were observed alive at the same instant. An empty result means no collision;
 * a non-empty one names the pair and the overlap, so a failure is diagnosable.
 */
function collisions(intervals: Map<string, Interval>, mustNotOverlap: [string, string][]): string[] {
  const found: string[] = [];
  for (const [left, right] of mustNotOverlap) {
    const a = intervals.get(left);
    const b = intervals.get(right);
    if (!a || !b) continue;
    const overlap = overlapMs(a, b);
    if (overlap > 0) found.push(`${left} overlapped ${right} by ${overlap}ms`);
  }
  return found;
}

/** Pairs the fixture plan's claims forbid: the contended pair, and the barrier against everyone. */
function forbiddenPairs(specs: ProbeSpec[]): [string, string][] {
  const pairs: [string, string][] = [[CONFLICT_LEFT, CONFLICT_RIGHT]];
  for (const spec of specs) {
    if (spec.label !== BARRIER) pairs.push([BARRIER, spec.label]);
  }
  return pairs;
}

const verdict = (result: ValidationCommandResult): string =>
  result.code === 0 && !result.timedOut ? 'pass' : 'fail';

/** Per-command outcome differences between two runs of the SAME plan. */
function verdictDifferences(serial: ValidationCommandResult[], parallel: ValidationCommandResult[]): string[] {
  const differences: string[] = [];
  if (serial.length !== parallel.length) {
    differences.push(`commands[] length ${serial.length} (serial) vs ${parallel.length} (parallel)`);
  }
  const byLabel = new Map(parallel.map((result) => [result.label, result]));
  for (const left of serial) {
    const right = byLabel.get(left.label);
    if (!right) { differences.push(`${left.label} missing from the parallel run`); continue; }
    if (verdict(left) !== verdict(right)) {
      differences.push(`${left.label}: ${verdict(left)} (serial) vs ${verdict(right)} (parallel)`);
    } else if (left.code !== right.code) {
      differences.push(`${left.label}: exit ${left.code} (serial) vs exit ${right.code} (parallel)`);
    }
  }
  return differences;
}

/** Where commands[] departs from the plan it was built from. */
function orderDifferences(plan: ValidationPlan, result: ValidationResult): string[] {
  const differences: string[] = [];
  if (result.commands.length !== plan.commands.length) {
    differences.push(`commands[] has ${result.commands.length} entries for a ${plan.commands.length}-command plan`);
  }
  plan.commands.forEach((command, index) => {
    const actual = result.commands[index];
    if (!actual) { differences.push(`no result at plan position ${index + 1} (${command.label})`); return; }
    if (actual.label !== command.label) {
      differences.push(`plan position ${index + 1} is ${actual.label}, expected ${command.label}`);
    }
  });
  return differences;
}

interface RunOutcome {
  result: ValidationResult;
  wallMs: number;
  intervals: Map<string, Interval>;
  plan: ValidationPlan;
  schedulerLine: string;
}

async function runFixture(
  projectRoot: string,
  name: string,
  specs: ProbeSpec[],
  jobs: number,
  keyOverrides: Map<string, string> = new Map(),
): Promise<RunOutcome> {
  const runDir = join(projectRoot, 'runs', name);
  mkdirSync(runDir, { recursive: true });
  const plan: ValidationPlan = {
    provider: `b7dff-parallel-equivalence-${name}`,
    commands: specs.map((spec) => probeCommand(spec, runDir, keyOverrides.get(spec.label))),
  };
  const startedAt = Date.now();
  // jobs is passed EXPLICITLY, never left to PROOF_OR_STOP_VALIDATE_JOBS: the whole point
  // is that the two runs differ in exactly one input, so an ambient env var must not
  // be able to make "serial" and "parallel" the same run.
  const result = await executeValidationPlan(plan, projectRoot, undefined, undefined, { jobs });
  const wallMs = Date.now() - startedAt;
  const schedulerLine = result.details.filter((line) => line.startsWith('validate scheduler:')).pop() ?? '';
  return { result, wallMs, intervals: readIntervals(runDir, specs), plan, schedulerLine };
}

const projectRoot = mkdtempSync(join(tmpdir(), 'b7dff-parallel-equivalence-'));

try {
  // Warm-up: one throwaway spawn so the first MEASURED run does not carry the
  // process/module cold start that the second one would not pay.
  await runFixture(projectRoot, 'warmup', [{ label: 'warmup', key: 'warmup' }], 1);

  // ── 1. The same plan, both ways, on this host, in this process ─────────────
  const serial = await runFixture(projectRoot, 'serial', PROBES, 1);
  const parallel = await runFixture(projectRoot, 'parallel', PROBES, PARALLEL_JOBS);

  const serialS = serial.wallMs / 1000;
  const parallelS = parallel.wallMs / 1000;
  const speedup = serial.wallMs / Math.max(1, parallel.wallMs);
  console.log(
    `validate-parallel-equivalence: serial=${serialS.toFixed(2)}s parallel=${parallelS.toFixed(2)}s `
    + `speedup=${speedup.toFixed(2)}x (${PROBES.length} commands, jobs 1 vs ${PARALLEL_JOBS}, `
    + `${SLEEP_MS}ms per probe)`,
  );
  console.log(`  serial   ${serial.schedulerLine}`);
  console.log(`  parallel ${parallel.schedulerLine}`);

  // Derived from PROBES, not written out: adding a probe must not silently
  // change what "the same plan" means in the comparison below.
  const declaredCount = PROBES.filter((spec) => spec.key !== null).length;
  const classification = `commands=${PROBES.length} declared=${declaredCount} exclusiveByDefault=${PROBES.length - declaredCount}`;
  check('the serial run reported jobs=1', serial.schedulerLine.includes('jobs=1'));
  check(`the parallel run reported jobs=${PARALLEL_JOBS}`, parallel.schedulerLine.includes(`jobs=${PARALLEL_JOBS}`));
  check(`both runs classified the same plan (${classification})`,
    serial.schedulerLine.includes(classification) && parallel.schedulerLine.includes(classification));
  // The only threshold is the serial makespan measured moments ago on this same
  // host. Nothing here encodes an expected speedup.
  check(`the parallel makespan (${parallel.wallMs}ms) is below the serial one (${serial.wallMs}ms)`,
    parallel.wallMs < serial.wallMs);
  console.log('VI-OK B7DFF-CHK004-MEASURED-MAKESPAN one run measured the same plan serially and in parallel and reported the speedup it observed');

  // ── 2. commands[] length and plan order, in BOTH modes ────────────────────
  const serialOrder = orderDifferences(serial.plan, serial.result);
  const parallelOrder = orderDifferences(parallel.plan, parallel.result);
  check(`the serial run returned the plan in plan order (${serialOrder.join('; ') || 'no differences'})`, serialOrder.length === 0);
  check(`the parallel run returned the plan in plan order (${parallelOrder.join('; ') || 'no differences'})`, parallelOrder.length === 0);
  check('both runs returned one result per plan command',
    serial.result.commands.length === PROBES.length && parallel.result.commands.length === PROBES.length);

  // ── 3. Identical per-command outcomes ─────────────────────────────────────
  const differences = verdictDifferences(serial.result.commands, parallel.result.commands);
  check(`per-command outcomes are identical between the two modes (${differences.join('; ') || 'no differences'})`,
    differences.length === 0);
  const failures = serial.result.commands.filter((command) => verdict(command) === 'fail').map((command) => command.label);
  // Without a real failure in the plan, "identical verdicts" would only be
  // comparing pass against pass and could not detect a lost failure.
  check(`the compared set is mixed, so equality is not trivially pass==pass (failed: ${failures.join(', ') || 'none'})`,
    failures.length === 1 && failures[0] === 'failing F');
  console.log('VI-OK B7DFF-CHK004-OUTCOMES-IDENTICAL every command produced the same pass/fail verdict and exit code in both modes');

  // NEGATIVE CONTROL for the comparator: flip one exit code in a copy of the REAL
  // parallel results and require the same comparator to report exactly that command.
  const mutated = parallel.result.commands.map((command) => (
    command.label === 'declared A' ? { ...command, code: 9 } : command
  ));
  const caughtDifference = verdictDifferences(serial.result.commands, mutated);
  check(`a differing outcome is CAUGHT, not silently accepted (caught: ${caughtDifference.join('; ') || 'nothing'})`,
    caughtDifference.length === 1 && caughtDifference[0]!.startsWith('declared A: pass (serial) vs fail (parallel)'));
  console.log('VI-OK B7DFF-CHK004-OUTCOME-DIFF-BITES a single differing per-command outcome is reported by the comparator rather than passing silently');

  // ── 4. No resource collision, observed from the children's own clocks ─────
  check('every probe in both runs recorded the interval it was alive',
    serial.intervals.size === PROBES.length && parallel.intervals.size === PROBES.length);
  check('each probe really occupied its slot (every interval is at least half the sleep)',
    [...parallel.intervals.values()].every((interval) => interval.end - interval.start >= SLEEP_MS / 2));

  const serialOverlaps = observedOverlaps(serial.intervals);
  check(`the jobs=1 run overlapped nothing (${serialOverlaps.join('; ') || 'no overlap'})`, serialOverlaps.length === 0);

  const parallelCollisions = collisions(parallel.intervals, forbiddenPairs(PROBES));
  check(`no forbidden pair overlapped in the parallel run (${parallelCollisions.join('; ') || 'no collision'})`,
    parallelCollisions.length === 0);
  // Vacuity guard: "nothing collided" is worthless if nothing ran together at all.
  const parallelOverlaps = observedOverlaps(parallel.intervals);
  check(`compatible probes DID overlap in the parallel run, so more than one worker was live (${parallelOverlaps.join('; ') || 'nothing overlapped'})`,
    parallelOverlaps.length > 0);
  console.log(`VI-OK B7DFF-CHK004-NO-COLLISION conflicting claims never overlapped while ${parallelOverlaps.length} compatible pair(s) did`);

  // ── 5. NEGATIVE CONTROL: the collision probe bites on a real overlap ───────
  //
  // Same two probes, same probe scripts, same detector — but declared on DISJOINT
  // keys, which is a plan in which overlapping them would be exactly the collision
  // the fixture forbids. The detector must report it. If this run came back clean,
  // section 4's "no collision" would be indistinguishable from a blind probe.
  const contended = PROBES.filter((spec) => spec.label === CONFLICT_LEFT || spec.label === CONFLICT_RIGHT);
  const control = await runFixture(projectRoot, 'collision-control', contended, 2, new Map([
    [CONFLICT_LEFT, 'control-left'],
    [CONFLICT_RIGHT, 'control-right'],
  ]));
  check('both control probes recorded an interval', control.intervals.size === 2);
  const caughtCollision = collisions(control.intervals, [[CONFLICT_LEFT, CONFLICT_RIGHT]]);
  check(`the collision probe CAUGHT the overlap it must catch (caught: ${caughtCollision.join('; ') || 'nothing'})`,
    caughtCollision.length === 1 && caughtCollision[0]!.startsWith(`${CONFLICT_LEFT} overlapped ${CONFLICT_RIGHT}`));
  check('the control run really was the same work, only with disjoint claims',
    control.result.commands.length === 2 && control.result.commands.every((command) => command.code === 0));
  console.log('VI-OK B7DFF-CHK004-COLLISION-PROBE-BITES the same probe reports an overlap when the two commands are allowed to overlap');

  console.log(`validate-parallel-equivalence: PASS (${assertions} assertions)`);
} finally {
  rmSync(projectRoot, { recursive: true, force: true });
}
