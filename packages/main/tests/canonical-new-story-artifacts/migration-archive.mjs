import { registeredIdentityOperationSourcePaths } from './identity-ownership.mjs';
import { selectedGroup } from './data.mjs';



import assert from 'node:assert/strict';
import { createPrivateMutationObserver } from ".././support/private-mutation-observer.mjs";

import { existsSync, readFileSync, writeFileSync } from 'node:fs';


import { join } from 'node:path';



import ts from 'typescript';
import { assertActiveIdentityOperationOwnership } from ".././support/active-identity-operation-ownership.mjs";


import { check } from "./runner.mjs";
import { ACTIVE_IDENTITY_OPERATION_BOUNDARIES, IDENTITY_CUTOVER_REQUIRED_PATHS, PROJECT_CONFIG_IDENTITY_CASES, journalFixtureBase, packageRoot, repoRoot } from "./data.mjs";
import { ensurePublicIdentityOperationFixture, assertCanonicalPublicIdentityOperations, snapshotPublicOperationState, activeIdentityBoundaryOperation } from "./public-fixtures.mjs";
import { runCli } from "./fixture-support.mjs";

export async function runCases() {
await check(['identity-migration-archive'], 'CHK-007:adversarial:0 every registered identity boundary rejects through its public operation with zero mutation', () => {
  const registeredOperationPaths = registeredIdentityOperationSourcePaths(ACTIVE_IDENTITY_OPERATION_BOUNDARIES);
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
  for (const boundary of ACTIVE_IDENTITY_OPERATION_BOUNDARIES) {
    assert.ok(
      Array.isArray(boundary.identitySites) && (boundary.identitySites.length > 0 || boundary.pathBindings.every(row => row.classification === 'identity-free')),
      `${boundary.id}: identity-site registry is required`,
    );
    assert.ok(
      Array.isArray(boundary.pathBindings) && boundary.pathBindings.length > 0,
      `${boundary.id}: path-to-identity-site bindings are required`,
    );
    const ownedPaths = boundary.paths.map((entry) => entry.sourcePath).sort();
    const boundPaths = boundary.pathBindings.map((entry) => entry.sourcePath).sort();
    assert.deepEqual(boundPaths, ownedPaths, `${boundary.id}: every registered path must have exactly one named identity-site binding`);
    assert.equal(new Set(boundPaths).size, boundPaths.length, `${boundary.id}: duplicate path binding`);
    const siteIds = boundary.identitySites.map((site) => site.siteId);
    assert.equal(new Set(siteIds).size, siteIds.length, `${boundary.id}: duplicate identity site id`);
    for (const binding of boundary.pathBindings) {
      if (binding.classification === 'owned-site') {
        assert.ok(binding.siteIds.length > 0, `${boundary.id}/${binding.sourcePath}: owned-site path has no sites`);
        for (const siteId of binding.siteIds) {
          assert.ok(siteIds.includes(siteId), `${boundary.id}/${binding.sourcePath}: unknown identity site ${siteId}`);
          assert.equal(
            boundary.identitySites.find((site) => site.siteId === siteId)?.sourcePath,
            binding.sourcePath,
            `${boundary.id}/${binding.sourcePath}: owned identity site points at another path`,
          );
        }
      } else {
        assert.equal(binding.classification, 'identity-free', `${boundary.id}/${binding.sourcePath}: unknown path classification`);
        assert.ok(binding.evidence, `${boundary.id}/${binding.sourcePath}: identity-free rationale required`);
        const path = boundary.paths.find(row => row.sourcePath === binding.sourcePath);
        const absolute = join(path.scope === 'runtime-package' ? packageRoot : repoRoot, path.path);
        assert.doesNotMatch(readFileSync(absolute, 'utf8'), /proof-or-stop[.-]/,
          `${boundary.id}/${binding.sourcePath}: emitted delegate must remain identity-free`);
      }
    }
    assert.deepEqual(
      [...new Set(boundary.retiredIdentityCases.map((entry) => entry.siteId))].sort(),
      [...siteIds].sort(),
      `${boundary.id}: every identity site must have a canonical-to-retired public-operation mutation case`,
    );
    assert.ok(
      Array.isArray(boundary.retiredIdentityCases) && (boundary.retiredIdentityCases.length > 0 || boundary.pathBindings.every(row => row.classification === 'identity-free')),
      `${boundary.id}: public-operation coverage must declare the boundary's actual canonical and retired identity values`,
    );
    const [defaultCommand, payload] = activeIdentityBoundaryOperation(boundary.id, 'B-49df');
    // Zero-literal delegates still require real public-operation mutation proof.
    // Valid JavaScript changes the executable binding without adding an identity.
    for (const binding of boundary.pathBindings.filter(row => row.classification === 'identity-free')) {
      const path = boundary.paths.find(row => row.sourcePath === binding.sourcePath);
      const injectedPath = join(path.scope === 'runtime-package' ? join(operationRuntimeRoot, 'packages/main') : operationRuntimeRoot, path.path);
      const original = readFileSync(injectedPath);
      const operationRoot = boundary.id === 'process-fact-registry' ? externalReadRoot : operationRuntimeRoot;
      const observer = observerFor(operationRoot);
      try {
        writeFileSync(injectedPath, `${original}\nvoid 1;\n`);
        const before = observer.before(injectedPath);
        const result = runCli(operationRoot, defaultCommand, payload, {}, { entrypoint: operationEntrypoint });
        assert.notEqual(result.status, 0, `${boundary.id}: identity-free executable mutation admitted`);
        const diagnostic = `${result.stdout}${result.stderr}`;
        assert.ok(diagnostic.includes(binding.sourcePath) && diagnostic.includes('executable declaration/producer/consumer binding changed'), diagnostic);
        observer.after(before, `${boundary.id}: rejected delegate changed state`);
      } finally { writeFileSync(injectedPath, original); }
      process.stdout.write(`PASS identity-free public executable mutation ${boundary.id}/${binding.sourcePath}\n`);
    }
    // Imported authorities require BOTH a consumer-expression mutation and an
    // origin-only mutation with the consuming expression left byte-identical.
    // The latter reproduced an actual accepted retired pinn_claim_check schema.
    for (const identityCase of boundary.retiredIdentityCases.flatMap(site => site.identityOrigin
      ? [site, { ...site, originMutation: true, sourceNeedle: site.canonical, retiredNeedle: site.retired }]
      : [site])) {
      const caseStartedAt = Date.now();
      assert.ok(siteIds.includes(identityCase.siteId), `${boundary.id}: mutation case has unknown siteId ${identityCase.siteId}`);
      assert.equal(
        boundary.identitySites.find((site) => site.siteId === identityCase.siteId)?.sourcePath,
        identityCase.sourcePath,
        `${boundary.id}/${identityCase.siteId}: mutation case must alter the registered identity-site owner`,
      );
      const command = identityCase.command ?? defaultCommand;
      assert.ok(boundary.commands.includes(command), `${boundary.id}: identity case command is not owned by the boundary: ${command}`);
      const registeredPath = boundary.paths.find((candidate) => candidate.sourcePath === identityCase.sourcePath);
      assert.ok(registeredPath, `${boundary.id}: identity case source is not owned by the boundary: ${identityCase.sourcePath}`);
      const base = registeredPath.scope === 'runtime-package'
        ? join(operationRuntimeRoot, 'packages', 'main')
        : operationRuntimeRoot;
      const injectedPath = identityCase.originMutation
        ? join(base, identityCase.identityOrigin.sourcePath.replace(/^packages\/main\/src\//u, 'dist/').replace(/\.ts$/u, '.js'))
        : join(base, registeredPath.path);
      const consumerBytes = readFileSync(join(base, registeredPath.path));
      assert.ok(existsSync(injectedPath), `${boundary.id}: registered runtime path missing: ${registeredPath.path}`);
      const canonicalBytes = readFileSync(injectedPath);
      const canonicalSource = canonicalBytes.toString('utf8');
      assert.ok(
        canonicalSource.includes(identityCase.sourceNeedle),
        `${boundary.id}/${registeredPath.sourcePath}: canonical identity source needle is not present: ${identityCase.sourceNeedle}`,
      );
      assert.notEqual(identityCase.retired, identityCase.canonical, `${boundary.id}: retired identity must differ`);
      assert.ok(['historical-retired', 'unsupported-family-control'].includes(identityCase.mutationKind), `${boundary.id}: identity mutation must disclose its provenance kind`);
      if (identityCase.mutationKind === 'historical-retired') {
        assert.equal(identityCase.retiredProvenance?.sourcePath, identityCase.identityOrigin?.sourcePath ?? identityCase.sourcePath, 'historical counterpart must belong to this exact source or bound imported origin');
        assert.equal(identityCase.retiredProvenance?.value, identityCase.retired, 'historical counterpart must match the injected value');
      } else {
        assert.equal(identityCase.retiredProvenance, undefined, 'constructed invalid-family control must not claim historical admission');
        assert.ok(identityCase.retired.startsWith('proofbound.') || identityCase.retired.startsWith('proofbound-'), `${boundary.id}: constructed control must name the unsupported family`);
      }
      assert.ok(
        canonicalSource.split(identityCase.sourceNeedle).length - 1 >= 1,
        `${boundary.id}/${identityCase.siteId}: identity source needle must occur`,
      );
      const exactNeedle = identityCase.sourceNeedle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const mutationPattern = identityCase.sourceNeedle === identityCase.canonical
        ? new RegExp(`(?<![a-zA-Z0-9._-])${exactNeedle}(?![a-zA-Z0-9._-])`, 'gu')
        : new RegExp(exactNeedle, 'gu');
      const injectedSource = canonicalSource.replace(mutationPattern, () => identityCase.retiredNeedle);
      assert.notEqual(injectedSource, canonicalSource, `${identityCase.siteId}: exact identity mutation must change bytes`);
      writeFileSync(injectedPath, injectedSource);
      if (identityCase.originMutation) assert.deepEqual(readFileSync(join(base, registeredPath.path)), consumerBytes, `${identityCase.siteId}: origin-only control changed the consumer expression`);
      const operationRoot = boundary.id === 'canonical-journal-authority' ? operationFixture.journalRoot : boundary.id === 'process-fact-registry' ? externalReadRoot : operationRuntimeRoot;
      const observer = observerFor(operationRoot);
      const beforeOperation = observer.before(injectedPath);
      const rejected = runCli(operationRoot, command, payload, {}, { entrypoint: operationEntrypoint });
      assert.notEqual(
        rejected.status,
        0,
        `${boundary.id}/${registeredPath.sourcePath}: ${command} accepted ${identityCase.retired}`,
      );
      const diagnostic = `${rejected.stdout}${rejected.stderr}`;
      assert.ok(diagnostic.includes(identityCase.siteId) && diagnostic.includes(identityCase.retired) && diagnostic.includes(identityCase.canonical),
        `${boundary.id}/${identityCase.siteId}: ${command} did not identify the exact injected site, retired and canonical values:\n${diagnostic}`);
      observer.after(
        beforeOperation,
        `${boundary.id}/${registeredPath.sourcePath}: ${command} changed Git, Story, lock, or runtime state`,
      );
      writeFileSync(injectedPath, canonicalBytes);
      process.stdout.write(`PASS exact public identity mutation ${identityCase.siteId} (${identityCase.originMutation ? 'origin-only' : 'consumer-source'}) elapsedMs=${Date.now() - caseStartedAt}\n`);
    }
  }
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
});
}
