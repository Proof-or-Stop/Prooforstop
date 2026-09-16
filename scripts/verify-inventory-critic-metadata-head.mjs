import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { runProviderNeutralFixture } from './helpers/provider-neutral-fixture.mjs';

// Build this checkout and run only disposable fixtures. The existing neutral
// launcher lets fixture broker identities exercise both host families without
// borrowing the developer's native provider ancestry.
execFileSync(process.execPath, ['scripts/ensure-dist.mjs'], { stdio: 'inherit' });
const result = await runProviderNeutralFixture(
  'packages/main/dist/tasks/review-inventory-handler-smoke.js',
  ['--lifecycle-only'], process.env, { timeoutMs: 840000 },
);
assert.equal(result.signal, null, 'inventory fixture must not terminate by signal');
assert.equal(result.status, 0, 'inventory critic metadata HEAD regression failed; inspect the actual assertion above');
console.log('INVENTORY_CRITIC_METADATA_HEAD_GREEN');
