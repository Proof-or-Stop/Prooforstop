import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = new URL('../../../', import.meta.url);
const configBytes = readFileSync(new URL('proof-or-stop.config.json', root));
const config = JSON.parse(configBytes);
const targets = [
  ['scripts/verify-process-fact-contract.mjs', '--quiet'],
  ['packages/main/dist/tasks/red-evidence-target-binding-smoke.js', '--canonical-core'],
  ['packages/main/dist/tasks/red-evidence-envelope-smoke.js', '--canonical-core'],
];
for (const args of targets) {
  const matches = config.validate.commands.filter(row => row.command === 'node' && JSON.stringify(row.args) === JSON.stringify(args));
  assert.equal(matches.length, 1, `one complete canonical command required: ${args[0]}`);
  assert.equal(matches[0].timeoutMs, 260000, `PRODUCTION_VALIDATION_BUDGET_MISMATCH: ${args[0]}`);
}
const manifest = JSON.parse(readFileSync(new URL('scripts/lab/u18-static-edges/exceptions.json', root)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(manifest.configDigest, hash(JSON.stringify(config.validate.commands)), 'static inventory must bind the exact production budgets');
for (const entry of manifest.entries) {
  if (Object.hasOwn(entry.dependencyDigests ?? {}, 'proof-or-stop.config.json')) {
    assert.equal(entry.dependencyDigests['proof-or-stop.config.json'], hash(configBytes), `configuration source binding must remain current: ${entry.id}`);
  }
  for (const evidence of entry.requiredEvidence ?? []) {
    if (evidence?.file !== 'proof-or-stop.config.json') continue;
    assert.equal(evidence.sourceDigest, hash(configBytes));
    assert.equal(evidence.excerpt, configBytes.toString('utf8').split('\n').slice(evidence.startLine - 1, evidence.endLine).join('\n'));
  }
}
const scripts = JSON.parse(readFileSync(new URL('package.json', root))).scripts;
assert.equal(scripts['test:validation-production-budget-260'], 'node packages/main/tests/validation-production-budget-260.test.mjs');
const guards = config.validate.commands.filter(row => row.command === 'node'
  && JSON.stringify(row.args) === JSON.stringify(['packages/main/tests/validation-production-budget-260.test.mjs']));
assert.equal(guards.length, 1, 'production validation must register the budget guard');
for (const key of ['package.json', 'proof-or-stop.config.json']) {
  assert.ok(guards[0].resources.some(row => row.class === 'fixed-path' && row.key === key && row.access === 'shared'));
}
// Replay the actual consumer, including every package/lockfile/excerpt binding.
let verifierOutput = '';
const originalWrite = process.stdout.write;
process.stdout.write = function (...args) {
  verifierOutput += String(args[0]);
  return originalWrite.apply(this, args);
};
try { await import(new URL('scripts/verify-validation-static-edges.mjs', root)); }
finally { process.stdout.write = originalWrite; }
assert.equal(process.exitCode ?? 0, 0, 'the actual static-edge verifier must pass');
assert.match(verifierOutput, /^U18_STATIC_PASS$/m, 'an inert verifier import cannot supply GREEN');
console.log('PRODUCTION_VALIDATION_260_GREEN: all three complete production commands use 260000 ms; static configuration bindings match');
