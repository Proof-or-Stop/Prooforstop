import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const sunset = await import(join(distRoot, 'core/legacy-role-alias-sunset.js'));
const identity = await import(join(distRoot, 'core/agent-role-identity.js'));
const processFacts = await import(join(distRoot, 'core/process-fact-registry.js'));

const releases = [
  { fromVersion: '0.3.269', toVersion: '0.3.270', released: true },
  { fromVersion: '0.3.270', toVersion: '0.3.271', released: true },
];

const blocked = sunset.evaluateLegacyRoleAliasSunset({
  references: [{ roleId: 'lattice-review-quality@historical', terminal: false }],
  releaseObservations: releases,
});
assert.equal(blocked.legacyAliasesReadable, true);
assert.equal(blocked.removalEligible, false);
assert.equal(blocked.nonTerminalLegacyReferenceCount, 1);
assert.deepEqual(blocked.blockers, ['non-terminal-legacy-references']);

const eligible = sunset.evaluateLegacyRoleAliasSunset({
  references: [{ roleId: 'lattice-review-quality@historical', terminal: true }],
  releaseObservations: [...releases, releases[1]],
});
assert.equal(eligible.removalEligible, true);
assert.equal(eligible.nonTerminalLegacyReferenceCount, 0);
assert.equal(eligible.releasedCliPatchObservationCount, 2);

const insufficient = sunset.evaluateLegacyRoleAliasSunset({
  references: [],
  releaseObservations: [
    releases[0],
    { fromVersion: '0.3.271', toVersion: '0.3.273', released: true },
    { fromVersion: '0.3.270', toVersion: '0.3.271', released: false },
  ],
});
assert.equal(insufficient.removalEligible, false);
assert.equal(insufficient.releasedCliPatchObservationCount, 1);
assert.ok(insufficient.blockers.includes('insufficient-released-cli-patch-observations'));

assert.equal(
  identity.canonicalAgentRoleId('verification-intent'),
  'proof-or-stop-verification-intent',
);
assert.equal(
  processFacts.getProcessFactRegistryEntry('runtime:legacy_role_alias_sunset_contract')?.producer,
  'core/legacy-role-alias-sunset',
);
assert.equal(
  processFacts.hasProcessFactSemantic('runtime:legacy_role_alias_sunset_contract', 'schema-contract'),
  true,
);

console.log('legacy role alias sunset contract test passed');
