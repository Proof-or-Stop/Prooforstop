import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
const identity = await import(join(distRoot, 'core/agent-role-identity.js'));
const dispatch = await import(join(distRoot, 'core/agent-dispatch-registry.js'));

const registry = registryModule.readPromptRegistry();
assert.equal(registry.agents.length, 18, 'all canonical prompt templates are registered');
const manifest = registryModule.promptRegistryManifest();
assert.equal(manifest.schemaVersion, 'proof-or-stop.prompt-registry.v1', 'new prompt manifests use the canonical schema');
assert.equal(
  registryModule.canonicalPromptRegistrySchemaVersion('lattice.prompt-registry.v1'),
  null,
  'retired prompt-registry manifests fail closed',
);
for (const schemaVersion of ['lattice.prompt-registry.v1', 'proofbound.prompt-registry.v1']) {
  const retired = { ...manifest, schemaVersion };
  const before = JSON.stringify(retired);
  assert.equal(registryModule.normalizePromptRegistryManifest(retired), null);
  assert.equal(JSON.stringify(retired), before, 'rejected manifest input remains byte-equivalent');
}
assert.equal(registryModule.normalizePromptRegistryManifest(manifest).schemaVersion, manifest.schemaVersion);
assert.equal(
  registryModule.normalizePromptRegistryManifest({ ...manifest, source: 'lattice.prompt-registry' }),
  null,
  'prompt-registry manifests with a non-canonical source fail closed',
);
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
  /<!-- proof-or-stop:start -->[\s\S]*<!-- proof-or-stop:end -->/,
  'evaluator-cli render contains the load-bearing runtime guide',
);
const reviewChannel = registry.agents.find(entry => entry.file === 'proof-or-stop-review-channel.md');
assert.ok(reviewChannel, 'canonical review-channel prompt is registered');
assert.match(
  registryModule.renderPromptEntryForHost(reviewChannel, 'claude'),
  /<!-- proof-or-stop:start -->[\s\S]*<!-- proof-or-stop:end -->/,
  'review-channel render contains the canonical load-bearing runtime guide',
);
assert.doesNotMatch(
  registryModule.renderPromptEntryForHost(reviewChannel, 'claude'),
  /<!-- lattice:start -->[\s\S]*<!-- lattice:end -->/,
  'review-channel render does not emit legacy managed markers',
);
for (const entry of registry.agents) {
  assert.match(entry.file, /^proof-or-stop-[a-z0-9-]+\.md$/);
  assert.equal(entry.agentId, entry.agentId.trim());
  assert.equal(contracts.promptRoleContract(entry.agentId).roleId, entry.agentId);
}
const verificationIntent = registry.agents.find(entry => entry.agentId === 'proof-or-stop-verification-intent');
assert.ok(verificationIntent, 'canonical verification-intent prompt is registered');
const verificationIntentClaude = registryModule.renderPromptEntryForHost(verificationIntent, 'claude');
assert.equal(
  verificationIntentClaude,
  readFileSync(join(packageRoot, '..', '..', '.claude', 'agents', verificationIntent.file), 'utf8'),
  'prompt registry preserves exact Claude mirror bytes for the active verification-intent role',
);
assert.match(verificationIntentClaude, /verificationIntent/);
assert.match(verificationIntentClaude, /checklist_update/);
assert.doesNotMatch(verificationIntentClaude, /proof-or-stop-test-intent|proof-or-stop-test-case-reviewer|testIntent|testintent_/);
for (const legacyRole of ['proof-or-stop-test-intent', 'proof-or-stop-test-case-reviewer']) {
  const legacyEntry = registry.agents.find(entry => entry.agentId === legacyRole);
  assert.ok(legacyEntry, `${legacyRole} remains registered for compatibility reads`);
  const legacyPrompt = registryModule.renderPromptEntryForHost(legacyEntry, 'claude');
  assert.match(legacyPrompt, /Legacy compatibility identity/);
  assert.match(legacyPrompt, /not dispatchable/);
  assert.equal(contracts.promptRoleContract(legacyRole).status, 'compatibility');
}
for (const legacyType of ['proof-or-stop-test-intent', 'proof-or-stop-test-case-reviewer', 'test-intent', 'test-case-reviewer']) {
  assert.throws(
    () => dispatch.validateAgentDispatchRequest({ agentType: legacyType, phase: 'PLAN', itemId: 'CHK-001' }),
    legacyType.startsWith('proof-or-stop-')
      ? /legacy read-side identity.*proof-or-stop-verification-intent/
      : /unknown agentType/,
    `${legacyType} must fail closed for new PLAN dispatch`,
  );
}
assert.equal(
  identity.canonicalizeAgentRoleText('test-intentional product-reviewerish lattice-review-quality@host'),
  'test-intentional product-reviewerish lattice-review-quality@host',
  'role text is not silently rewritten into current authority',
);
for (const roleId of registryModule.MODULAR_COMPLEX_ROLE_IDS) {
  const entry = registry.agents.find(candidate => candidate.agentId === roleId);
  assert.ok(entry, `${roleId} complex role is registered`);
  for (const host of ['claude', 'codex']) {
    const rendered = registryModule.renderPromptEntryForHost(entry, host);
    assert.match(
      rendered,
      /<!-- proof-or-stop:modular-role-body:v1 -->/,
      `${roleId}/${host} default writer emits the canonical modular body`,
    );
    assert.doesNotMatch(
      rendered,
      /<!-- lattice:start -->[\s\S]*<!-- lattice:end -->/,
      `${roleId}/${host} default writer does not emit legacy managed markers`,
    );
  }
  const historicalConfig = {
    version: contracts.PROMPT_ENVELOPE_ROLLOUT_VERSION,
    roles: { [roleId]: 'legacy-full-context' },
  };
  const before = JSON.stringify(historicalConfig);
  assert.throws(() => contracts.resolvePromptRoleBody(roleId, historicalConfig), /unsupported mode/);
  assert.equal(JSON.stringify(historicalConfig), before, 'rejected rollout input remains unchanged');
}

for (const retiredRole of ['lattice-review-quality', 'proofbound-review-quality', 'verification-intent']) {
  assert.throws(() => contracts.resolvePromptRoleBody(retiredRole, undefined), /unknown prompt role/);
  assert.equal(contracts.isPromptRoleEligibleForReviewEvidence(retiredRole), false);
}
const modular = contracts.resolvePromptRoleBody('proof-or-stop-review-quality', {
  version: contracts.PROMPT_ENVELOPE_ROLLOUT_VERSION,
  roles: { 'proof-or-stop-review-quality': 'full-envelope' },
});
assert.equal(modular.roleId, 'proof-or-stop-review-quality');
assert.equal(modular.mode, 'full-envelope');
assert.equal(modular.bodyDigest.length, 64);
assert.equal(contracts.isPromptRoleEligibleForReviewEvidence(modular.roleId), true);
assert.throws(
  () => contracts.resolvePromptEnvelopeRolloutMode(modular.roleId, {
    version: contracts.PROMPT_ENVELOPE_ROLLOUT_VERSION,
    roles: { 'lattice-review-quality': 'full-envelope' },
  }),
  /unknown role/,
  'retired configuration keys cannot acquire a canonical lane',
);
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
  assert.equal(budget.isBudgetedComplexRole(legacy), false, `${legacy} is not an active budgeted role`);
  const canonicalObservation = budget.observeComplexRolePromptBudget({
    roleId: canonical,
    contextMode: 'full',
    bytes: 100,
    estimatedTokens: 25,
  });
  assert.equal(canonicalObservation.roleId, canonical);
  assert.equal(canonicalObservation.withinBudget, true);
}

console.log('prompt-role migration test passed');
