import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { StoryStore } from '../packages/main/dist/core/store.js';
import * as ledgerApi from '../packages/main/dist/handlers/finding-ledger.js';
import { canonicalHash, findingLedgerSignerFromWorkspace, verifyFindingLedgerReceipt } from '../packages/main/dist/core/finding-ledger.js';
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
  let publications = 0;
  const receipts = ledgerApi.withAtomicFindingLedgerWrites({ store, storyId, fence, commitOptions: { beforeRename() {
    publications++;
    assert.equal(existsSync(store.findingLedgerPath(storyId)), false, 'observer sees no partial batch before the one rename');
  } } }, target =>
    rows.map((row, i) => append(target, `finding-${i}`, row)));
  assert.equal(publications, 1, 'the whole batch has one durable publication');
  const bytes = readFileSync(store.findingLedgerPath(storyId));
  assert.equal(store.readFindingLedger(storyId).receipts.length, 2);
  assert.deepEqual(store.readFindings(storyId).findings.map(f => f.status), ['open', 'open'], 'canonical reader trusts every individual signed carrier');
  assert.ok(receipts.every(receipt => verifyFindingLedgerReceipt(receipt, { ...signer, algorithm: 'ed25519' })));
  ledgerApi.withAtomicFindingLedgerWrites({ store, storyId, fence }, target =>
    rows.map((row, i) => append(target, `finding-${i}`, row)));
  assert.deepEqual(readFileSync(store.findingLedgerPath(storyId)), bytes, 'exact batch replay is byte-identical');
  assert.throws(() => ledgerApi.withAtomicFindingLedgerWrites({ store, storyId, fence,
    commitOptions: { beforeRename() { throw new Error('injected publication failure'); } } }, target => {
    append(target, 'third', { ...rows[0], id: 'F-3' });
    append(target, 'fourth', { ...rows[1], id: 'F-4' });
  }), /injected publication failure/);
  assert.deepEqual(readFileSync(store.findingLedgerPath(storyId)), bytes, 'failed publication retains complete old envelope');
  ledgerApi.withAtomicFindingLedgerWrites({ store, storyId, fence }, target => {
    append(target, 'third', { ...rows[0], id: 'F-3' });
    const current = target.readFindingLedger(storyId);
    const source = current.records.at(-1);
    const predicateDigest = canonicalHash({ schemaVersion: 1, predicate: 'finding-open-without-terminal-transition',
      findingId: 'F-3', findingRecordId: source.recordId });
    ledgerApi.appendFindingLedger({ ...options, store: target, operation: 'append_finding_lifecycle_transition',
      idempotencyKey: 'third-resolved', records: [{ recordType: 'finding_lifecycle_transition', payload: {
        schemaVersion: 1, transitionId: 'atomic-transition-3', findingId: 'F-3', findingRecordId: source.recordId,
        fromStatus: 'open', toStatus: 'resolved', at: new Date().toISOString(), reason: 'verified repair fixture',
      } }], casBindings: [{ recordType: 'finding', expectedRecordId: source.recordId,
        expectedRecordHash: canonicalHash(source), observedChainHeadId: source.recordId,
        observedChainHeadHash: canonicalHash(source), predicateDigest }],
      verifyPredicate: ({ ledger }) => ({ accepted: ledger.records.at(-1).recordId === source.recordId, predicateDigest }),
    });
  });
  assert.equal(store.readFindings(storyId).findings.find(row => row.id === 'F-3')?.status, 'resolved',
    'a real lifecycle CAS can reference a source created earlier in the same batch');
  const beforeLostFence = readFileSync(store.findingLedgerPath(storyId));
  assert.throws(() => ledgerApi.withAtomicFindingLedgerWrites({ store, storyId, fence,
    commitOptions: { beforeRename() { lock.release(); lock = undefined; } } }, target => {
    append(target, 'fourth', { ...rows[1], id: 'F-4' });
  }), /STALE_FENCE|stale.*fence|fence.*stale/i);
  assert.deepEqual(readFileSync(store.findingLedgerPath(storyId)), beforeLostFence,
    'losing the fence after preparation prevents the entire publication');
  console.log('PASS U04 atomic signed ledger publication and replay');
} finally { lock?.release(); rmSync(root, { recursive: true, force: true }); }
