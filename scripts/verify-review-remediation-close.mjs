import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { StoryStore } from '../packages/main/dist/core/store.js';
import { createFindingHandlers } from '../packages/main/dist/handlers/finding.js';
import { createChecklistHandlers } from '../packages/main/dist/handlers/checklist.js';
import { appendFindingLedger } from '../packages/main/dist/handlers/finding-ledger.js';
import { canonicalHash, findingLedgerSignerFromWorkspace } from '../packages/main/dist/core/finding-ledger.js';
import { acquireMkdirLock, captureMkdirLockFence } from '../packages/main/dist/core/mkdir-lock.js';
import { acquireOwnerLease } from '../packages/main/dist/core/story-owner-lease.js';
import { signReviewInventoryEpoch, signReviewInventoryReceipt } from '../packages/main/dist/core/review-inventory-epoch.js';
assert.equal(typeof createFindingHandlers({}).review_remediation_close, 'function', 'U04 requires complete repairSet closeout');
const root = mkdtempSync(join(tmpdir(), 'review-remediation-'));
const previousCwd = process.cwd();
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
try {
  process.chdir(root);
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Lab witness'); git('config', 'user.email', 'lab@example.invalid');
  writeFileSync(join(root, '.gitignore'), '.proof-or-stop/keys/\n**/*.lock/\n**/owner-lease.json\n.lattice/\n');
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives' }));
  writeFileSync(join(root, 'sum.cjs'), 'module.exports=(a,b)=>a-b;\n');
  writeFileSync(join(root, 'verify.cjs'), "const assert=require('node:assert/strict'); const sum=require('./sum.cjs'); assert.equal(sum(2,3),5); assert.equal(sum(0,3),3); console.log('positive and zero repaired');\n");
  git('add', '.'); git('commit', '-qm', 'baseline');
  const baseline = git('rev-parse', 'HEAD');
  const storyId = 'B-remediation'; git('switch', '-qc', `story/${storyId}`);
  const store = new StoryStore(root), now = new Date().toISOString();
  store.writeStory(storyId, { storyId, name: 'remediation', title: 'Repair addition', description: 'Atomic remediation fixture',
    type: 'feature', phase: 'DEV', priority: 'medium', createdAt: now, startedAt: now, endedAt: null, events: [] });
  acquireOwnerLease(store.storyDirPath(storyId), { command: 'remediation-fixture', cwd: root });
  store.writeChecklist(storyId, { items: [{ id: 'CHK-001', title: 'Repair addition', context: 'Positive and zero inputs must add correctly',
    status: 'in_progress', relatedDocs: [], verificationIntent: { happy: [{ desc: 'Positive and zero inputs return their sum', type: 'cli' }], edge: [], adversarial: [] } }] });
  const findings = [1,2].map(i => ({ id: `F-${i}`, desc: i === 1 ? 'Positive inputs are subtracted' : 'Zero input is subtracted',
    severity: 'high', category: 'adversarial', status: 'open', evidenceState: 'verified', agent: 'proof-or-stop-review-quality', files: ['sum.cjs'] }));
  const lockDir = store.storyFilePath(storyId, 'findings.lock');
  const lock = acquireMkdirLock(lockDir, { label: 'remediation fixture', requireHolderToken: true });
  try {
    const fence = captureMkdirLockFence(lockDir);
    appendFindingLedger({ storyId, store, fence, signer: findingLedgerSignerFromWorkspace(root), operation: 'append_finding',
      idempotencyKey: 'fixture-findings', records: findings.map(payload => ({ recordType: 'finding', payload })),
      writerSessionId: 'fixture', writerLeaseId: 'fixture', writerFenceToken: fence.writerFenceToken });
  } finally { lock.release(); }
  const epoch = { schemaVersion: 'proofbound.review_inventory_epoch.v1', epochId: 'E-1', storyId, reviewRound: now,
    state: 'FINALIZED', begunAt: now, updatedAt: now, cutoff: { headHash: baseline, materialHash: 'a'.repeat(64) },
    scopeDigest: 'b'.repeat(64), requiredLanes: ['proof-or-stop-review-quality'], baselineFindingIds: [], maxWaves: 3,
    waves: [{ wave: 1, startedAt: now, completedAt: now, lanes: [{ lane: 'proof-or-stop-review-quality', reviewRunId: 'RR-1',
      terminal: 'finding', hostIdentity: 'fixture', promptIdentity: 'fixture', evidenceIds: ['F-1', 'F-2'], coverageDigest: 'c'.repeat(64) }],
      verifiedFindingFamilies: ['positive', 'zero'], verifiedFindingSetDigest: 'd'.repeat(64), newVerifiedFindingCount: 2, criticDigest: 'e'.repeat(64) }],
    receiptId: 'IR-1', consumedAt: now, consumedByReviewRound: now };
  const receipt = { schemaVersion: 'proofbound.review_inventory_receipt.v1', receiptId: 'IR-1', epochId: 'E-1', storyId,
    reviewRound: now, cutoff: epoch.cutoff, scopeDigest: epoch.scopeDigest, requiredLanes: epoch.requiredLanes, waveCount: 1,
    findingSetDigest: 'd'.repeat(64), coverageDigest: 'c'.repeat(64), saturationResult: 'NOT_EVALUATED_FOR_REMEDIATION',
    authority: 'review-remediation-only', authorizesTest: false, issuedAt: now, consumedAt: now };
  store.writeReviewInventoryEpochs(storyId, { schemaVersion: 'proofbound.review_inventory_epochs.v1',
    epochs: [{ ...epoch, _hash: signReviewInventoryEpoch(epoch) }], receipts: [{ ...receipt, _hash: signReviewInventoryReceipt(receipt) }], criticReceipts: [] });
  git('add', '.'); git('commit', '-qm', 'frozen review input');
  writeFileSync(join(root, 'sum.cjs'), 'module.exports=(a,b)=>a+b;\n');
  git('add', 'sum.cjs'); git('commit', '-qm', 'repair addition');
  const repairCommit = git('rev-parse', 'HEAD');
  const ctx = { root, scanRoot: root, store, log() {} };
  await createChecklistHandlers(ctx).verification_evidence_add({ storyId, itemId: 'CHK-001', intentRef: 'CHK-001:happy:0',
    kind: 'integration_test', command: `${process.execPath} verify.cjs`, selector: 'positive and zero repaired',
    note: 'Executed the real repaired function for both positive and zero inputs and asserted exact sums.' });
  const evidence = store.readChecklist(storyId).items[0].verificationEvidence[0];
  assert.equal(evidence.mechanical, true);
  const proof = { itemId: 'CHK-001', intentRef: evidence.intentRef, evidenceDigest: canonicalHash(evidence) };
  const request = { storyId, repairSetId: 'repair-addition', epochId: 'E-1', repairCommit,
    findings: findings.map(({ id }) => ({ findingId: id, resolution: 'Addition restored and checked with real positive and zero inputs.', verification: [proof] })) };
  const handlers = createFindingHandlers(ctx);
  const beforeBytes = readFileSync(store.findingLedgerPath(storyId));
  const beforeHead = git('rev-parse', 'HEAD');
  assert.throws(() => handlers.review_remediation_close({ ...request, findings: [request.findings[0], { ...request.findings[1], verification: [] }] }), /verification|evidence/i);
  assert.deepEqual(readFileSync(store.findingLedgerPath(storyId)), beforeBytes, 'missing proof on one finding leaves whole ledger unchanged');
  assert.equal(git('rev-parse', 'HEAD'), beforeHead, 'invalid repairSet creates no metadata commit');
  const result = handlers.review_remediation_close(request);
  assert.equal(result.openCount, 0, 'reported open count comes from canonical post-transaction reader');
  assert.ok(store.readFindings(storyId).findings.every(f => f.status === 'resolved'));
  const afterHead = git('rev-parse', 'HEAD');
  assert.equal(Number(git('rev-list', '--count', `${beforeHead}..${afterHead}`)), 1, 'one repairSet creates exactly one metadata commit');
  const afterBytes = readFileSync(store.findingLedgerPath(storyId));
  assert.equal(handlers.review_remediation_close(request).replayed, true);
  assert.equal(git('rev-parse', 'HEAD'), afterHead, 'repairSet replay creates no second metadata commit');
  assert.deepEqual(readFileSync(store.findingLedgerPath(storyId)), afterBytes);
  assert.throws(() => handlers.review_remediation_close({ ...request, findings: [{ ...request.findings[0], resolution: 'Changed repair claim' }, request.findings[1]] }), /IDEMPOTENCY_CONFLICT/);
  console.log('PASS U04 complete atomic repairSet closeout');
} finally { process.chdir(previousCwd); rmSync(root, { recursive: true, force: true }); }
