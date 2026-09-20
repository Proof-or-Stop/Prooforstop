import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RESOURCE_POLICY } from '../packages/main/dist/tasks/full-suite-runner.js';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root)));
const config = JSON.parse(readFileSync(new URL('proof-or-stop.config.json', root)));
const name = 'test:benchmark-behavior';
assert.equal(pkg.scripts[name], 'node scripts/verify-benchmark-behavior.mjs', 'BENCHMARK_ROUTINE_REGISTRATION_RED: behavior suite must be executable');
assert.equal(pkg.scripts['test:serial-reference'].split(' && ').filter(s => s === `npm run ${name}`).length, 1);
assert(RESOURCE_POLICY[name], 'Canonical member needs an explicit resource policy');
assert.equal(config.validate.commands.filter(c => c.command === 'node' && JSON.stringify(c.args) === JSON.stringify(['scripts/verify-benchmark-behavior.mjs'])).length, 1);
for (const member of ['real-entry', 'shared-budget', 'budget-adversarial', 'managed-entry', 'exception-usage', 'audit-paths']) {
  assert.equal(pkg.scripts[`test:benchmark-${member}`], `node scripts/verify-benchmark-${member}.mjs`);
}
console.log('BENCHMARK_ROUTINE_REGISTRATION_GREEN npm test inventory and routine validation own behavioral coverage');
