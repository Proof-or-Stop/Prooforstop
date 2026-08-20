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

const registry = registryModule.readPromptRegistry();
assert.equal(registry.agents.length, 17, 'all canonical prompt templates are registered');
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

console.log('prompt-role migration test passed');
