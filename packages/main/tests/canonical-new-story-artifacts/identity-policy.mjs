import { registeredIdentityOperationSourcePaths } from './identity-ownership.mjs';



import assert from 'node:assert/strict';
import { createPrivateMutationObserver } from ".././support/private-mutation-observer.mjs";

import { readFileSync, writeFileSync } from 'node:fs';


import { join } from 'node:path';



import ts from 'typescript';
import { assertActiveIdentityOperationOwnership } from ".././support/active-identity-operation-ownership.mjs";


import { check } from "./runner.mjs";
import { ensurePublicIdentityOperationFixture, snapshotPublicOperationState, assertCanonicalPublicIdentityOperations } from "./public-fixtures.mjs";
import { runCli } from "./fixture-support.mjs";
import { promptRegistry, promptRoleContracts, ACTIVE_IDENTITY_OPERATION_BOUNDARIES, IDENTITY_CUTOVER_REQUIRED_PATHS, PROJECT_CONFIG_IDENTITY_CASES, journalFixtureBase } from "./data.mjs";

export async function runCases() {
await check(['identity-cutover', 'identity-config-boundary', 'round24'], 'prompt config rejects unsupported user versions without fallback or mutation', () => {
  const fixture = ensurePublicIdentityOperationFixture();
  const configPath = join(fixture.root, 'proof-or-stop.config.json');
  const canonicalBytes = readFileSync(configPath);
  const config = JSON.parse(canonicalBytes.toString('utf8'));
  try {
    config.promptEnvelope.version = 'unsupported-config-version';
    writeFileSync(configPath, JSON.stringify(config));
    const before = snapshotPublicOperationState(fixture.root, ['B-49df']);
    const rejected = runCli(fixture.root, 'agent_prompt', { role: 'proof-or-stop-review-quality' }, {}, { entrypoint: fixture.entrypoint });
    assert.notEqual(rejected.status, 0, 'invalid prompt version must never fall back to default config');
    assert.match(`${rejected.stdout}${rejected.stderr}`, /unsupported promptEnvelope\.version: unsupported-config-version/u);
    assert.deepEqual(snapshotPublicOperationState(fixture.root, ['B-49df']), before, 'invalid prompt config changed runtime state');
  } finally {
    writeFileSync(configPath, canonicalBytes);
  }
});

await check(['identity-cutover', 'identity-policy', 'identity-policy-boundary', 'round24'], 'eager role policy rejection derives missing canonical sites without invented counterparts', () => {
  const expected = promptRegistry.readPromptRegistry().agents.map(entry => entry.agentId);
  assert.ok(expected.length > 2, 'role policy controls require independent package roles');
  const valid = Object.fromEntries(expected.map(id => [id, {}]));
  const validate = promptRoleContracts.validatePromptRolePolicyDefinition;
  assert.doesNotThrow(() => validate(valid, expected));
  const unknown = 'unregistered-policy-one';
  const sourceSite = id => `packages/main/src/core/prompt-role-contract-registry.ts#${id}`;
  const rejection = (policies, ids = expected) => {
    const before = JSON.stringify([policies, ids]);
    let message;
    assert.throws(() => validate(policies, ids), error => {
      assert.ok(error instanceof promptRoleContracts.PromptRoleContractRegistryError);
      message = error.message;
      return true;
    });
    assert.equal(JSON.stringify([policies, ids]), before, 'policy rejection mutated its inputs');
    return message;
  };
  const singleton = { ...valid, [unknown]: {} };
  delete singleton[expected[0]];
  assert.equal(rejection(singleton), `unknown prompt role policy "${unknown}"; missing canonical policy source sites: ${JSON.stringify([sourceSite(expected[0])])}`);
  assert.equal(rejection({ ...valid, [unknown]: {} }), `unknown prompt role policy "${unknown}"`, 'extra unknown keys must not invent a missing canonical counterpart');
  const multiple = { ...singleton, 'unregistered-policy-two': {} };
  delete multiple[expected[1]];
  assert.equal(rejection(multiple), `unknown prompt role policy "${unknown}"; missing canonical policy source sites: ${JSON.stringify(expected.slice(0, 2).map(sourceSite))}`, 'multiple missing policies must be labeled as a set, not paired with an unknown key');
  const missingOnly = { ...valid };
  delete missingOnly[expected[0]];
  assert.equal(rejection(missingOnly), `missing prompt role policy "${expected[0]}"`);
  assert.equal(rejection({ ...valid, [unknown]: {} }, [...expected, expected[0]]), `prompt registry contains duplicate role "${expected[0]}"`, 'duplicate expected roles must still reject before unknown policies');
});

await check(['identity-cutover', 'identity-consumer-smoke', 'identity-config-boundary', 'identity-policy-boundary', 'f050', 'round24'], 'normal consumer controls and invalid project configuration retain zero-mutation checks', () => {
  const registeredOperationPaths = registeredIdentityOperationSourcePaths(ACTIVE_IDENTITY_OPERATION_BOUNDARIES);
  assert.throws(() => registeredIdentityOperationSourcePaths(ACTIVE_IDENTITY_OPERATION_BOUNDARIES.filter(boundary => boundary.id !== 'release-ledgers')), /real public-operation owner/);
  assertActiveIdentityOperationOwnership(ACTIVE_IDENTITY_OPERATION_BOUNDARIES);
  assert.equal(registeredOperationPaths.includes('proof-or-stop.config.json'), false, 'dynamic config cannot be a required packaged executable');
  assert.deepEqual(
    [...IDENTITY_CUTOVER_REQUIRED_PATHS].filter((path) => !registeredOperationPaths.includes(path) && !PROJECT_CONFIG_IDENTITY_CASES.some(row => row.sourcePath === path)),
    [],
    'every required identity path must be exercised through a registered public operation',
  );
  assert.deepEqual(
    registeredOperationPaths.filter((path) => !IDENTITY_CUTOVER_REQUIRED_PATHS.includes(path)),
    [],
    'the public-operation matrix must not hide unreviewed source paths outside the required inventory',
  );

  const operationFixture = ensurePublicIdentityOperationFixture();
  const operationRuntimeRoot = operationFixture.root;
  const operationCliEnginePath = join(operationRuntimeRoot, 'packages', 'main', 'dist', 'cli-engine.js');
  const operationCliEngine = readFileSync(operationCliEnginePath, 'utf8');
  const rawIdentityPreflight = "        assertCanonicalActiveIdentityRuntime({ command: cmd || 'help', projectRoot: root0 });";
  assert.equal(
    operationCliEngine.split(rawIdentityPreflight).length - 1,
    1,
    'raw active-identity preflight ablation target drifted',
  );
  try {
  writeFileSync(
    operationCliEnginePath,
    operationCliEngine.replace(rawIdentityPreflight, '        // F-053 test ablation: prove the real command consumer rejects the injected identity.'),
  );
  const externalReadRoot = operationFixture.externalRoot;
  const operationEntrypoint = operationFixture.entrypoint;
  assertCanonicalPublicIdentityOperations(operationFixture, 'consumer preflight ablated');
  const observers = new Map();
  const observerFor = root => {
    if (!observers.has(root)) observers.set(root, createPrivateMutationObserver({
      root, snapshot: () => snapshotPublicOperationState(root, root === operationFixture.journalRoot ? [journalFixtureBase.storyId] : root === operationRuntimeRoot ? ['B-49df'] : []),
    }));
    return observers.get(root);
  };
  const configPath = join(operationRuntimeRoot, 'proof-or-stop.config.json');
  const configBytes = readFileSync(configPath);
  for (const inputCase of PROJECT_CONFIG_IDENTITY_CASES) {
    const config = JSON.parse(configBytes);
    const retired = inputCase.canonical.replace('proof-or-stop', ['proof', 'bound'].join(''));
    if (inputCase.field === 'role-key') {
      assert.ok(Object.hasOwn(config.promptEnvelope.roles, inputCase.canonical));
      config.promptEnvelope.roles[retired] = config.promptEnvelope.roles[inputCase.canonical];
      delete config.promptEnvelope.roles[inputCase.canonical];
    } else {
      assert.equal(config.promptEnvelope.version, inputCase.canonical);
      config.promptEnvelope.version = retired;
    }
    try {
      writeFileSync(configPath, JSON.stringify(config));
      const observer = observerFor(operationRuntimeRoot); const before = observer.before(configPath);
      const rejected = runCli(operationRuntimeRoot, 'agent_prompt', { role: 'proof-or-stop-review-quality' }, {}, { entrypoint: operationEntrypoint });
      assert.notEqual(rejected.status, 0, `${inputCase.siteId}: retired config accepted`);
      const diagnostic = `${rejected.stdout}${rejected.stderr}`;
      assert.ok(diagnostic.includes(retired) && diagnostic.includes('proof-or-stop.config.json') && diagnostic.includes('not admitted by prompt-runtime'), diagnostic);
      observer.after(before, `${inputCase.siteId}: rejection changed state`);
    } finally { writeFileSync(configPath, configBytes); }
    process.stdout.write(`PASS project config public mutation ${inputCase.siteId}\n`);
  }
  process.stdout.write('IDENTITY_OBSERVER_STATS ' + JSON.stringify([...observers.values()].map(o => o.stats)) + '\n');
  } finally { writeFileSync(operationCliEnginePath, operationCliEngine); }
});
}
