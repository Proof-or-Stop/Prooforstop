import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const distName = existsSync(join(packageRoot, 'dist', 'core', 'prompt-registry.js'))
  ? 'dist'
  : 'dist.staging';
const distRoot = join(packageRoot, distName);

const registryModule = await import(join(distRoot, 'core/prompt-registry.js'));
const contracts = await import(join(distRoot, 'core/prompt-role-contract-registry.js'));
const budget = await import(join(distRoot, 'core/prompt-budget.js'));

const registry = registryModule.readPromptRegistry();
assert.equal(registry.agents.length, 17, 'all canonical prompt templates are registered');
const manifest = registryModule.promptRegistryManifest();
assert.equal(manifest.schemaVersion, 'proof-or-stop.prompt-registry.v1', 'new prompt manifests use the canonical schema');
assert.equal(
  registryModule.canonicalPromptRegistrySchemaVersion('lattice.prompt-registry.v1'),
  'proof-or-stop.prompt-registry.v1',
  'legacy prompt-registry manifests remain readable through the canonicalizer',
);
assert.equal(registryModule.normalizePromptRegistryManifest({
  ...manifest,
  schemaVersion: 'lattice.prompt-registry.v1',
}).schemaVersion, 'proof-or-stop.prompt-registry.v1', 'legacy manifest records normalize without rewriting their stored bytes');
assert.equal(registryModule.canonicalPromptRegistrySchemaVersion('proof-or-stop.prompt-registry.v99'), null, 'unknown prompt-registry schemas fail closed');
for (const entry of registry.agents) {
  for (const host of ['claude', 'codex']) {
    assert.doesNotMatch(
      registryModule.renderPromptEntryForHost(entry, host),
      /lattice:start-slot/,
      `${entry.file} ${host} render must not expose an unexpanded guide slot`,
    );
  }
}
const evaluatorCli = registry.agents.find(entry => entry.file === 'proof-or-stop-evaluator-cli.md');
assert.ok(evaluatorCli, 'canonical evaluator-cli prompt is registered');
assert.match(
  registryModule.renderPromptEntryForHost(evaluatorCli, 'claude'),
  /<!-- lattice:start -->[\s\S]*<!-- lattice:end -->/,
  'evaluator-cli render contains the load-bearing runtime guide',
);
for (const entry of registry.agents) {
  assert.match(entry.file, /^proof-or-stop-[a-z0-9-]+\.md$/);
  assert.equal(entry.agentId, entry.agentId.trim());
  assert.equal(contracts.promptRoleContract(entry.agentId).roleId, entry.agentId);
}

const legacy = contracts.resolvePromptRoleBody('lattice-review-quality', undefined);
assert.equal(legacy.roleId, 'proof-or-stop-review-quality');
assert.equal(legacy.mode, 'legacy-full-context');
assert.equal(legacy.legacyBytesRestored, true);
assert.ok(legacy.bodyDigest.length > 0);

const modular = contracts.resolvePromptRoleBody('lattice-review-quality', {
  version: contracts.PROMPT_ENVELOPE_ROLLOUT_VERSION,
  roles: { 'proof-or-stop-review-quality': 'full-envelope' },
});
assert.equal(modular.roleId, 'proof-or-stop-review-quality');
assert.equal(modular.mode, 'full-envelope');
assert.equal(modular.legacyBytesRestored, false);
assert.notEqual(modular.bodyDigest, legacy.bodyDigest);
assert.equal(contracts.isPromptRoleEligibleForReviewEvidence('lattice-review-quality'), true);
for (const role of [
  'story-init',
  'scope-plan',
  'implementer',
  'delivery',
]) {
  const canonical = role === 'implementer'
    ? 'proof-or-stop-implementer'
    : `proof-or-stop-review-${role}`;
  const legacy = role === 'implementer'
    ? 'lattice-implementer'
    : `lattice-review-${role}`;
  assert.equal(budget.isBudgetedComplexRole(canonical), true, `${canonical} is budgeted`);
  assert.equal(budget.isBudgetedComplexRole(legacy), true, `${legacy} remains readable for budget observation`);
  const canonicalObservation = budget.observeComplexRolePromptBudget({
    roleId: canonical,
    contextMode: 'full',
    bytes: 100,
    estimatedTokens: 25,
  });
  const legacyObservation = budget.observeComplexRolePromptBudget({
    roleId: legacy,
    contextMode: 'full',
    bytes: 100,
    estimatedTokens: 25,
  });
  assert.deepEqual(legacyObservation, canonicalObservation, `${legacy} and ${canonical} have equivalent budget observations`);
}

console.log('prompt-role migration test passed');
