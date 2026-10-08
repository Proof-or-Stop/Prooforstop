#!/usr/bin/env node
/**
 * Lab gate-command-cost: child-process budget for the slow lifecycle gate
 * commands on the critical path (run 14: story_advance x5 = 513 s, validate
 * x2 = 146 s for a 0.8 s go test, review_round_prepare 160 s, managed review
 * evidence import ~150 s, live_smoke_transcript 150 s). On the emulated bench
 * container one child process costs ~0.1-0.2 s, so these commands' wall time
 * is their spawn count.
 *
 * Drives e2e-review-to-done-smoke scenario A (DEV -> REVIEW -> TEST -> DONE
 * through the real CLI) with a preload that counts every child process each
 * CLI invocation starts, then requires per-command budgets and a bound on
 * repeated identical commands. Measured on this fixture (dev Mac, child
 * processes per call) before -> after the fix:
 *   story_advance REVIEW 258 -> 61, TEST 575 -> 201, DONE 1003 -> 257;
 *   review_round_prepare 571 -> 126; managed_review_evidence_import 157-364
 *   -> 67-104; validate fast 199 -> 56, routine 310 -> 107;
 *   certification_window_begin 166 -> 65; live_smoke_transcript 325 -> 163;
 *   done_prepare 634 -> 299. Budgets leave ~40% headroom over "after".
 * The fix answers identical read-only ref-state git probes once per unchanged
 * repository ref state (core/git-ref-witness-memo.ts) and stops
 * story_advance's runtime preflight from building a readiness report it
 * discarded. No gate is skipped: the scenario must still reach DONE.
 *
 * N9 (lab owner-init-and-worker-prompt): the owner env carries the
 * GIT_CONFIG_COUNT/KEY/VALUE credential settings agent hosts inject; before
 * core/git-inert-environment.ts they bypassed every git memo (story_advance
 * TEST 532, DONE 1016 child processes on this fixture).
 *
 * Usage: node packages/main/dist/tasks/gate-command-cost-smoke.js
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Max child processes one call of the command may start (first match wins). */
const SPAWN_BUDGET: Array<{ label: RegExp; max: number }> = [
  { label: /^story_advance REVIEW$/, max: 100 },
  { label: /^story_advance TEST$/, max: 280 },
  { label: /^story_advance DONE$/, max: 380 },
  { label: /^review_round_prepare$/, max: 180 },
  { label: /^managed_review_evidence_import$/, max: 150 },
  { label: /^validate fast$/, max: 90 },
  { label: /^validate routine$/, max: 150 },
  { label: /^certification_window_begin$/, max: 100 },
  { label: /^live_smoke_transcript$/, max: 230 },
  { label: /^done_prepare$/, max: 400 },
];
/**
 * Max repeated identical read-only ref-state git reads (core/git-ref-witness-memo
 * isRefStateGitRead) inside one call. Before the fix these were most of every
 * gate command's child processes (story_advance DONE ~800); after it at most
 * ~50 remain, either re-read after the command's own metadata commit moved a
 * ref, or from direct readers outside observedGit in the DONE merge path
 * (done-effects). Working-tree reads (scope diff pack, status)
 * legitimately rerun because the command writes Story files between them and
 * are only covered by the total budget.
 */
const REF_STATE_REPEAT_BUDGET = 60;

/** The git config an agent host injects into every owner shell (credential prompting off). */
const AGENT_HOST_GIT_CONFIG_ENV = {
  GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.interactive', GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'credential.guiPrompt', GIT_CONFIG_VALUE_1: 'false',
};

const PRELOAD = String.raw`
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const LOG = process.env.GATE_COMMAND_COST_LOG;
if (LOG && path.basename(process.argv[1] || '') === 'cli.js') {
  const commands = [];
  const record = (file, args) => commands.push([String(file), ...(Array.isArray(args) ? args.map(String) : [])]);
  for (const name of ['spawnSync', 'execFileSync', 'execSync', 'spawn', 'execFile', 'exec', 'fork']) {
    const original = cp[name];
    cp[name] = function (file, args) { record(file, name === 'execSync' || name === 'exec' ? [] : args); return original.apply(this, arguments); };
  }
  require('node:module').syncBuiltinESMExports();
  let payload = {};
  try { payload = JSON.parse(process.argv[3] || '{}'); } catch {}
  process.on('exit', () => {
    try { fs.appendFileSync(LOG, JSON.stringify({ command: process.argv[2], phase: payload.phase, focus: payload.focus, commands }) + '\n'); } catch {}
  });
}
`;

interface Row { command: string; phase?: string; focus?: string; commands: string[][] }

function labelOf(row: Row): string {
  if (row.command === 'story_advance') return `story_advance ${row.phase ?? '?'}`;
  if (row.command === 'validate') return `validate ${row.focus === 'fast' ? 'fast' : 'routine'}`;
  return row.command;
}

/** The production classifier (absent before the fix: every git read then counts as ref state). */
async function refStateClassifier(): Promise<(argv: string[]) => boolean> {
  const module = await import(new URL('../core/git-ref-witness-memo.js', import.meta.url).href).catch(() => undefined) as
    { isRefStateGitRead?: (argv: readonly string[]) => boolean } | undefined;
  return module?.isRefStateGitRead ?? (() => true);
}

async function main(): Promise<void> {
  const isRefStateGitRead = await refStateClassifier();
  const dir = mkdtempSync(join(tmpdir(), 'gate-command-cost-'));
  const preload = join(dir, 'preload.cjs');
  const log = join(dir, 'spawns.jsonl');
  writeFileSync(preload, PRELOAD);
  const harness = fileURLToPath(new URL('./e2e-review-to-done-smoke.js', import.meta.url));
  const started = Date.now();
  try {
    const run = spawnSync(process.execPath, [harness, 'A'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 7 * 60 * 1000,
      // N9: agent hosts pass credential settings as GIT_CONFIG_COUNT/KEY/VALUE on every
      // shell (Claude Code: credential.interactive / credential.guiPrompt); they cannot
      // change a read-only probe, so the budgets hold with them set.
      env: { ...process.env, ...AGENT_HOST_GIT_CONFIG_ENV, GATE_COMMAND_COST_LOG: log, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${preload}`.trim() },
    });
    if (run.status !== 0) {
      console.log(`${run.stdout ?? ''}${run.stderr ?? ''}`.slice(-6000));
      console.log('gate-command-cost: scenario A did not reach DONE (harness failed)');
      process.exit(1);
    }
    const rows = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Row);
    const failures: string[] = [];
    const seen = new Set<string>();
    console.log(`${'command'.padEnd(36)} ${'spawns'.padStart(6)} ${'budget'.padStart(6)} ${'repeats'.padStart(7)} ${'ref-state repeats'.padStart(17)}`);
    for (const row of rows) {
      const label = labelOf(row);
      const budget = SPAWN_BUDGET.find(entry => entry.label.test(label));
      if (!budget) continue;
      seen.add(budget.label.source);
      const spawns = row.commands.length;
      const keys = row.commands.map(argv => argv.join('\0'));
      const repeats = spawns - new Set(keys).size;
      const refState = row.commands.filter(argv => /(?:^|\/)git$/.test(argv[0]!) && isRefStateGitRead(argv.slice(1))).map(argv => argv.join('\0'));
      const refStateRepeats = refState.length - new Set(refState).size;
      console.log(`${label.padEnd(36)} ${String(spawns).padStart(6)} ${String(budget.max).padStart(6)} ${String(repeats).padStart(7)} ${String(refStateRepeats).padStart(17)}`);
      if (spawns > budget.max) failures.push(`${label}: ${spawns} child processes > budget ${budget.max}`);
      if (refStateRepeats > REF_STATE_REPEAT_BUDGET) failures.push(`${label}: ${refStateRepeats} repeated identical ref-state git reads > budget ${REF_STATE_REPEAT_BUDGET}`);
    }
    for (const entry of SPAWN_BUDGET) if (!seen.has(entry.label.source)) failures.push(`${entry.label.source}: not observed (fixture no longer covers this command)`);
    console.log(`gate-command-cost: ${((Date.now() - started) / 1000).toFixed(0)} s wall`);
    if (failures.length) {
      console.log(`gate-command-cost: gate command spawn budget exceeded\n  ${failures.join('\n  ')}`);
      process.exit(1);
    }
    console.log('gate-command-cost-smoke: PASS');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
