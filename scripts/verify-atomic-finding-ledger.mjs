import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { StoryStore } from '../packages/main/dist/core/store.js';
import * as ledgerApi from '../packages/main/dist/handlers/finding-ledger.js';
import { findingLedgerSignerFromWorkspace, verifyFindingLedgerReceipt } from '../packages/main/dist/core/finding-ledger.js';
import { acquireMkdirLock, captureMkdirLockFence } from '../packages/main/dist/core/mkdir-lock.js';
assert.equal(typeof ledgerApi.withAtomicFindingLedgerWrites, 'function', 'U04 requires atomic publication of multiple signed ledger writes');
const root = mkdtempSync(join(tmpdir(), 'atomic-finding-ledger-'));
let lock;
try {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const store = new StoryStore(root), storyId = 'B-atomic';
  const signer = findingLedgerSignerFromWorkspace(root);
  const lockDir = store.storyFilePath(storyId, 'findings.lock');
  lock = acquireMkdirLock(lockDir, { label: 'atomic ledger witness', requireHolderToken: true });
  const fence = captureMkdirLockFence(lockDir);
  const options = { storyId, store, signer, fence, writerSessionId: 'atomic-witness',
    writerLeaseId: 'atomic-witness', writerFenceToken: fence.writerFenceToken, operation: 'append_finding' };
  const append = (target, key, payload) => ledgerApi.appendFindingLedger({ ...options, store: target,
    idempotencyKey: key, records: [{ recordType: 'finding', payload }] });
  const rows = [1, 2].map(i => ({ id: `F-${i}`, desc: `Finding ${i}`, status: 'open', severity: 'high',
    category: 'adversarial', evidenceState: 'verified', agent: 'proof-or-stop-review-concept' }));
  assert.throws(() => ledgerApi.withAtomicFindingLedgerWrites({ store, storyId, fence }, target => {
    append(target, 'one', rows[0]);
    assert.equal(existsSync(store.findingLedgerPath(storyId)), false, 'prepared append has not touched disk');
    append(target, 'one', rows[1]);
  }), /IDEMPOTENCY_CONFLICT/);
  assert.equal(existsSync(store.findingLedgerPath(storyId)), false, 'a later refusal must publish none of the batch');
  const receipts = ledgerApi.withAtomicFindingLedgerWrites({ store, storyId, fence }, target =>
    rows.map((row, i) => append(target, `finding-${i}`, row)));
  const bytes = readFileSync(store.findingLedgerPath(storyId));
  assert.equal(store.readFindingLedger(storyId).receipts.length, 2);
  assert.deepEqual(store.readFindings(storyId).findings.map(f => f.status), ['open', 'open'], 'canonical reader trusts every individual signed carrier');
  assert.ok(receipts.every(receipt => verifyFindingLedgerReceipt(receipt, { ...signer, algorithm: 'ed25519' })));
  ledgerApi.withAtomicFindingLedgerWrites({ store, storyId, fence }, target =>
    rows.map((row, i) => append(target, `finding-${i}`, row)));
  assert.deepEqual(readFileSync(store.findingLedgerPath(storyId)), bytes, 'exact batch replay is byte-identical');
  console.log('PASS U04 atomic signed ledger publication and replay');
} finally { lock?.release(); rmSync(root, { recursive: true, force: true }); }
