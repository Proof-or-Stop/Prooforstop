import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeConfiguredValidationCommands } from '../packages/main/dist/core/validation-command-config.js';
import { runValidationCommand } from '../packages/main/dist/core/validation-executor.js';

const commands = normalizeConfiguredValidationCommands(JSON.parse(readFileSync('proof-or-stop.config.json', 'utf8')));
const matches = commands.filter(command => command.args?.[0] === 'scripts/run-precert-fast.mjs');
assert.equal(matches.length, 1, 'one canonical precert aggregate');
assert.deepEqual(matches[0].resources, [{ class: 'git-common-dir', key: '.', access: 'shared' }]);
const result = await runValidationCommand(matches[0], process.cwd());
assert.equal(result.code, 0, result.output);
assert.match(result.output, /PRE_CERT_FAST_SET=PASS/);
console.log('PASS canonical validation aggregate admits the complete real precert leaf set');
