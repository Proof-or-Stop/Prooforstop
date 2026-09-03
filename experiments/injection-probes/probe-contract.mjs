// Shared contract for §6 recovery failure-injection harnesses (paper S3 harness).
// Each injection harness module (b1-modify-unrelated.mjs, etc.) imports this,
// builds its harness via defineInjection({...}), and exports it as default.
//
// This file is the SCAFFOLD shared by both experiment arms. It is built ONCE
// before the timed comparison; the 6 harness leaves are the parallelizable work.
//
// Design goals (kept deliberately small + dependency-free so a harness leaf is a
// self-contained, self-testable unit with NO cross-leaf imports → truly disjoint):
//   - inject(workspace): apply the fault to a sandbox workspace dir.
//   - classify(workspace, transcript): map post-run state → one of the 3 §6 outcomes.
//   - selfTest(): build a fresh sandbox, inject, then simulate each of the 3 arm
//     responses and assert classify() returns the right outcome for each. No live
//     Proof-or-Stop run needed → the harness is verifiable in isolation.

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SCHEMA_VERSION = 'lattice.injection_harness.v1';

// §6 three-way recovery outcome (mutually exclusive). See experiment-protocol.md §4.2.
export const OUTCOME = Object.freeze({
  RECOVERED: 'recovered-to-green', // fault resolved, tests pass
  SAFE_STOP: 'safe-stop',          // correctly stopped/escalated/rolled-back, not amplified
  AMPLIFIED: 'amplified',          // made it worse / shipped the fault
});

export function isOutcome(v) {
  return v === OUTCOME.RECOVERED || v === OUTCOME.SAFE_STOP || v === OUTCOME.AMPLIFIED;
}

/**
 * Build an injection harness.
 * @param {object} d
 * @param {string} d.id            - 'B1' .. 'B15'
 * @param {string} d.name          - kebab name, e.g. 'modify-unrelated'
 * @param {boolean} d.appliesToAllArms - true for stateless-safe injections (these 6 are)
 * @param {string} d.description   - one line: what fault is injected + the recovery goal
 * @param {(workspace: string) => object} d.inject
 *        Apply the fault inside `workspace` (a real temp dir). Return an injectionRecord
 *        {faultKind, target, detail} describing what was done (for the run-record).
 * @param {(workspace: string, transcript: {actions: string[], shipped: boolean}) => string} d.classify
 *        Inspect the post-run workspace + the arm's action transcript; return an OUTCOME.
 * @param {{recovered: Function, safeStop: Function, amplified: Function}} d.selfTestCases
 *        Three builders (workspace) => transcript that simulate each arm response; the
 *        contract wires harness.selfTest() = runStandardSelfTest(harness, selfTestCases).
 */
export function defineInjection(d) {
  for (const k of ['id', 'name', 'appliesToAllArms', 'description', 'inject', 'classify', 'selfTestCases']) {
    if (d[k] === undefined) throw new Error(`defineInjection: missing field '${k}'`);
  }
  for (const c of ['recovered', 'safeStop', 'amplified']) {
    if (typeof d.selfTestCases[c] !== 'function') throw new Error(`defineInjection: selfTestCases.${c} must be a function`);
  }
  const harness = { schemaVersion: SCHEMA_VERSION, ...d };
  harness.selfTest = () => runStandardSelfTest(harness, harness.selfTestCases);
  return Object.freeze(harness);
}

// ---- sandbox + assertion helpers (used by each harness's selfTest) ----

export function makeWorkspace(seed = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'inj-ws-'));
  // a minimal "project" the injections act on
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'sandbox', version: '1.0.0' }, null, 2));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'index.js'), 'export const ok = true;\n');
  writeFileSync(join(dir, 'src', 'critical.js'), 'export const CRITICAL = 1;\n');
  for (const [rel, content] of Object.entries(seed)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

export function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

export const fsx = { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, join };

export function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
}

/**
 * Generic self-test driver. A harness can call this from its selfTest():
 * it injects into a fresh workspace, then feeds three canned arm-transcripts
 * (one that recovers, one that safe-stops, one that amplifies) and asserts the
 * harness's classify() returns the matching outcome for each.
 *
 * @param {object} harness        - the defineInjection() result
 * @param {object} cases          - { recovered, safeStop, amplified } each a
 *                                   (workspace) => transcript builder that mutates
 *                                   the workspace to simulate that arm's behavior.
 */
export function runStandardSelfTest(harness, cases) {
  const expectations = [
    ['recovered', cases.recovered, OUTCOME.RECOVERED],
    ['safeStop', cases.safeStop, OUTCOME.SAFE_STOP],
    ['amplified', cases.amplified, OUTCOME.AMPLIFIED],
  ];
  for (const [label, build, want] of expectations) {
    const ws = makeWorkspace();
    try {
      const injectionRecord = harness.inject(ws);
      assert(injectionRecord && typeof injectionRecord === 'object', `${harness.id}: inject() must return a record`);
      const transcript = build(ws); // simulate the arm's response
      const got = harness.classify(ws, transcript);
      assert(isOutcome(got), `${harness.id}/${label}: classify returned non-outcome '${got}'`);
      assert(got === want, `${harness.id}/${label}: expected ${want}, got ${got}`);
    } finally {
      cleanup(ws);
    }
  }
  return { id: harness.id, name: harness.name, pass: true };
}

// CLI entry shared by every harness file:
//   node b1-modify-unrelated.mjs --self-test
export async function probeCliMain(harness) {
  if (process.argv.includes('--self-test')) {
    try {
      const r = await harness.selfTest();
      console.log(`PASS ${harness.id} ${harness.name}`);
      process.exit(0);
    } catch (e) {
      console.error(`FAIL ${harness.id} ${harness.name}: ${e.message}`);
      process.exit(1);
    }
  } else if (process.argv.includes('--describe')) {
    console.log(JSON.stringify({ id: harness.id, name: harness.name, appliesToAllArms: harness.appliesToAllArms, description: harness.description, schemaVersion: harness.schemaVersion }));
    process.exit(0);
  } else {
    console.log(`${harness.id} ${harness.name} — ${harness.description}\nUsage: node <file> --self-test | --describe`);
    process.exit(0);
  }
}
