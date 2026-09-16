import assert from 'node:assert/strict';
import { prepareVerification, verificationFailureMessage } from './verification-subprocess-budget.mjs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runProviderNeutralFixture } from './helpers/provider-neutral-fixture.mjs';

// The helper streams output instead of returning it. Require a create-only
// receipt from this exact fixture invocation, after its final assertions.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try { prepareVerification(root, { shareBuild: true }); }
catch (error) { console.error(verificationFailureMessage('inventory critic prerequisite', error)); process.exit(1); }
const directory = mkdtempSync(join(tmpdir(), 'critic-metadata-verifier-'));
const receiptPath = join(directory, 'completed.json');
const nonce = randomUUID();
const verify = receipt => {
  assert.equal(receipt.schemaVersion, 'inventory-critic-metadata-fixture.v1');
  assert.equal(receipt.nonce, nonce);
  assert.equal(receipt.selector, 'METADATA_HEAD_CRITIC_ADMISSION_PASS', 'target fixture selector is required');
  assert.equal(receipt.negativeControls, 20);
  assert.equal(receipt.waves, 2);
  assert.equal(receipt.criticReceipts, 2);
  assert.equal(receipt.state, 'FINALIZED');
};
try {
  const result = await runProviderNeutralFixture(
    join(root, 'packages/main/dist/tasks/review-inventory-handler-smoke.js'),
    ['--metadata-critic-admission-only', '--metadata-critic-receipt', receiptPath, '--metadata-critic-nonce', nonce],
    process.env, { timeoutMs: 840000 },
  );
  assert.equal(result.signal, null, 'inventory fixture must not terminate by signal');
  assert.equal(result.status, 0, 'inventory critic metadata HEAD regression failed; inspect the actual assertion above');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  verify(receipt);
  for (const mutation of [{ selector: 'other-suite' }, { nonce: 'old-run' }, { negativeControls: 0 }, { state: 'OPEN' }]) {
    assert.throws(() => verify({ ...receipt, ...mutation }));
    verify(receipt);
  }
  console.log('INVENTORY_CRITIC_METADATA_HEAD_GREEN');
} finally { rmSync(directory, { recursive: true, force: true }); }
