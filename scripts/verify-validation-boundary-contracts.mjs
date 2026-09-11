import assert from 'node:assert/strict';
import { configuredValidationCommands } from '../packages/main/dist/handlers/validation-identity.js';
import { runValidationCommand } from '../packages/main/dist/core/validation-executor.js';

// Replay the actual registered leaves, including their fixture isolation wrapper.
const configured = configuredValidationCommands(process.cwd());
const failures = [];
for (const target of [
  'packages/main/dist/tasks/validate-command-timeout-smoke.js',
  'packages/main/tests/validate-resource-claims.test.mjs',
]) {
  const matches = configured.filter(command => command.args.includes(target));
  assert.equal(matches.length, 1, `unique configured target: ${target}`);
  const result = await runValidationCommand(matches[0], process.cwd());
  console.log(JSON.stringify({ target, code: result.code, durationMs: result.durationMs }));
  if (result.code !== 0) failures.push(`${target}\n${result.output}`);
}
assert.equal(failures.length, 0, `VALIDATION_BOUNDARY_CONTRACT_FAILURE\n${failures.join('\n')}`);
console.log('VALIDATION_BOUNDARY_CONTRACTS_PASS');
