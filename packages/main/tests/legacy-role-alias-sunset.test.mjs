import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const sunset = await import(join(distRoot, 'core/legacy-role-alias-sunset.js'));
const identity = await import(join(distRoot, 'core/agent-role-identity.js'));
const processFacts = await import(join(distRoot, 'core/process-fact-registry.js'));
const dispatch = await import(join(distRoot, 'core/agent-dispatch-registry.js'));

const releases = [
  { fromVersion: '0.3.269', toVersion: '0.3.270', released: true },
  { fromVersion: '0.3.270', toVersion: '0.3.271', released: true },
];

const blocked = sunset.evaluateLegacyRoleAliasSunset({
  references: [{ roleId: 'lattice-review-quality@historical', terminal: false }],
  releaseObservations: releases,
});
assert.equal(blocked.legacyAliasesReadable, false);
assert.equal(blocked.removalEligible, false);
assert.equal(blocked.nonTerminalLegacyReferenceCount, 1);
assert.deepEqual(blocked.blockers, ['non-terminal-legacy-references']);

const eligible = sunset.evaluateLegacyRoleAliasSunset({
  references: [{ roleId: 'lattice-review-quality@historical', terminal: true }],
  releaseObservations: [...releases, releases[1]],
});
assert.equal(eligible.removalEligible, true);
assert.equal(eligible.legacyAliasesReadable, false, 'terminal historical observations cannot grant current alias authority');
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
  'verification-intent',
);
assert.equal(dispatch.resolveAgentDispatchType('proof-or-stop-verification-intent').canonicalType, 'proof-or-stop-verification-intent');
const canonical = sunset.evaluateLegacyRoleAliasSunset({
  references: [{ roleId: 'proof-or-stop-review-quality', terminal: false }],
  releaseObservations: releases,
});
assert.equal(canonical.nonTerminalLegacyReferenceCount, 0);
assert.equal(canonical.removalEligible, true);
assert.equal(canonical.legacyAliasesReadable, false);
for (const roleId of ['lattice-review-quality', 'verification-intent', 'proofbound-review-quality', 'unknown-review-role']) {
  const input = { references: [{ roleId, terminal: false }], releaseObservations: releases };
  const before = JSON.stringify(input);
  const result = sunset.evaluateLegacyRoleAliasSunset(input);
  assert.equal(result.nonTerminalLegacyReferenceCount, 1, `${roleId} remains a conservative unresolved observation`);
  assert.equal(result.removalEligible, false);
  assert.equal(result.legacyAliasesReadable, false);
  assert.throws(() => dispatch.resolveAgentDispatchType(roleId), /unknown agentType/);
  assert.equal(JSON.stringify(input), before, 'observation and admission checks preserve input bytes');
}
assert.equal(
  processFacts.getProcessFactRegistryEntry('runtime:legacy_role_alias_sunset_contract')?.producer,
  'core/legacy-role-alias-sunset',
);
assert.equal(
  processFacts.hasProcessFactSemantic('runtime:legacy_role_alias_sunset_contract', 'schema-contract'),
  true,
);

console.log('legacy role alias sunset contract test passed');
