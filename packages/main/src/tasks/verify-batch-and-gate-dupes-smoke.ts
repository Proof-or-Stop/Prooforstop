#!/usr/bin/env node
/**
 * Lab verify-batch-and-gate-dupes (run 17 cost items Q2 and Q5).
 *
 * Run 17 (22 pinned intents, abs-stepped-slices) spent:
 *   - verification_run --pending 31.8 s and 3x verification_evidence_refresh_stale
 *     36.7-41.2 s: per pinned execution ~1.05 s go test plus ~0.55 s of PoS
 *     child processes around it;
 *   - story_advance into REVIEW/TEST/DONE 15.8-20.0 s against 2.9 s into DEV;
 *   - one managed_review_evidence_import process per lane (4.7-8.5 s each);
 *   - validate --focus=fast and the routine validate, 14.3 s each, for the same
 *     single configured command.
 *
 * This smoke drives one Story with N pinned go-test intents from DEV to DONE
 * with `proof-or-stop next` (e2e-review-to-done harness, scripted reviewers),
 * counting the child processes and implementation-identity scans of every CLI
 * process. Required:
 *   1. per pinned execution, verification_run --pending and
 *      verification_evidence_refresh_stale start at most PER_EXECUTION_BUDGET
 *      child processes besides the pinned command itself;
 *   2. story_advance REVIEW / TEST / DONE: the receipt checks share one
 *      observation per gate evaluation (implementation-identity scans and child
 *      processes do not grow with N);
 *   3. the completed lanes of one review round are imported by ONE
 *      managed_review_evidence_import process;
 *   4. when the fast validation plan is the routine plan (same commands), the
 *      certification stretch runs ONE validate, the routine suite, and it runs
 *      after certification_window_begin admitted the window (the fresh-run
 *      requirement); with different plans the cheap check is still required.
 * Every receipt keeps the exact pinned command (no combined go test run).
 *
 * Usage: node packages/main/dist/tasks/verify-batch-and-gate-dupes-smoke.js [N]
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import type { ChecklistData } from '../core/types.js';

const N = Math.max(4, Number(process.argv[2] ?? 22));
/** Child processes per pinned execution besides the pinned command (before: ~13 on a dev Mac). */
const PER_EXECUTION_BUDGET = 8;
/** Implementation-identity scans per gate command (before: one or more per receipt, 2N+ at N=22). */
const IMPLEMENTATION_SCAN_BUDGET = 6;
/** Child processes per gate command at N pinned receipts (before, N=22: REVIEW 133, TEST 360, DONE 520). */
const GATE_SPAWN_BUDGET: Record<string, number> = { 'story_advance REVIEW': 90, 'story_advance TEST': 260, 'story_advance DONE': 380 };

const PRELOAD = String.raw`
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const LOG = process.env.VBG_SMOKE_LOG;
if (LOG && path.basename(process.argv[1] || '') === 'cli.js') {
  const started = Date.now();
  const commands = [];
  let implementationScans = 0;
  for (const name of ['spawnSync', 'execFileSync', 'execSync', 'spawn', 'execFile', 'exec', 'fork']) {
    const original = cp[name];
    cp[name] = function (file, args) { commands.push([String(file), ...(Array.isArray(args) ? args.map(String) : [])]); return original.apply(this, arguments); };
  }
  const readdir = fs.readdirSync;
  fs.readdirSync = function (dir) {
    // executionImplementationIdentity walks the runtime dist root once per scan.
    if (typeof dir === 'string' && /[\\/]packages[\\/]main[\\/]dist$/.test(dir)) implementationScans += 1;
    return readdir.apply(this, arguments);
  };
  require('node:module').syncBuiltinESMExports();
  let payload = {};
  try { payload = JSON.parse(process.argv[3] || '{}'); } catch {}
  process.on('exit', code => {
    try { fs.appendFileSync(LOG, JSON.stringify({ command: process.argv[2], payload, code, ms: Date.now() - started, implementationScans, commands }) + '\n'); } catch {}
  });
}
`;

interface Row { command: string; payload: Record<string, unknown>; code: number; ms: number; implementationScans: number; commands: string[][] }

function labelOf(row: Row): string {
  if (row.command === 'story_advance') return `story_advance ${String(row.payload.phase ?? '?')}`;
  if (row.command === 'validate') return `validate ${row.payload.focus === 'fast' ? 'fast' : 'routine'}`;
  if (row.command === 'verification_run' && row.payload.pending === true) return 'verification_run --pending';
  return row.command;
}

const isPinnedGoTest = (argv: string[]): boolean => /(?:^|\/)go$/.test(argv[0]!) && argv[1] === 'test' && argv.includes('-run');

function pinnedIntents(names: string[]) {
  const intent = (id: string, name: string) => ({ id, desc: `${name} passes`, type: 'logic' as const, priority: 'must' as const, scope: 'focused' as const,
    expectation: 'absolute_pass' as const, requirementSource: 'story' as const,
    verification: { command: `go test -v ./strs -run ^${name}$`, selector: `--- PASS: ${name}` } });
  const half = Math.ceil(names.length / 2);
  return {
    'CHK-001': { happy: names.slice(0, half).map((name, index) => intent(`CHK-001:happy:${index}`, name)), edge: [], adversarial: [] },
    'CHK-002': { happy: names.slice(half).map((name, index) => intent(`CHK-002:happy:${index}`, name)), edge: [], adversarial: [] },
  };
}

/** Unit check (4, negative): the cheap check is waived only for an identical command plan. */
async function cheapCheckRule(): Promise<string[]> {
  const failures: string[] = [];
  const module = await import(new URL('../core/certification-window.js', import.meta.url).href) as Record<string, unknown>;
  const subsumed = module.precertCheapCheckSubsumedByRoutine as undefined | ((fast: unknown, routine: unknown) => boolean);
  if (typeof subsumed !== 'function') return ['core/certification-window precertCheapCheckSubsumedByRoutine is missing (no rule decides when the routine run covers the cheap check)'];
  const command = (over: Record<string, unknown> = {}) => ({ label: 'go-strs', command: 'go', args: ['test', '-v', './strs'], timeoutMs: 270000, ...over });
  const identity = (commands: unknown[], sourceKind = 'configured') => ({ sourceKind, commands, digest: 'x' });
  if (!subsumed(identity([command({ focus: ['fast'] })]), identity([command({ focus: ['fast'] })]))) failures.push('identical single-command plans must waive the separate cheap run');
  if (subsumed(identity([command({ focus: ['fast'] })]), identity([command({ focus: ['fast'] }), command({ label: 'vet', args: ['vet', './...'] })]))) failures.push('a routine plan with an extra command must keep the cheap check');
  if (subsumed(identity([command({ focus: ['fast'] })]), identity([command({ timeoutMs: 1000 })]))) failures.push('a different timeout must keep the cheap check');
  if (subsumed(identity([command({ focus: ['fast'], env: { A: '1' } })]), identity([command()]))) failures.push('a different environment must keep the cheap check');
  if (subsumed(identity([command()], 'validate-file'), identity([command()], 'validate-file'))) failures.push('a validate.ts entrypoint (focus is an argument) must keep the cheap check');
  return failures;
}

async function main(): Promise<void> {
  const { Owner, driveWithNext } = await import('./e2e-review-to-done-smoke.js');
  const { createFixtureMachineEnvironment } = await import('./helpers/fixture-machine-environment.js');
  const dir = mkdtempSync(join(tmpdir(), 'vbg-smoke-'));
  const preload = join(dir, 'preload.cjs');
  const log = join(dir, 'cli.jsonl');
  writeFileSync(preload, PRELOAD);
  const machine = createFixtureMachineEnvironment();
  machine.env.NODE_OPTIONS = `${machine.env.NODE_OPTIONS ?? ''} --require ${preload}`.trim();
  machine.env.VBG_SMOKE_LOG = log;
  const o = new Owner('VBG', 'B-vbg1', machine.env, [], false);
  const started = Date.now();
  let passed = false;
  const failures: string[] = [];
  const lines: string[] = [];
  try {
    const id = o.storyId;
    const git = (...args: string[]) => execFileSync('git', args, { cwd: o.worktree, encoding: 'utf8' }).trim();
    const names = ['TestUpper', 'TestReverse', ...Array.from({ length: N - 2 }, (_, index) => `TestPinned${index + 1}`)];
    writeFileSync(join(o.worktree, 'strs/strs_test.go'), readFileSync(join(o.worktree, 'strs/strs_test.go'), 'utf8')
      + names.slice(2).map(name => `\nfunc ${name}(t *testing.T) {\n\tif Upper("x") != "X" {\n\t\tt.Fatal("x")\n\t}\n}\n`).join(''));
    git('add', '-A');
    git('-c', 'user.name=proof-or-stop-implementer', 'commit', '-qm', `add ${N - 2} pinned tests`);
    const store = new StoryStore(o.worktree);
    const cl = store.readChecklist(id) as ChecklistData;
    const intents = pinnedIntents(names);
    for (const item of cl.items) item.verificationIntent = JSON.parse(JSON.stringify(intents[item.id as keyof typeof intents]));
    store.writeChecklist(id, cl);
    resetConfigCache();
    git('add', '-A');
    git('-c', 'user.name=Bench Owner', '-c', 'user.email=owner@bench.invalid', 'commit', '-qm', `proof-or-stop: PLAN pins ${id}`);
    o.mustCli('dev_memory_preflight_ack', { storyId: id });
    o.mustCli('scope_contract_init_from_plan', { storyId: id });
    o.mustCli('checklist_update', { storyId: id, itemId: 'CHK-001', status: 'done' });
    o.mustCli('checklist_update', { storyId: id, itemId: 'CHK-002', status: 'done' });
    // Receipts for all N pins, then a material commit makes them stale: next
    // must refresh them (refresh_stale) before REVIEW, as after a run-17 repair.
    o.mustCli('verification_run', { storyId: id, pending: true });
    writeFileSync(join(o.worktree, 'strs/strs.go'), `${readFileSync(join(o.worktree, 'strs/strs.go'), 'utf8')}\n// Upper and Reverse are covered by the pinned tests.\n`);
    git('add', '-A');
    git('-c', 'user.name=proof-or-stop-implementer', 'commit', '-qm', 'doc comment');
    const reasons: string[] = [];
    driveWithNext(o, { findingRound1: false, run: false }, lines, next => { reasons.push(`${next.phase}:${next.reason}`); });

    const rows = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Row);
    console.log(`N=${N} pinned intents; ${rows.length} CLI processes; ${((Date.now() - started) / 1000).toFixed(0)} s`);
    console.log(`${'command'.padEnd(36)} ${'ms'.padStart(6)} ${'spawns'.padStart(6)} ${'pinned'.padStart(6)} ${'other/exec'.padStart(10)} ${'implScans'.padStart(9)}`);
    for (const row of rows) {
      const label = labelOf(row);
      if (!/^(?:verification_run|verification_evidence_refresh_stale|story_advance|managed_review_evidence_import|validate|certification_window_begin)/.test(label)) continue;
      const pinned = row.commands.filter(isPinnedGoTest).length;
      const other = row.commands.length - pinned;
      console.log(`${label.padEnd(36)} ${String(row.ms).padStart(6)} ${String(row.commands.length).padStart(6)} ${String(pinned).padStart(6)} ${(pinned ? (other / pinned).toFixed(1) : '-').padStart(10)} ${String(row.implementationScans).padStart(9)}`);
    }

    // 1. Pinned executions: exact pinned commands, bounded PoS work around each.
    for (const label of ['verification_run --pending', 'verification_evidence_refresh_stale']) {
      const row = rows.find(candidate => labelOf(candidate) === label && candidate.code === 0 && candidate.commands.some(isPinnedGoTest));
      if (!row) { failures.push(`${label}: no successful run with pinned executions observed`); continue; }
      const pinned = row.commands.filter(isPinnedGoTest);
      if (pinned.length !== N) failures.push(`${label}: ${pinned.length} pinned go test executions, expected exactly N=${N} (one per unique pinned command; never a combined run)`);
      for (const argv of pinned) if (!/^\^Test\w+\$$/.test(argv[argv.indexOf('-run') + 1] ?? '')) failures.push(`${label}: executed a non-pinned -run selector ${argv.join(' ')}`);
      const perExecution = (row.commands.length - pinned.length) / Math.max(1, pinned.length);
      if (perExecution > PER_EXECUTION_BUDGET) failures.push(`${label}: ${perExecution.toFixed(1)} other child processes per pinned execution > ${PER_EXECUTION_BUDGET}`);
    }
    // 2. Gate entries: one observation per gate evaluation.
    for (const [label, budget] of Object.entries(GATE_SPAWN_BUDGET)) {
      const row = rows.find(candidate => labelOf(candidate) === label && candidate.code === 0);
      if (!row) { failures.push(`${label}: not observed`); continue; }
      if (row.commands.length > budget) failures.push(`${label}: ${row.commands.length} child processes > ${budget} at N=${N}`);
      if (row.implementationScans > IMPLEMENTATION_SCAN_BUDGET) failures.push(`${label}: ${row.implementationScans} implementation-identity scans > ${IMPLEMENTATION_SCAN_BUDGET} (the receipt checks rescan per receipt)`);
    }
    // 3. One import process for the lanes of a round (the critic is its own wave).
    const firstRoundLanes = new StoryStore(o.root).readStory(id).currentReviewRound;
    const laneImports = rows.filter(row => row.command === 'managed_review_evidence_import'
      && !JSON.stringify(row.payload).includes('critic'));
    const importProcessesBeforeCritic = (() => {
      let count = 0;
      for (const row of rows) {
        if (row.command === 'review_inventory_begin') break;
        if (row.command === 'managed_review_evidence_import') count += 1;
      }
      return count;
    })();
    lines.push(`round ${String(firstRoundLanes)}: ${importProcessesBeforeCritic} managed_review_evidence_import process(es) for the lanes (${laneImports.length} import processes in total)`);
    if (importProcessesBeforeCritic !== 1) failures.push(`lane evidence import: ${importProcessesBeforeCritic} managed_review_evidence_import processes for one round's lanes, expected 1 batched import`);
    // 4. Certification stretch: one routine validate after the window was admitted.
    const finalizeAt = rows.findIndex(row => row.command === 'review_inventory_finalize');
    const testAt = rows.findIndex(row => labelOf(row) === 'story_advance TEST');
    const stretch = rows.slice(finalizeAt, testAt);
    const validates = stretch.filter(row => row.command === 'validate').map(labelOf);
    const beginAt = stretch.findIndex(row => row.command === 'certification_window_begin' && row.code === 0);
    const routineAt = stretch.findIndex(row => labelOf(row) === 'validate routine' && row.code === 0);
    lines.push(`certification stretch: ${stretch.map(labelOf).join(' > ')}`);
    if (validates.length !== 1 || validates[0] !== 'validate routine') failures.push(`certification stretch ran ${validates.join(', ') || 'no validate'}; expected exactly one routine validate (fast plan == routine plan)`);
    if (beginAt < 0 || routineAt < beginAt) failures.push('the routine validate must run after certification_window_begin admitted the window (fresh-run requirement)');
    if (reasons.some(reason => reason.endsWith(':precert_cheap_check'))) failures.push('next proposed precert_cheap_check although the fast plan is the routine plan');
    failures.push(...await cheapCheckRule());
    lines.push(`next steps: ${reasons.join(' > ')}`);
    for (const line of lines) console.log(line);
    passed = true;
  } finally {
    if (passed) o.cleanup(); else console.log(`fixture retained for diagnosis: ${o.root}`);
    try { machine.cleanup(); } catch (error) { console.log(String(error)); }
    rmSync(dir, { recursive: true, force: true });
  }
  if (failures.length) {
    console.log(`verify-batch-and-gate-dupes-smoke: FAIL\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('verify-batch-and-gate-dupes-smoke: PASS');
}

await main();
