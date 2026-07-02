/**
 * B-ab8d CHK-003 — control-arm memory retrieval blocking at the CLI choke point.
 *
 * Small standalone logic test (no runner framework; run directly after
 * `npm --prefix packages/main run build`):
 *
 *   node packages/main/tests/control-arm-retrieval-gate.test.mjs
 *
 * Asserts:
 *   1. CATALOG CROSS-CHECK (adversarial intent CHK-003:adversarial:0): every
 *      registered command whose name matches the declared memory retrieval
 *      families (MEMORY_RETRIEVAL_COMMAND_FAMILIES next to the command
 *      catalog) carries the `memoryRetrieval: true` policy marker, in BOTH
 *      directions (no unmarked family member, no marked non-family command),
 *      across BOTH registries (MAIN_TOOLS names and COMMAND_POLICIES keys),
 *      and every marker value is a strict boolean true.
 *   2. GATE: with arm=control, enforceExperimentArmRetrievalGate refuses a
 *      marked command with an error naming the experimentId AND appends a
 *      retrieval_violation event {experimentId, command, timestamp} to the
 *      activity log BEFORE throwing (event exists although the call threw).
 *   3. Control arm + non-memory command: passes, no violation event.
 *   4. Treatment arm and no-experiment mode: marked commands pass, no event.
 *   5. Runtime re-validation: isMemoryRetrievalCommand rejects unknown
 *      commands and non-string/empty input.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const {
  MAIN_TOOLS,
  MEMORY_RETRIEVAL_COMMAND_FAMILIES,
  matchesMemoryRetrievalFamily,
} = await import(join(distRoot, 'cli/command-catalog.js'));
const {
  COMMAND_POLICIES,
  isMemoryRetrievalCommand,
} = await import(join(distRoot, 'core/command-policy.js'));
const { enforceExperimentArmRetrievalGate } = await import(join(distRoot, 'cli-engine.js'));
const { resetExperimentArmWarnLatch } = await import(join(distRoot, 'core/experiment-arm.js'));

const ENV_ID = 'LATTICE_EXPERIMENT_ID';
const ENV_ARM = 'LATTICE_EXPERIMENT_ARM';
const savedId = process.env[ENV_ID];
const savedArm = process.env[ENV_ARM];

function setArmEnv(id, arm) {
  if (id === undefined) delete process.env[ENV_ID];
  else process.env[ENV_ID] = id;
  if (arm === undefined) delete process.env[ENV_ARM];
  else process.env[ENV_ARM] = arm;
  resetExperimentArmWarnLatch();
}

function readViolations(root) {
  const logPath = join(root, '.lattice', 'activity.jsonl');
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === 'retrieval_violation');
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`FAIL ${name}: ${e.message}`);
  }
}

// ── 1. Catalog cross-check ──────────────────────────────────────────────────

check('families constant is declared and non-empty', () => {
  assert.ok(Array.isArray(MEMORY_RETRIEVAL_COMMAND_FAMILIES));
  assert.ok(MEMORY_RETRIEVAL_COMMAND_FAMILIES.length >= 7);
});

check('every MAIN_TOOLS family member carries the memoryRetrieval marker', () => {
  const familyTools = MAIN_TOOLS.map((t) => t.name).filter((n) => matchesMemoryRetrievalFamily(n));
  assert.ok(familyTools.length >= 28, `expected >= 28 family commands in the catalog, got ${familyTools.length}`);
  const unmarked = familyTools.filter((n) => !isMemoryRetrievalCommand(n));
  assert.deepEqual(unmarked, [], `unmarked family members in MAIN_TOOLS: ${unmarked.join(', ')}`);
});

check('every COMMAND_POLICIES family key carries the memoryRetrieval marker', () => {
  const familyKeys = Object.keys(COMMAND_POLICIES).filter((n) => matchesMemoryRetrievalFamily(n));
  const unmarked = familyKeys.filter((n) => COMMAND_POLICIES[n].memoryRetrieval !== true);
  assert.deepEqual(unmarked, [], `unmarked family members in COMMAND_POLICIES: ${unmarked.join(', ')}`);
});

check('no non-family command carries the marker, and every marker is strict boolean true', () => {
  for (const [name, policy] of Object.entries(COMMAND_POLICIES)) {
    if (policy.memoryRetrieval !== undefined) {
      assert.equal(typeof policy.memoryRetrieval, 'boolean', `${name}: marker must be boolean, got ${typeof policy.memoryRetrieval}`);
      assert.equal(policy.memoryRetrieval, true, `${name}: a declared marker must be literal true`);
      assert.ok(matchesMemoryRetrievalFamily(name), `${name}: marked but not in a declared memory family`);
    }
  }
});

check('sentinels: recall marked; story_list / memory_benchmark_run / unknown not marked', () => {
  assert.equal(isMemoryRetrievalCommand('recall'), true);
  assert.equal(isMemoryRetrievalCommand('dev_memory_capture'), true, 'store writes are forbidden during runs');
  assert.equal(isMemoryRetrievalCommand('dev_memory_finish'), true, 'store writes are forbidden during runs');
  assert.equal(isMemoryRetrievalCommand('story_list'), false);
  assert.equal(isMemoryRetrievalCommand('memory_benchmark_run'), false, 'virtual benchmark is outside the declared families');
  assert.equal(isMemoryRetrievalCommand('no_such_command'), false);
  assert.equal(isMemoryRetrievalCommand(''), false);
});

// ── 2-4. Gate behavior against a temp root ──────────────────────────────────

const root = mkdtempSync(join(tmpdir(), 'lattice-control-arm-gate-'));
try {
  check('control arm: marked command refused, error names experimentId, event appended BEFORE throw', () => {
    setArmEnv('exp-gate-test-1', 'control');
    assert.throws(
      () => enforceExperimentArmRetrievalGate('recall', root),
      (e) =>
        e.message.includes('blocked: memory retrieval is disabled on the control arm of experiment exp-gate-test-1')
        && e.message.includes('recall'),
    );
    const events = readViolations(root);
    assert.equal(events.length, 1, 'exactly one retrieval_violation event after one blocked attempt');
    assert.equal(events[0].experimentId, 'exp-gate-test-1');
    assert.equal(events[0].command, 'recall');
    assert.ok(typeof events[0].timestamp === 'string' && events[0].timestamp.length > 0, 'timestamp present');
  });

  check('control arm: EVERY attempt appends another event', () => {
    setArmEnv('exp-gate-test-1', 'control');
    assert.throws(() => enforceExperimentArmRetrievalGate('dev_memory_capture', root));
    const events = readViolations(root);
    assert.equal(events.length, 2);
    assert.equal(events[1].command, 'dev_memory_capture');
  });

  check('control arm: non-memory command passes with no event', () => {
    setArmEnv('exp-gate-test-1', 'control');
    enforceExperimentArmRetrievalGate('story_list', root);
    assert.equal(readViolations(root).length, 2, 'no new event');
  });

  check('treatment arm: marked command passes with no event', () => {
    setArmEnv('exp-gate-test-1', 'treatment');
    enforceExperimentArmRetrievalGate('recall', root);
    assert.equal(readViolations(root).length, 2, 'no new event');
  });

  check('no experiment context: marked command passes with no event', () => {
    setArmEnv(undefined, undefined);
    enforceExperimentArmRetrievalGate('recall', root);
    assert.equal(readViolations(root).length, 2, 'no new event');
  });

  check('invalid arm value: treated as no experiment, marked command passes', () => {
    setArmEnv('exp-gate-test-1', 'CONTROL');
    enforceExperimentArmRetrievalGate('recall', root);
    assert.equal(readViolations(root).length, 2, 'no new event');
  });
} finally {
  setArmEnv(savedId, savedArm);
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`control-arm-retrieval-gate: ${failures} FAILED`);
  process.exit(1);
}
console.log('control-arm-retrieval-gate: ALL PASS');
