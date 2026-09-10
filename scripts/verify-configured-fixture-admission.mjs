import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeConfiguredValidationCommands } from '../packages/main/dist/core/validation-command-config.js';
import { runValidationCommand } from '../packages/main/dist/core/validation-executor.js';

const cases = [
  ['packages/main/dist/tasks/tool-executed-evidence-receipt-smoke.js', 'tool-executed-evidence-receipt-smoke: PASS'],
  ['packages/main/dist/tasks/validate-command-timeout-smoke.js', 'validate-command-timeout smoke passed:'],
  ['packages/main/dist/tasks/validate-focused-full-layering-smoke.js', 'validate-focused-full-layering smoke passed:'],
  ['packages/main/dist/tasks/done-required-validation-smoke.js', 'done-required-validation smoke passed'],
  ['packages/main/dist/tasks/validate-parallel-equivalence-smoke.js', 'validate-parallel-equivalence: PASS'],
  ['packages/main/dist/tasks/validation-protocol-smoke.js', 'validation protocol smoke passed'],
  ['packages/main/tests/red/red-B-7dff-sequential-validate-plan.mjs', 'red-B-7dff-sequential-validate-plan PASS'],
  ['packages/main/tests/validate-plan-scheduling.test.mjs', 'validate-plan-scheduling: PASS'],
  ['packages/main/tests/validate-pollution-attribution.test.mjs', 'validate-pollution-attribution: PASS'],
  ['packages/main/tests/red/red-w2d-command-readonly.mjs', 'red-w2d-command-readonly: CANONICAL PASS'],
];
const commands = normalizeConfiguredValidationCommands(JSON.parse(readFileSync('proof-or-stop.config.json', 'utf8')));
for (const [entry, marker] of cases) {
  const matches = commands.filter(command => command.args?.[1] === entry);
  assert.equal(matches.length, 1, `one configured fixture: ${entry}`);
  assert.equal(matches[0].args[0], 'scripts/run-validation-fixture-suite.mjs');
  console.log(`START configured fixture ${entry}`);
  const result = await runValidationCommand(matches[0], process.cwd());
  assert.equal(result.code, 0, `${entry}\n${result.output}`);
  assert.ok(result.output.includes(marker), `${entry}: missing original completion marker\n${result.output}`);
  console.log(`PASS configured fixture ${entry} (${result.durationMs}ms)`);
}
