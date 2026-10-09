#!/usr/bin/env node
/**
 * Cost + golden smoke for `proof-or-stop next --storyId=<id>` (handlers/next-driver.ts).
 *
 * The owner agent calls `next` after every step, so its own cost is on the
 * critical path. This smoke drives scenario NF of e2e-review-to-done-smoke
 * (D's flow from REVIEW entry driven only by `next`, with two round-1 findings:
 * inventory critic -> remediation DEV -> ONE grouped finding repair -> ONE batched resolve of
 * both findings -> round 2 -> PRE_CERT -> TEST rows -> DONE), and at every quiet
 * state (no detached managed run in
 * flight) runs one decision in two fresh probe processes on the same fixture:
 *   - `reference`: the frozen pre-optimization driver (helpers/next-driver-reference.ts);
 *   - `new`: the live createNextDriver.
 * It requires
 *   1. golden: the live NextStep deep-equals the reference NextStep, and both
 *      equal what the real CLI `next --json` printed for that state;
 *   2. cost: the child processes one live decision spawns stay within the
 *      budget of its phase, and identical commands are not repeated inside
 *      one decision (only the decision is counted, not CLI boot).
 * The reference shares the core gate modules with the live driver, so its
 * column shows the driver-level difference only; the pre-optimization numbers
 * are recorded next to SPAWN_BUDGET. NEXT_DRIVER_COST_PROFILE=<file.jsonl>
 * appends each probe's commands with duration and dist call stack.
 *
 * Usage: node packages/main/dist/tasks/next-driver-cost-smoke.js
 *        (internal) ... --probe new|reference <storyId>   from the Story worktree
 */
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

/**
 * Max child processes one live decision may spawn, per phase group. Measured on
 * this fixture (max per group): before one-observation decisions DEV 75,
 * REVIEW 221, PRE_CERT 257, TEST 394; after DEV 22, REVIEW 83, PRE_CERT 124,
 * TEST 161. What remains is the gates' own first-consulted predicate (the
 * review verdict's per-pass lineage walk), not repeated probes.
 */
const SPAWN_BUDGET: Record<string, number> = {
  // Old-PoS run 34: finding_resolve_batch is a framework step whose decision pre-checks
  // each repaired finding's cited change (resolutionCitationRefusal: 3 git reads per
  // finding), so next never proposes a resolve its gate refuses; it replaces an owner
  // turn (re-reading findings and diffs, about 1.4M tokens): 35 on this fixture.
  DEV: 40,
  REVIEW: 100,
  PRE_CERT: 150,
  TEST: 200,
};

/** Max repeated identical child commands inside one live decision (before: up to 244; after: <= 21). */
const DUPLICATE_BUDGET = 25;

/** PRE_CERT is the REVIEW-phase certification stretch: cheap check -> begin -> routine suite -> TEST entry. */
const PRE_CERT_REASONS = new Set(['precert_cheap_check', 'certification_begin', 'routine_validation', 'enter_test', 'routine_validation_not_admissible']);

function groupOf(phase: string, reason: string): string {
  if (phase === 'REVIEW' && (PRE_CERT_REASONS.has(reason) || reason.startsWith('precert_'))) return 'PRE_CERT';
  return phase;
}

interface ProbeResult { step: Record<string, unknown>; spawns: number; ms: number; commands: string[] }

async function probe(mode: string, storyId: string): Promise<void> {
  // Receipts bind the execution implementation, whose runtime part digests the
  // entrypoint (process.argv[1]); decide as the real CLI entry would.
  process.argv[1] = realpathSync(fileURLToPath(new URL('../cli.js', import.meta.url)));
  const require = createRequire(import.meta.url);
  const cp = require('node:child_process') as Record<string, (...args: unknown[]) => unknown>;
  const commands: string[] = [];
  const profile: Array<{ command: string; ms: number; stack: string[] }> = [];
  const profiling = Boolean(process.env.NEXT_DRIVER_COST_PROFILE);
  if (profiling) Error.stackTraceLimit = 80;
  let counting = false;
  for (const name of ['spawnSync', 'execFileSync', 'execSync', 'spawn', 'execFile', 'exec']) {
    const original = cp[name]!;
    cp[name] = function patched(this: unknown, file: unknown, args: unknown, ...rest: unknown[]) {
      if (!counting) return original.call(this, file, args, ...rest);
      const command = [String(file), ...(Array.isArray(args) ? args.map(String) : [])].join(' ').slice(0, 240);
      commands.push(command);
      if (!profiling) return original.call(this, file, args, ...rest);
      const started = performance.now();
      try { return original.call(this, file, args, ...rest); } finally {
        const stack = (new Error().stack ?? '').split('\n').slice(2).map(row => row.trim().replace(/^at /, ''))
          .filter(row => row.includes('/dist/') && !row.includes('next-driver-cost-smoke')).map(row => row.replace(/.*\/dist\//, '').replace(/\)$/, '')).slice(0, 40);
        profile.push({ command, ms: Math.round(performance.now() - started), stack });
      }
    };
  }
  syncBuiltinESMExports();
  const root = realpathSync(process.cwd());
  const { StoryStore } = await import('../core/store.js');
  const { loadConfig } = await import('../core/config.js');
  const { createMainRegistry } = await import('../registry.js');
  const { withValidationSigningRoot } = await import('../core/validation-signing-context.js');
  const { createNextDriver } = await import('../handlers/next-driver.js');
  const { createReferenceNextDriver } = await import('./helpers/next-driver-reference.js');
  const ctx = { store: new StoryStore(root), root, scanRoot: join(root, loadConfig(root).scanRoot) };
  const registry = createMainRegistry(ctx);
  const lookup = (name: string) => registry.get(name);
  const driver = mode === 'reference' ? createReferenceNextDriver(ctx, lookup) : createNextDriver(ctx, lookup);
  const started = performance.now();
  counting = true;
  const step = withValidationSigningRoot(root, () => driver.decide(storyId));
  counting = false;
  const result: ProbeResult = { step: step as unknown as Record<string, unknown>, spawns: commands.length, ms: Math.round(performance.now() - started), commands };
  if (profiling) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.NEXT_DRIVER_COST_PROFILE!, `${JSON.stringify({ mode, reason: (step as { reason: string }).reason, phase: (step as { phase: string }).phase, ms: result.ms, profile })}\n`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

interface StateRecord { reason: string; group: string; refSpawns: number; newSpawns: number; refMs: number; newMs: number }

async function main(): Promise<void> {
  const { Owner, devSetup, driveWithNext } = await import('./e2e-review-to-done-smoke.js');
  const { createFixtureMachineEnvironment } = await import('./helpers/fixture-machine-environment.js');
  const machine = createFixtureMachineEnvironment();
  const records: StateRecord[] = [];
  const failures: string[] = [];
  const started = Date.now();
  const o = new Owner('NDC', 'B-e2e9', machine.env, [], false, { trackedGateFailureCounts: true });
  let passed = false;
  let groupedRepairSeen = false;
  let batchResolveSeen = false;
  try {
    devSetup(o);
    const lines: string[] = [];
    // Deliberate golden change (adopt-grouped-remediation): the fixture has TWO
    // round-1 findings (was one, scenario ND) so the golden covers the grouped
    // finding repair that remediation.grouping=single made the production
    // default, and the per-finding resolve of each member after it.
    driveWithNext(o, { findingRound1: true, run: false, twoFindings: true }, lines, (next, quiet) => {
      if (next.cli?.command === 'host_run' && next.reason === 'finding_repair' && Array.isArray(next.cli.payload.groupFindingIds)) groupedRepairSeen = true;
      // Deliberate golden change (critic-final-and-batch-resolve, old-PoS run 24 F4):
      // after the grouped repair both findings close in ONE batched finding_resolve.
      if (next.reason === 'finding_resolve_batch' && Array.isArray(next.cli?.payload.resolutions)) batchResolveSeen = true;
      if (next.done || !quiet) return;
      const run = (mode: string): ProbeResult => {
        const ran = o.node([SELF, '--probe', mode, o.storyId]);
        assert.equal(ran.status, 0, `probe ${mode} failed at ${next.reason}:\n${ran.out.slice(-3000)}`);
        return JSON.parse(ran.stdout.trim().split('\n').at(-1)!) as ProbeResult;
      };
      const reference = run('reference');
      const live = run('new');
      assert.deepEqual(live.step, reference.step, `golden: live next differs from the reference at ${next.reason}`);
      assert.deepEqual(reference.step, next, `golden: the CLI next --json differs from the reference decision at ${next.reason}`);
      const group = groupOf(next.phase, next.reason);
      records.push({ reason: next.reason, group, refSpawns: reference.spawns, newSpawns: live.spawns, refMs: reference.ms, newMs: live.ms });
      const budget = SPAWN_BUDGET[group];
      const duplicates = live.commands.length - new Set(live.commands).size;
      if (budget !== undefined && live.spawns > budget) failures.push(`${group} ${next.reason}: ${live.spawns} spawns > budget ${budget}`);
      if (duplicates > DUPLICATE_BUDGET) failures.push(`${group} ${next.reason}: ${duplicates} repeated identical commands > budget ${DUPLICATE_BUDGET}`);
      if (process.env.NEXT_DRIVER_COST_VERBOSE && (live.spawns > (budget ?? Infinity) || duplicates > DUPLICATE_BUDGET)) {
        console.log(`--- ${next.reason} live spawns:\n  ${live.commands.join('\n  ')}`);
      }
    });
    for (const line of lines) console.log(line);
    passed = true;
  } finally {
    if (passed) o.cleanup(); else console.log(`fixture retained for diagnosis: ${o.root}`);
    try { machine.cleanup(); } catch (error) { console.log(String(error)); }
  }

  console.log(`\n${'state (step next returned)'.padEnd(40)} ${'group'.padEnd(8)} ${'ref spawns'.padStart(10)} ${'new spawns'.padStart(10)} ${'ref ms'.padStart(7)} ${'new ms'.padStart(7)}`);
  for (const r of records) {
    console.log(`${r.reason.padEnd(40)} ${r.group.padEnd(8)} ${String(r.refSpawns).padStart(10)} ${String(r.newSpawns).padStart(10)} ${String(r.refMs).padStart(7)} ${String(r.newMs).padStart(7)}`);
  }
  console.log('\nper phase group (max / total spawns, total ms; reference -> live):');
  for (const group of ['DEV', 'REVIEW', 'PRE_CERT', 'TEST']) {
    const rows = records.filter(r => r.group === group);
    if (!rows.length) { failures.push(`${group}: no quiet state observed (fixture no longer covers this phase)`); continue; }
    const sum = (pick: (r: StateRecord) => number) => rows.reduce((total, r) => total + pick(r), 0);
    console.log(`  ${group.padEnd(8)} states=${rows.length} max ${Math.max(...rows.map(r => r.refSpawns))} -> ${Math.max(...rows.map(r => r.newSpawns))} (budget ${SPAWN_BUDGET[group]}), total ${sum(r => r.refSpawns)} -> ${sum(r => r.newSpawns)}, ms ${sum(r => r.refMs)} -> ${sum(r => r.newMs)}`);
  }
  if (!groupedRepairSeen) failures.push('DEV: no grouped finding_repair proposed (fixture no longer covers remediation.grouping=single)');
  if (!batchResolveSeen) failures.push('DEV: no batched finding_resolve proposed after the grouped repair (fixture no longer covers finding_resolve_batch)');
  console.log(`golden: ${records.length} quiet states, live == reference == CLI next --json at every one; grouped finding repair covered: ${groupedRepairSeen}; batched resolve covered: ${batchResolveSeen}`);
  console.log(`next-driver-cost: ${((Date.now() - started) / 1000).toFixed(0)} s wall`);
  if (failures.length) {
    console.log(`next-driver-cost: spawn budget exceeded\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('next-driver-cost-smoke: PASS');
}

if (process.argv[2] === '--probe') await probe(process.argv[3]!, process.argv[4]!);
else await main();
