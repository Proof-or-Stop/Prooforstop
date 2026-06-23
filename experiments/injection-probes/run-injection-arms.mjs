// run-injection-arms.mjs — powered-run DRIVER for the stateless-safe injection probes (B-a1b0).
//
// For each (probe, arm, rep): make a fresh workspace, apply probe.inject(), obtain a
// transcript {actions, shipped} from a PLUGGABLE arm function, classify the outcome
// (RECOVERED/SAFE_STOP/AMPLIFIED), and record it. The arm is a PARAMETER — this driver
// never imports run-recovery.mjs / run-ablation.mjs / run-a2prime.mjs (those are owned by
// another session and are out of scope; agentRun there is a local non-exported closure).
//
// This story ships ONLY the hermetic `--self-test` (a deterministic fake arm, zero network,
// zero cost). The real powered run (real claude -p) is a deliberate, cost-checkpointed
// follow-up that injects a real-arm function into runInjectionArms().
//
// Run: node experiments/injection-probes/run-injection-arms.mjs --self-test

import { pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';
import { OUTCOME, makeWorkspace, cleanup } from './probe-contract.mjs';

export const PROBE_FILES = [
  'b1-modify-unrelated.mjs',
  'b2-break-architecture.mjs',
  'b6-dep-install-fail.mjs',
  'b9-delete-critical.mjs',
  'b11-high-risk-file.mjs',
  'b13-prod-deploy.mjs',
];

// The probe modules end with a bare `probeCliMain(harness)` (no `import.meta.url === main`
// guard), so importing one would run its CLI branch and `process.exit()` — terminating us.
// Until that guard is added upstream (probe-contract / the probe files, owned elsewhere), we
// neutralize process.exit / argv / stdout for the duration of the dynamic import and capture
// the already-evaluated `default` export. UPSTREAM FIX: add a main-guard so this is unneeded.
async function importProbe(file) {
  const origExit = process.exit;
  const origArgv = process.argv;
  const origLog = console.log;
  process.exit = () => {};
  process.argv = [origArgv[0], 'run-injection-arms:import'];
  console.log = () => {};
  try {
    const mod = await import(new URL(file, import.meta.url));
    if (!mod.default || typeof mod.default.inject !== 'function') {
      throw new Error(`probe ${file} has no usable default harness`);
    }
    return mod.default;
  } finally {
    process.exit = origExit;
    process.argv = origArgv;
    console.log = origLog;
  }
}

export async function loadProbes(files = PROBE_FILES) {
  const probes = [];
  for (const f of files) probes.push(await importProbe(f));
  return probes;
}

/**
 * Apply each probe to each arm `reps` times and record the classified outcome.
 * @param {object} o
 * @param {Array} o.probes      probe harnesses (defineInjection results)
 * @param {string[]} o.arms     arm identifiers
 * @param {number} [o.reps]     repetitions per (probe, arm)
 * @param {(ws:string, ctx:{probe:object,arm:string,rep:number}) => ({actions:string[],shipped:boolean}|Promise<...>)} o.runArm
 *                              the PLUGGABLE arm (fake in self-test; real claude -p later)
 * @param {string} [o.recordsFile]  if set, append each record as a jsonl line
 * @returns {Promise<Array<{probe:string,arm:string,rep:number,outcome:string}>>}
 */
export async function runInjectionArms({ probes, arms, reps = 1, runArm, recordsFile }) {
  if (typeof runArm !== 'function') throw new Error('runInjectionArms: runArm must be a function');
  const records = [];
  for (const probe of probes) {
    for (const arm of arms) {
      for (let rep = 1; rep <= reps; rep++) {
        const ws = makeWorkspace();
        try {
          probe.inject(ws);
          const transcript = await runArm(ws, { probe, arm, rep });
          const outcome = probe.classify(ws, transcript);
          const record = { probe: probe.id, arm, rep, outcome };
          records.push(record);
          if (recordsFile) appendFileSync(recordsFile, JSON.stringify(record) + '\n');
        } finally {
          cleanup(ws);
        }
      }
    }
  }
  return records;
}

// ---- hermetic self-test: a deterministic FAKE arm, no network, no cost ----
async function selfTest() {
  const probes = await loadProbes();
  const arms = ['recovered', 'safeStop', 'amplified'];
  const expected = { recovered: OUTCOME.RECOVERED, safeStop: OUTCOME.SAFE_STOP, amplified: OUTCOME.AMPLIFIED };
  // The fake arm IS the probe's own selfTestCases builder for the requested outcome: it mutates
  // the (already-injected) workspace to simulate that arm response and returns the transcript, so
  // probe.classify() runs its REAL logic on a REAL workspace state — not a canned stub.
  const runArm = (ws, { probe, arm }) => probe.selfTestCases[arm](ws);

  const records = await runInjectionArms({ probes, arms, reps: 1, runArm });

  const fails = [];
  let pass = 0;
  for (const r of records) {
    if (r.outcome === expected[r.arm]) {
      pass++;
      console.log(`PASS ${r.probe} ${r.arm} -> ${r.outcome}`);
    } else {
      fails.push(`${r.probe} ${r.arm}: expected ${expected[r.arm]}, got ${r.outcome}`);
      console.log(`FAIL ${r.probe} ${r.arm}`);
    }
  }

  // adversarial: a wrong-outcome transcript must classify DIFFERENTLY (no rubber-stamping).
  const [b1] = probes;
  const wsA = makeWorkspace();
  b1.inject(wsA);
  const ampOutcome = b1.classify(wsA, b1.selfTestCases.amplified(wsA));
  cleanup(wsA);
  const wsR = makeWorkspace();
  b1.inject(wsR);
  const recOutcome = b1.classify(wsR, b1.selfTestCases.recovered(wsR));
  cleanup(wsR);
  if (ampOutcome === recOutcome) {
    fails.push(`adversarial: classify did not discriminate amplified(${ampOutcome}) vs recovered(${recOutcome})`);
  } else {
    console.log(`PASS adversarial discrimination: amplified=${ampOutcome} != recovered=${recOutcome}`);
  }

  if (fails.length > 0) {
    console.error(`\n✗ injection-arms driver self-test FAILED (${fails.length}):`);
    for (const f of fails) console.error(`   - ${f}`);
    process.exit(1);
  }
  console.log(
    `\n✓ injection-arms driver self-test passed: ${pass}/${records.length} (6 probes × 3 outcomes) ` +
      `+ adversarial discrimination, fake arm, 0 cost.`,
  );
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  if (process.argv.includes('--self-test')) {
    selfTest();
  } else if (process.argv.includes('--run')) {
    console.error(
      'Powered run requires an explicit real-arm module (the cost-checkpointed follow-up of B-a1b0). ' +
        'Refusing to run without one — pass a runArm to runInjectionArms() programmatically.',
    );
    process.exit(2);
  } else {
    console.log('run-injection-arms.mjs — Usage: node run-injection-arms.mjs --self-test | --run');
    process.exit(0);
  }
}
