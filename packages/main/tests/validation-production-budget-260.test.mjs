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
assert.ok(scripts['test:serial-reference'].includes('npm run test:reviewed-source-bindings'));
assert.ok(scripts['test:reviewed-source-bindings'].endsWith(' && npm run test:validation-production-budget-260'));
// Replay the actual consumer, including every package/lockfile/excerpt binding.
await import(new URL('scripts/verify-validation-static-edges.mjs', root));
assert.equal(process.exitCode ?? 0, 0, 'the actual static-edge verifier must pass');
console.log('PRODUCTION_VALIDATION_260_GREEN: all three complete production commands use 260000 ms; static configuration bindings match');
