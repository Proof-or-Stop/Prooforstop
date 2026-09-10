import assert from 'node:assert/strict';
import { resolvePromptRoleBody, PROMPT_ENVELOPE_ROLLOUT_VERSION } from '../packages/main/dist/core/prompt-role-contract-registry.js';
import { MODULAR_REVIEWER_ROLE_IDS, MODULAR_COMPLEX_ROLE_IDS } from '../packages/main/dist/core/prompt-registry.js';
for (const role of new Set([...MODULAR_REVIEWER_ROLE_IDS, ...MODULAR_COMPLEX_ROLE_IDS])) {
  let resolved;
  assert.doesNotThrow(() => {
    resolved = resolvePromptRoleBody(role, { version: PROMPT_ENVELOPE_ROLLOUT_VERSION, roles: { [role]: 'legacy-full-context' } });
  }, `Lab legacy prompt reconstruction must verify: ${role}`);
  assert.ok(resolved.body.length > 100);
  if (role === 'proof-or-stop-review-test-coverage') {
    for (const obligation of ['thresholds', 'membership', 'freshness', 'mode-invariant', 'enforce-only', 'rollback', '3 rounds × 2 hosts']) {
      assert.ok(resolved.body.includes(obligation), `coverage body retains ${obligation}`);
    }
  }
}
console.log('PASS Lab legacy prompt reconstruction');
