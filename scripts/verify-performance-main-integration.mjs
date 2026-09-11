import { assertCanonicalActiveIdentityBoundary } from '../packages/main/dist/core/runtime-environment-checks.js';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
// Exercise the real production boundary; a stale compiled checklist pin blocks valid consumers.
assertCanonicalActiveIdentityBoundary({ boundaryId: 'review-inventory-epoch', runtimePackageRoot: resolve('packages/main') });
console.log('PERFORMANCE_MAIN_INTEGRATION_GREEN valid inventory consumer accepted');

// Replay integration-specific negatives and the incoming owner-session behavior on candidate and main.
for (const test of [
  'packages/main/tests/checklist-pin-integration.mjs',
  'packages/main/tests/certification-mutator-identity.mjs',
  'packages/main/tests/validation-tree-delegate-binding.mjs',
  'packages/main/dist/tasks/story-owner-lease-smoke.js',
  'scripts/verify-runtime-fact-contract.mjs',
]) {
 const result = spawnSync(process.execPath, [test], { stdio: 'inherit' });
 if (result.error || result.signal || result.status !== 0) throw new Error(`Integration regression failed: ${test}`);
}
console.log('PERFORMANCE_MAIN_INTEGRATION_REGRESSIONS_GREEN');
