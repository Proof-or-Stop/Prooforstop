/**
 * B-7dff F-002 — ON-DEMAND benchmark: the REAL configured validate plan, jobs=1 vs jobs=N.
 *
 * WHY THIS EXISTS
 * ---------------
 * `validate-parallel-equivalence-smoke.ts` (the gate-enforced regression registered in
 * `validate.commands`) measures a SYNTHETIC 6-command fixture. That is deliberate — it is
 * itself part of the plan, so it must stay in seconds — but it means the numbers it prints
 * describe the fixture, not the workload the story's speedup claim is about. This file is
 * the missing half: a repeatable command that measures the SAME plan `proof-or-stop validate`
 * actually runs, at jobs=1 and at jobs=N, on the tree it is invoked from.
 *
 * NOT PART OF `proof-or-stop validate`
 * ------------------------------
 * This is an ON-DEMAND benchmark. It is deliberately NOT registered in
 * `proof-or-stop.config.json` → `validate.commands`, and it must not be: it executes the whole
 * configured plan TWICE, which costs tens of minutes per invocation, and registering it
 * would make validate recursive (validate running a command that runs validate's own plan
 * twice) and enormous. It produces NO gate evidence and NO receipt of its own; it prints a
 * measurement. Run it by hand when you want to re-check the speedup claim:
 *
 *     npm run bench:validate-parallel                 # jobs=1 vs jobs=4 (default)
 *     npm run bench:validate-parallel -- --jobs=8     # jobs=1 vs jobs=8
 *     npm run bench:validate-parallel -- --plan-only  # classify the plan, run nothing
 *
 * WHAT IT MEASURES, AND HOW HONESTLY
 * ----------------------------------
 *  - The plan comes from `configuredValidationCommands`, the SAME reader the validate
 *    handler uses, so this cannot drift into measuring a different command list.
 *  - Both modes run through the real `executeValidationPlan`, spawning the real child
 *    processes, in one process on one host, back to back.
 *  - `jobs` is passed EXPLICITLY for both modes, so an ambient `PROOF_OR_STOP_VALIDATE_JOBS`
 *    cannot quietly make "serial" and "parallel" the same run.
 *  - The plan's `declared` / `exclusiveByDefault` (fail-closed barrier) counts are printed
 *    for the tree that was measured, because a speedup number is meaningless without the
 *    declaration coverage it was obtained at — the same plan at a different declared count
 *    is a different experiment.
 *  - ONE sample per mode is ONE sample. Repeat full-plan runs on this host have differed by
 *    roughly 28% at an unchanged jobs setting on an unchanged tree (781.3s vs 611.6s), which
 *    is a large fraction of the effect being measured. The output says so rather than
 *    presenting the ratio as a precise figure.
 *  - Ordering bias is disclosed, not hidden: the mode that runs FIRST pays whatever cold
 *    cost (npm/tsc caches, page cache, a cold `dist`) the second one does not. The default
 *    order is `parallel-first`, so that cost lands on the parallel run and the reported
 *    speedup is the conservative direction. `--order=serial-first` flips it.
 *
 * Exit code is 0 whenever both runs completed and were measured. Individual plan commands
 * failing does NOT fail the benchmark — a failing tree still has a wall time, and this is a
 * measurement, not a gate. The pass/fail tallies and any per-command verdict differences
 * between the two modes are printed so the reader can judge the sample.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_VALIDATE_PLAN_JOBS,
  executeValidationPlan,
  formatValidationProgressEvent,
  resolveValidationPlanEntries,
} from '../core/validation-executor.js';
import { configuredValidationCommands } from '../handlers/verifier.js';
import type {
  ValidationCommandResult,
  ValidationPlan,
  ValidationProgressEvent,
  ValidationResult,
} from '../core/validation-types.js';

/** Stable marker for the measured result line; grep this, not a line number. */
const MARKER = 'B7DFF-BENCH-REAL-PLAN-MEASURED';

/**
 * A previously observed spread between two full-plan runs on this host at an UNCHANGED
 * jobs setting and an unchanged tree. Quoted verbatim in the caveat so the reader can
 * compare the run-to-run noise against the effect the ratio below reports.
 */
const OBSERVED_SAME_MODE_SPREAD = { highS: 781.3, lowS: 611.6 } as const;

type Order = 'parallel-first' | 'serial-first';

const here = dirname(fileURLToPath(import.meta.url));
// dist/tasks -> dist -> packages/main -> packages -> repo root
const repoRoot = join(here, '..', '..', '..', '..');

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function parseJobs(): number {
  const raw = argValue('jobs');
  if (raw === undefined) return DEFAULT_VALIDATE_PLAN_JOBS;
  const jobs = Number(raw);
  // >= 2, not >= 1: "jobs=1 vs jobs=1" is not a comparison, and silently accepting it
  // would print a speedup of ~1.00x that looks like a finding about the scheduler.
  if (!Number.isInteger(jobs) || jobs < 2) {
    throw new Error(`--jobs must be an integer >= 2 (the serial side is fixed at jobs=1); got ${raw}`);
  }
  return jobs;
}

function parseOrder(): Order {
  const raw = argValue('order') ?? 'parallel-first';
  if (raw !== 'parallel-first' && raw !== 'serial-first') {
    throw new Error(`--order must be parallel-first or serial-first; got ${raw}`);
  }
  return raw;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Short HEAD + dirty-file count, so the printed number is attributable to a tree. */
function describeTree(): string {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      return null;
    }
  };
  const head = git(['rev-parse', '--short', 'HEAD']);
  // `--no-optional-locks` is a top-level git option and must precede the subcommand; it
  // suppresses the opportunistic index write so the probe cannot race an index.lock.
  const status = git(['--no-optional-locks', 'status', '--porcelain']);
  if (head === null) return 'tree=unknown (not a git worktree, or git unavailable)';
  const dirty = status === null ? 'unknown' : String(status.split('\n').filter(Boolean).length);
  return `tree=${head} dirtyFiles=${dirty}`;
}

const verdict = (result: ValidationCommandResult): string =>
  result.code === 0 && !result.timedOut ? 'pass' : 'fail';

/** Per-command outcome differences between the two modes of the SAME plan. */
function verdictDifferences(serial: ValidationCommandResult[], parallel: ValidationCommandResult[]): string[] {
  const differences: string[] = [];
  if (serial.length !== parallel.length) {
    differences.push(`commands[] length ${serial.length} (jobs=1) vs ${parallel.length} (parallel)`);
  }
  const byLabel = new Map(parallel.map((result) => [result.label, result]));
  for (const left of serial) {
    const right = byLabel.get(left.label);
    if (!right) { differences.push(`${left.label} missing from the parallel run`); continue; }
    if (verdict(left) !== verdict(right)) {
      differences.push(`${left.label}: ${verdict(left)} (jobs=1) vs ${verdict(right)} (parallel)`);
    }
  }
  return differences;
}

function progressReporter(mode: string): (event: ValidationProgressEvent) => void {
  // command_start is dropped: at ~100 commands x 2 modes it doubles the output without
  // adding anything the end line does not already carry. Timeouts and ends are kept so a
  // reader can see WHERE the wall time went, which is the whole point of the exercise.
  return (event) => {
    if (event.type === 'command_end' || event.type === 'command_timeout' || event.type === 'heartbeat') {
      console.log(`  [${mode}] ${formatValidationProgressEvent(event)}`);
    }
  };
}

interface ModeOutcome {
  jobs: number;
  wallMs: number;
  result: ValidationResult;
  schedulerLine: string;
  passed: number;
  failed: number;
}

async function runMode(plan: ValidationPlan, jobs: number): Promise<ModeOutcome> {
  const mode = `jobs=${jobs}`;
  console.log(`\nvalidate-parallel-benchmark: starting ${mode} over ${plan.commands.length} command(s)...`);
  const startedAt = Date.now();
  // storyId is deliberately omitted: this benchmark must not append dirty-gate audit rows
  // to any story's process-events.jsonl. It measures; it does not record.
  const result = await executeValidationPlan(plan, repoRoot, undefined, undefined, {
    jobs,
    progress: progressReporter(mode),
  });
  const wallMs = Date.now() - startedAt;
  const schedulerLine = result.details.filter((line) => line.startsWith('validate scheduler:')).pop() ?? '(no scheduler line)';
  const failed = result.commands.filter((command) => verdict(command) === 'fail').length;
  console.log(`validate-parallel-benchmark: ${mode} finished in ${seconds(wallMs)} (${schedulerLine})`);
  return { jobs, wallMs, result, schedulerLine, passed: result.commands.length - failed, failed };
}

const parallelJobs = parseJobs();
const order = parseOrder();
const planOnly = hasFlag('plan-only');

if (hasFlag('help')) {
  console.log([
    'validate-parallel-benchmark — ON-DEMAND: run the REAL configured validate plan at jobs=1 and jobs=N.',
    '',
    '  --jobs=<n>        parallel worker count (integer >= 2). Default: ' + DEFAULT_VALIDATE_PLAN_JOBS,
    '  --order=<order>   parallel-first (default) | serial-first — which mode runs first.',
    '  --plan-only       classify the configured plan and exit without executing anything.',
    '  --help            this text.',
    '',
    'NOT registered in proof-or-stop.config.json validate.commands, and must not be: it runs the whole',
    'plan twice (tens of minutes) and would make validate recursive. It produces no gate evidence.',
  ].join('\n'));
  process.exit(0);
}

const commands = configuredValidationCommands(repoRoot);
if (commands.length === 0) {
  console.error(
    'validate-parallel-benchmark: no configured validate.commands were found under '
    + `${repoRoot}; there is no real plan to measure.`,
  );
  process.exit(1);
}

const plan: ValidationPlan = {
  provider: 'b7dff-validate-parallel-benchmark',
  commands,
  warnings: [],
};

// Classify BEFORE running: the declared / barrier split is what the measured number belongs
// to, and at ~25 minutes per invocation it is worth printing up front rather than only at
// the end. `resolveValidationPlanEntries` is the same resolver the executor uses, so this
// cannot report a classification the run did not use.
const entries = resolveValidationPlanEntries(plan);
const barrierCount = entries.filter((entry) => entry.exclusiveByDefault).length;
const declaredCount = entries.length - barrierCount;
const classification = `commands=${entries.length} declared=${declaredCount} exclusiveByDefault=${barrierCount}`;

console.log('validate-parallel-benchmark: ON-DEMAND benchmark. NOT part of `proof-or-stop validate`:');
console.log('  it is deliberately NOT registered in proof-or-stop.config.json validate.commands (it runs the');
console.log('  whole plan twice, tens of minutes, and would make validate recursive), and it produces');
console.log('  NO gate evidence and no receipt — it prints a measurement.');
console.log(`  projectRoot=${repoRoot}`);
console.log(`  ${describeTree()}`);
console.log(`  plan: ${classification} (source: proof-or-stop.config.json validate.commands)`);
console.log(`  modes: jobs=1 vs jobs=${parallelJobs}, order=${order}`);

if (planOnly) {
  console.log('validate-parallel-benchmark: --plan-only, nothing executed.');
  process.exit(0);
}

const serial = order === 'serial-first' ? await runMode(plan, 1) : null;
const parallel = await runMode(plan, parallelJobs);
const serialOutcome = serial ?? await runMode(plan, 1);

const speedup = serialOutcome.wallMs / Math.max(1, parallel.wallMs);
const spreadPct = Math.round(
  ((OBSERVED_SAME_MODE_SPREAD.highS - OBSERVED_SAME_MODE_SPREAD.lowS) / OBSERVED_SAME_MODE_SPREAD.lowS) * 100,
);

console.log('');
console.log(
  `validate-parallel-benchmark: jobs=1=${seconds(serialOutcome.wallMs)} `
  + `jobs=${parallel.jobs}=${seconds(parallel.wallMs)} speedup=${speedup.toFixed(2)}x `
  + `(${classification}, order=${order})`,
);
console.log(`  jobs=1            ${serialOutcome.schedulerLine}`);
console.log(`  jobs=${parallel.jobs}            ${parallel.schedulerLine}`);
console.log(
  `  outcomes          jobs=1 ${serialOutcome.passed} passed / ${serialOutcome.failed} failed; `
  + `jobs=${parallel.jobs} ${parallel.passed} passed / ${parallel.failed} failed`,
);

const differences = verdictDifferences(serialOutcome.result.commands, parallel.result.commands);
console.log(
  differences.length === 0
    ? '  agreement         every command produced the same pass/fail verdict in both modes'
    : `  agreement         ${differences.length} command(s) differed between the modes: ${differences.join('; ')}`,
);

console.log('  CAVEAT            ONE sample per mode, back to back on one host, so this ratio carries the');
console.log(`                    host's run-to-run noise. Two full-plan runs on this host at an UNCHANGED`);
console.log(
  `                    jobs setting and unchanged tree have differed by ~${spreadPct}% `
  + `(${OBSERVED_SAME_MODE_SPREAD.highS}s vs ${OBSERVED_SAME_MODE_SPREAD.lowS}s).`,
);
console.log('                    Whichever mode ran first also paid the cold npm/tsc/page-cache cost the');
console.log('                    second did not. Treat the number as an order-of-magnitude observation,');
console.log('                    not a precise measurement; collect several samples before quoting it.');
console.log(
  `${MARKER} real configured plan measured at jobs=1 and jobs=${parallel.jobs} `
  + `on ${classification}: ${seconds(serialOutcome.wallMs)} vs ${seconds(parallel.wallMs)} = ${speedup.toFixed(2)}x`,
);
