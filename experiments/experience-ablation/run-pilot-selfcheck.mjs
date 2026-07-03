#!/usr/bin/env node
// run-pilot-selfcheck.mjs — hermetic M6 campaign-runner selfcheck
// (experience-ablation). Stub host command only — NEVER invokes a real host,
// consumes no tokens. Everything runs in mkdtemp roots; the repo is consumed
// READ-ONLY (fixture generator, protocol/pair-ledger tools, score.mjs, and
// the built packages/main/dist/cli.js for the read-only isolation probe).
//
// Cases:
//   (1) --plan dry-run prints the cell table (fixtureId x arm, pending/done
//       counts) and exits 0 without executing anything.
//   (2) leakage-audit hard precondition: execution refuses when
//       leakage-audit.jsonl is missing, and when it carries a pass:false row
//       (naming the fixture); --plan stays exit 0 but reports NOT PASSED.
//   (3) full cycle one cell (stub host, --smoke): the run dir carries
//       run.json (every RUN-RECORD.md required field) + activity.jsonl (the
//       stub's M3-vocabulary events, experiment env plumbed through) +
//       workspace/ (post-run state); score.mjs accepts it and the record is
//       NOT voided; progress jsonl gained cell_start + cell_done rows. The
//       spawn env poisons LATTICE_PROJECT_ROOT at the production repo to
//       prove the runner sanitizes the child env (a leak would make the
//       isolation probe resolve the production root and abort).
//   (4) resume: a second invocation skips the terminal cell (byte-identical
//       run.json, cell_skip row) and completes the remaining cell; a third
//       invocation executes nothing (all terminal).
//   (5) isolation assertion: with --scratchDir inside a git checkout the
//       resolved learning root escapes to the git toplevel, so the runner
//       aborts the cell BEFORE host execution (nonzero exit naming the
//       store-isolation assertion; no run.json; the stub host never ran).

import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitCorpus } from './fixture-generator.mjs';
import { freezeProtocol } from './protocol.mjs';
import { buildLedger } from './pair-ledger.mjs';
import { experimentRoot } from './protocol.mjs';
import { PROGRESS_FILENAME, runDirName } from './run-pilot.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const RUN_PILOT = join(HERE, 'run-pilot.mjs');
const SCORE_CLI = join(HERE, 'score.mjs');
const SNAPSHOT_CLI = join(HERE, '..', '..', 'packages', 'main', 'dist', 'cli.js');
const SEED = 'run-pilot-selfcheck-seed';
const EXPERIMENT_ID = 'exp-pilot-selfcheck';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS ${name}`);
  else { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const roots = [];
function tmp(prefix) { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(d); return d; }

function readProgress(expRoot) {
  const p = join(expRoot, PROGRESS_FILENAME);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Spawn run-pilot.mjs; returns {code, stdout, stderr}. */
function runPilot(args, envExtra = {}) {
  const res = spawnSync('node', [RUN_PILOT, ...args], {
    encoding: 'utf8', env: { ...process.env, ...envExtra }, timeout: 300_000,
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Minimal valid frozen-protocol config for the selfcheck corpus. */
function protocolConfig(experimentId) {
  return {
    schemaVersion: 'proofbound.experience-ablation-protocol.v1',
    experimentId,
    taskClasses: { inStore: ['false-done'], heldOut: [], clean: ['clean'] },
    perPopulation: {
      seeded: { alpha: 0.05, power: 0.8, baselineBand: [0.5, 0.8], mdeBand: [0.2, 0.3] },
      live: { alpha: 0.05, power: 0.8, baseline: 0.6, mde: 0.25 },
    },
    pilotFreezeRule: { minControlFaultRuns: 15, freezeAt: 'wilson95Lower', maxCiWidth: 0.3 },
    noOverclaimBoundaryRef: 'plan-S15-no-overclaim-boundary',
    memorySnapshotHash: 'a'.repeat(64),
  };
}

/** Build corpus + frozen protocol + pair ledger under a fresh root. */
function buildExperiment(root, experimentId) {
  const corpus = join(root, 'corpus');
  const { manifest } = emitCorpus({ outDir: corpus, seed: SEED, perClass: 1, classes: ['clean'] });
  freezeProtocol({ root, config: protocolConfig(experimentId) });
  buildLedger({ root, experimentId, manifestRows: manifest, seed: SEED });
  return { corpus, manifest, expRoot: experimentRoot(root, experimentId) };
}

function writeLeakageAudit(expRoot, rows) {
  writeFileSync(join(expRoot, 'leakage-audit.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/**
 * Stub host script: copies the fixture's reference-good payload into the cwd
 * workspace (so the visible acceptance passes and the hidden oracle sees the
 * corrected outcome), appends M3-vocabulary events to <cwd>/.lattice/
 * activity.jsonl exactly where the real CLI writes them (verified
 * empirically), plus one per-command `tool` record for the commandCount
 * proxy, and drops a side-effect marker so case (5) can prove it never ran.
 */
function writeStubHost(dir, { payloadDir, markerFile }) {
  const stub = join(dir, 'stub-host.mjs');
  writeFileSync(stub, `
import { appendFileSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const cwd = process.cwd();
const expId = process.env.LATTICE_EXPERIMENT_ID;
const arm = process.env.LATTICE_EXPERIMENT_ARM;
if (!expId || !arm) { console.error('stub-host: experiment env missing'); process.exit(3); }
if (process.env.LATTICE_PROJECT_ROOT) { console.error('stub-host: LATTICE_PROJECT_ROOT leaked into the host env'); process.exit(4); }
cpSync(${JSON.stringify(payloadDir)}, cwd, { recursive: true });
mkdirSync(join(cwd, '.lattice'), { recursive: true });
const events = [
  { timestamp: new Date().toISOString(), event: 'experience_pack_surfaced', experimentId: expId, arm, consumer: 'session', storyId: 'global', roundKey: 'default', packDigest: 'stub', topHitIds: ['les-stub-a', 'les-stub-b'] },
  ...(arm === 'control' ? [{ timestamp: new Date().toISOString(), event: 'retrieval_violation', experimentId: expId, command: 'dev_memory_capture' }] : []),
  { startTime: new Date().toISOString(), endTime: new Date().toISOString(), tool: 'session_brief', detail: 'session_brief', status: 'ok' },
];
appendFileSync(join(cwd, '.lattice', 'activity.jsonl'), events.map((e) => JSON.stringify(e)).join('\\n') + '\\n');
writeFileSync(${JSON.stringify(markerFile)}, cwd + '\\n', { flag: 'a' });
console.log('stub-host done');
`);
  return stub;
}

try {
  check('isolation probe CLI is built (packages/main/dist/cli.js)', existsSync(SNAPSHOT_CLI), SNAPSHOT_CLI);

  const root = tmp('ablation-pilot-root-');
  const scratch = tmp('ablation-pilot-scratch-');
  const { corpus, manifest, expRoot } = buildExperiment(root, EXPERIMENT_ID);
  check('selfcheck corpus is one clean fixture (two cells)', manifest.length === 1, `got ${manifest.length}`);
  const fixtureId = manifest[0].fixtureId;
  const markerFile = join(tmp('ablation-pilot-marker-'), 'stub-ran.log');
  const stub = writeStubHost(tmp('ablation-pilot-stub-'), {
    payloadDir: join(corpus, fixtureId, 'reference-good'),
    markerFile,
  });
  const baseArgs = [
    `--root=${root}`, `--experimentId=${EXPERIMENT_ID}`, `--corpus=${corpus}`,
    `--scratchDir=${scratch}`, `--snapshotCli=${SNAPSHOT_CLI}`,
    `--hostCmd=node ${stub}`, '--hostId=stub-host',
  ];
  const runOrder = JSON.parse(readFileSync(join(expRoot, 'run-order-seed.json'), 'utf8')).runOrder;
  const [firstFixture, firstArm] = [runOrder[0].split('::')[0], runOrder[0].split('::').pop()];
  const firstRunDir = join(expRoot, 'runs', runDirName(firstFixture, firstArm));

  // --- (2) leakage-audit refusals (before any audit file exists) --------------
  {
    const missing = runPilot([...baseArgs, '--maxCells=1']);
    check('(2) execution refuses when leakage-audit.jsonl is missing (nonzero exit naming leakage-audit)',
      missing.code === 1 && /leakage audit has not passed/.test(missing.stderr) && /not found/.test(missing.stderr),
      JSON.stringify(missing.stderr.trim()));
    check('(2) refusal wrote no run dir and never ran the stub host',
      !existsSync(firstRunDir) && !existsSync(markerFile));

    writeLeakageAudit(expRoot, [{ fixtureId, checks: ['strip-list'], pass: false }]);
    const failing = runPilot([...baseArgs, '--maxCells=1']);
    check('(2) execution refuses on a pass:false audit row, naming the fixture',
      failing.code === 1 && /leakage audit has not passed/.test(failing.stderr) && failing.stderr.includes(fixtureId),
      JSON.stringify(failing.stderr.trim()));

    const planNotPassed = runPilot([...baseArgs, '--plan']);
    check('(2) --plan stays exit 0 with a failing audit but reports NOT PASSED',
      planNotPassed.code === 0 && /leakage-audit: NOT PASSED/.test(planNotPassed.stdout),
      JSON.stringify({ code: planNotPassed.code }));
  }

  writeLeakageAudit(expRoot, [{ fixtureId, checks: ['strip-list'], pass: true }]);

  // --- (1) --plan dry-run -------------------------------------------------------
  {
    const plan = runPilot([...baseArgs, '--plan']);
    check('(1) --plan exits 0 and prints the cell table with fixtureId x both arms',
      plan.code === 0 && plan.stdout.includes(fixtureId)
      && /\bcontrol\b/.test(plan.stdout) && /\btreatment\b/.test(plan.stdout),
      JSON.stringify({ code: plan.code, out: plan.stdout.slice(0, 300) }));
    check('(1) --plan reports 2 cells, 0 done, 2 pending and a passing leakage audit',
      plan.stdout.includes('totals: 2 cells, 0 done, 2 pending') && /leakage-audit: PASS/.test(plan.stdout),
      plan.stdout);
    check('(1) --plan executed nothing (no runs dir, no stub marker, no progress rows)',
      !existsSync(join(expRoot, 'runs')) && !existsSync(markerFile)
      && readProgress(expRoot).length === 0);
  }

  // --- (3) full cycle one cell (--smoke), poisoned parent env ---------------------
  {
    const smoke = runPilot([...baseArgs, '--smoke'], {
      LATTICE_PROJECT_ROOT: join(HERE, '..', '..'), // must be stripped by the runner
    });
    check('(3) --smoke executes exactly one cell and exits 0',
      smoke.code === 0 && /1 executed/.test(smoke.stdout) && /1 still pending/.test(smoke.stdout),
      JSON.stringify({ code: smoke.code, out: smoke.stdout.slice(0, 400), err: smoke.stderr.slice(0, 400) }));
    check('(3) run dir carries run.json + activity.jsonl + workspace/',
      existsSync(join(firstRunDir, 'run.json')) && existsSync(join(firstRunDir, 'activity.jsonl'))
      && existsSync(join(firstRunDir, 'workspace')));

    const run = JSON.parse(readFileSync(join(firstRunDir, 'run.json'), 'utf8'));
    check('(3) run.json carries every RUN-RECORD.md required field with the cell identity',
      run.experimentId === EXPERIMENT_ID && run.arm === firstArm && run.hostId === 'stub-host'
      && typeof run.storeRoot === 'string' && run.storeRoot.startsWith('/')
      && run.storeRoot.endsWith('/.lattice/learning')
      && typeof run.startedAt === 'string' && typeof run.endedAt === 'string'
      && run.timeToDoneMs !== undefined && run.commandCount === 1
      && run.doneReached === true && run.validationPass === true,
      JSON.stringify(run));
    check('(3) storeRoot is the isolated scratch root, not the production repo',
      run.storeRoot.startsWith(scratch + '/'), run.storeRoot);

    const slice = readFileSync(join(firstRunDir, 'activity.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const pack = slice.find((e) => e.event === 'experience_pack_surfaced');
    check('(3) activity slice carries the stub M3 event with the experiment env plumbed through',
      pack !== undefined && pack.experimentId === EXPERIMENT_ID && pack.arm === firstArm
      && JSON.stringify(pack.topHitIds) === JSON.stringify(['les-stub-a', 'les-stub-b']),
      JSON.stringify(slice));

    const progress = readProgress(expRoot);
    check('(3) progress jsonl gained campaign_start + cell_start + cell_done rows for the cell',
      progress.some((r) => r.event === 'campaign_start')
      && progress.some((r) => r.event === 'cell_start' && r.fixtureId === firstFixture && r.arm === firstArm)
      && progress.some((r) => r.event === 'cell_done' && r.fixtureId === firstFixture && r.arm === firstArm && r.validationPass === true),
      JSON.stringify(progress.map((r) => r.event)));

    const score = spawnSync('node', [SCORE_CLI, `--fixture=${join(corpus, firstFixture)}`, `--run=${firstRunDir}`], { encoding: 'utf8' });
    let record = null;
    try { record = JSON.parse(score.stdout); } catch { /* checked below */ }
    check('(3) score.mjs accepts the produced run dir (exit 0, parseable record)',
      score.status === 0 && record !== null, JSON.stringify({ code: score.status, err: (score.stderr ?? '').trim() }));
    check('(3) the score record is NOT voided and binds the cell identity',
      record !== null && record.voided === false && record.voidReason === null
      && record.taskId === `${firstFixture}::${firstArm}` && record.pairId === firstFixture
      && record.memoryPackShown === (firstArm === 'treatment'),
      JSON.stringify(record ?? {}));
  }

  // --- (4) resume ------------------------------------------------------------------
  {
    const runJsonBefore = readFileSync(join(firstRunDir, 'run.json'), 'utf8');
    const second = runPilot(baseArgs);
    const secondArm = firstArm === 'control' ? 'treatment' : 'control';
    const secondRunDir = join(expRoot, 'runs', runDirName(fixtureId, secondArm));
    check('(4) second invocation skips the terminal cell and completes the remaining one',
      second.code === 0 && /1 skipped/.test(second.stdout) && /1 executed/.test(second.stdout)
      && /0 still pending/.test(second.stdout) && existsSync(join(secondRunDir, 'run.json')),
      JSON.stringify({ code: second.code, out: second.stdout.slice(0, 400), err: second.stderr.slice(0, 300) }));
    check('(4) the skipped cell run.json is byte-identical (never re-run or rewritten)',
      readFileSync(join(firstRunDir, 'run.json'), 'utf8') === runJsonBefore);
    check('(4) progress jsonl recorded the cell_skip row (append-only resume evidence)',
      readProgress(expRoot).some((r) => r.event === 'cell_skip' && r.fixtureId === firstFixture && r.arm === firstArm));

    const third = runPilot(baseArgs);
    check('(4) third invocation finds all cells terminal and executes nothing',
      third.code === 0 && /2 skipped/.test(third.stdout) && /0 executed/.test(third.stdout),
      JSON.stringify({ code: third.code, out: third.stdout.slice(0, 300) }));
  }

  // --- (5) isolation assertion aborts on a git-nested workspace ---------------------
  {
    const isoRoot = tmp('ablation-pilot-iso-root-');
    const isoId = 'exp-pilot-iso';
    const iso = buildExperiment(isoRoot, isoId);
    writeLeakageAudit(iso.expRoot, [{ fixtureId: iso.manifest[0].fixtureId, checks: ['strip-list'], pass: true }]);
    const gitScratch = tmp('ablation-pilot-gitscratch-');
    execFileSync('git', ['init', '-q', gitScratch]);
    const markerBefore = existsSync(markerFile) ? readFileSync(markerFile, 'utf8') : '';
    const isoRun = runPilot([
      `--root=${isoRoot}`, `--experimentId=${isoId}`, `--corpus=${iso.corpus}`,
      `--scratchDir=${gitScratch}`, `--snapshotCli=${SNAPSHOT_CLI}`,
      `--hostCmd=node ${stub}`, '--hostId=stub-host', '--maxCells=1',
    ]);
    const isoFixture = iso.manifest[0].fixtureId;
    const isoRunOrder = JSON.parse(readFileSync(join(iso.expRoot, 'run-order-seed.json'), 'utf8')).runOrder;
    const isoFirstDir = join(iso.expRoot, 'runs', runDirName(isoFixture, isoRunOrder[0].split('::').pop()));
    check('(5) a git-nested scratch root aborts with the store-isolation assertion BEFORE host execution',
      isoRun.code === 1 && /store-isolation assertion failed/.test(isoRun.stderr)
      && /resolvedLearningRoot/.test(isoRun.stderr),
      JSON.stringify(isoRun.stderr.trim().slice(0, 400)));
    const markerAfter = existsSync(markerFile) ? readFileSync(markerFile, 'utf8') : '';
    check('(5) the aborted cell wrote no run.json and the stub host never ran',
      !existsSync(join(isoFirstDir, 'run.json')) && markerAfter === markerBefore);
    check('(5) the abort is on the progress ledger (cell_abort row, append-only)',
      readProgress(iso.expRoot).some((r) => r.event === 'cell_abort' && /store-isolation/.test(String(r.reason))),
      JSON.stringify(readProgress(iso.expRoot).map((r) => r.event)));
  }

  if (failures === 0) console.log('run-pilot-selfcheck: all cases passed');
} finally {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}

if (failures > 0) { console.error(`${failures} selfcheck failure(s)`); process.exit(1); }
