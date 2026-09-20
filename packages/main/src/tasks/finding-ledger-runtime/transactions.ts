import assert from 'node:assert/strict';

import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';

import { FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY, FINDING_LEDGER_SCHEMA_EPOCH, LedgerRefusal, appendLedgerTransaction, readLedger, recoverLedger, type AppendRequest, type DurableCommitTrace, type JsonValue } from '../../core/finding-ledger.js';

import { generateEd25519KeyPair } from '../../core/authority-signing.js';
import { appendAssessmentProposal, appendDeferralExpiryPolicy, appendFindingLedger, canonicalHash, canonicalJson, classifyMandatoryRepair, closeMandatoryRepair, exactLedgerRecordHash, findingLedgerSignerFromWorkspace, signFindingLedgerReceipt, signAssessmentProposal, verifyAssessmentProposal, verifyFindingLedgerReceipt, type LedgerAppendOptions, type LedgerReceiptTrust, type LedgerSigner } from '../../handlers/finding-ledger.js';

import {
  acquireMkdirLock,
  captureMkdirLockFence,
} from '../../core/mkdir-lock.js';
import {
  acquireMainWriteLock,
  mainWriteLockPath,
} from '../../core/main-write-lock.js';
import { StoryStore } from '../../core/store.js';

import type { Finding } from '../../core/types.js';

import { runWorkers, request, git, signedApplicableProposal, proposalUnsignedForSmoke } from './support.js';

export async function runLedgerTransactions(scratch: string): Promise<void> {
const concurrentFile = join(scratch, 'concurrent', 'finding-ledger.json');
const concurrentLock = join(scratch, 'locks', 'normal-findings.lock');
const workerCount = 25;
await runWorkers(Array.from({ length: workerCount }, (_, worker) => ({
      ledgerFile: concurrentFile,
      lockDir: concurrentLock,
      prefix: `finding-${worker}`,
      count: 4,
      recordType: 'finding',
      payloadBase: { storyId: 'B-SMOKE', status: 'open' },
    })));
const concurrent = readLedger(concurrentFile);
assert.equal(concurrent.records.length, 100);
assert.equal(new Set(concurrent.records.map((record) => record.recordId)).size, 100);
assert.ok(concurrent.records.every((record) => !/^lr_\d+$/.test(record.recordId)));
console.log('ledger.concurrent_unique_appends: PASS rows=100 uniqueRecordIds=100');
const originalIds = new Map(concurrent.receipts.map((receipt) => [
      receipt.idempotencyKey,
      `${receipt.recordIds.join(',')}:${receipt.receiptId}`,
    ]));
const replayLock = acquireMkdirLock(concurrentLock, { label: 'finding ledger replay', requireHolderToken: true });
try {
      const fence = captureMkdirLockFence(concurrentLock);
      for (const record of concurrent.records) {
        const replay = appendLedgerTransaction(
          concurrentFile,
          request(fence.writerFenceToken, record.idempotencyKey, record.recordType, record.payload),
          fence,
        );
        assert.equal(replay.action, 'replay');
        assert.equal(
          `${replay.records.map((item) => item.recordId).join(',')}:${replay.receipt.receiptId}`,
          originalIds.get(record.idempotencyKey),
        );
      }
    } finally {
      replayLock.release();
    }
assert.equal(readLedger(concurrentFile).records.length, 100);
console.log('ledger.idempotent_replay: PASS replays=100 newRows=0 sameIds=true');
const durableFile = join(scratch, 'durable', 'finding-ledger.json');
const durableLockDir = join(scratch, 'locks', 'durable.lock');
const durableLock = acquireMkdirLock(durableLockDir, { label: 'durable ledger commit', requireHolderToken: true });
const trace: DurableCommitTrace = { fsyncFile: false, atomicRename: false, fsyncDirectory: false };
try {
      const fence = captureMkdirLockFence(durableLockDir);
      appendLedgerTransaction(
        durableFile,
        request(fence.writerFenceToken, 'durable:1', 'finding', { id: 'B-SMOKE:F-DURABLE' }),
        fence,
        { trace },
      );
    } finally {
      durableLock.release();
    }
const durable = readLedger(durableFile);
assert.equal(durable.ledgerSchemaEpoch, FINDING_LEDGER_SCHEMA_EPOCH);
assert.equal(durable.minimumWriterCapability, FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY);
assert.deepEqual(trace, { fsyncFile: true, atomicRename: true, fsyncDirectory: true });
const storeRoot = join(scratch, 'store-integration');
mkdirSync(storeRoot, { recursive: true });
git(storeRoot, ['init', '-q', '-b', 'main']);
const store = new StoryStore(storeRoot);
const storeStoryId = 'B-SMOKE';
const storeLockDir = store.storyFilePath(storeStoryId, 'findings.lock');
const storeLock = acquireMkdirLock(storeLockDir, {
      label: 'Store ledger integration', requireHolderToken: true,
    });
try {
      const fence = captureMkdirLockFence(storeLockDir);
      const finding: Finding = {
        id: 'B-SMOKE:F-001',
        desc: 'committed before compatibility mirror',
        severity: 'high',
        category: 'adversarial',
        status: 'open',
      };
      appendFindingLedger({ storyId: storeStoryId, store,
        operation: 'append_finding',
        idempotencyKey: 'store-projection:1',
        records: [{ recordType: 'finding', payload: finding as unknown as JsonValue }],
        writerSessionId: 'store-smoke',
        writerLeaseId: 'store-smoke',
        writerFenceToken: fence.writerFenceToken,
        fence, signer: findingLedgerSignerFromWorkspace(storeRoot),
      });
    } finally {
      storeLock.release();
    }
assert.equal(existsSync(store.storyFilePath(storeStoryId, 'findings.json')), false);
assert.match(store.readFindings(storeStoryId).findings[0]?.recordId ?? '', /^lr_/);
console.log('ledger.durable_commit: PASS fsyncFile=true atomicRename=true fsyncDirectory=true');
const signerPair = generateEd25519KeyPair();
const proposalPair = generateEd25519KeyPair();
const ledgerSigner: LedgerSigner = {
      privateKey: signerPair.privateKey,
      publicKey: signerPair.publicKey,
      keyId: 'ledger-key-001',
      trustRootDigest: 'ledger-trust-root-001',
      keyFreshnessPolicyDigest: 'ledger-key-freshness-v1',
    };
const ledgerTrust: LedgerReceiptTrust = {
      publicKey: signerPair.publicKey,
      keyId: ledgerSigner.keyId,
      algorithm: 'ed25519',
      trustRootDigest: ledgerSigner.trustRootDigest,
      keyFreshnessPolicyDigest: ledgerSigner.keyFreshnessPolicyDigest,
    };
const integrityStore = new StoryStore(join(scratch, 'chk003-store'));
const integrityStoryId = 'B-CAS';
const integrityLockDir = integrityStore.storyFilePath(integrityStoryId, 'findings.lock');
const integrityLock = acquireMkdirLock(integrityLockDir, {
      label: 'CHK-003 exact CAS', requireHolderToken: true,
    });
try {
      const fence = captureMkdirLockFence(integrityLockDir);
      const baseOptions = (idempotencyKey: string): Omit<LedgerAppendOptions<JsonValue>, 'operation' | 'records'> => ({
        storyId: integrityStoryId,
        store: integrityStore,
        idempotencyKey,
        writerSessionId: 'chk003-smoke-session',
        writerLeaseId: 'chk003-smoke-lease',
        writerFenceToken: fence.writerFenceToken,
        fence,
        signer: ledgerSigner,
      });

      const seedReceipt = appendFindingLedger({
        ...baseOptions('chk003:seed'),
        operation: 'append_finding',
        records: [{ recordType: 'finding', payload: { id: 'B-CAS:F-001', status: 'open' } }],
      });
      const seedLedger = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      const seedRecord = seedLedger.records[0]!;
      const predicateDigest = canonicalHash({ decision: 'caller-approved', recordId: seedRecord.recordId });
      const seedHeadHash = exactLedgerRecordHash(seedRecord);
      const casBinding = {
        recordType: seedRecord.recordType,
        expectedRecordId: seedRecord.recordId,
        expectedRecordHash: exactLedgerRecordHash(seedRecord),
        observedChainHeadId: seedRecord.recordId,
        observedChainHeadHash: seedHeadHash,
        predicateDigest,
      };
      const casOptions: LedgerAppendOptions<JsonValue> = {
        ...baseOptions('chk003:exact-cas'),
        operation: 'append_candidate_route',
        records: [{ recordType: 'candidate_route', payload: { findingId: 'B-CAS:F-001', advisoryOnly: true } }],
        casBindings: [casBinding],
        expectedPriorLedgerDigest: seedLedger.committedLedgerDigest,
        verifyPredicate: (snapshot) => {
          assert.equal(snapshot.referencedRecords.length, 1);
          assert.equal(snapshot.referencedRecords[0]?.canonicalBytes, canonicalJson(seedRecord));
          assert.equal(snapshot.currentChainHeadId, seedRecord.recordId);
          assert.equal(snapshot.currentChainHeadHash, seedHeadHash);
          return { accepted: true, predicateDigest };
        },
      };
      const casReceipt = appendFindingLedger(casOptions);
      const afterCas = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      assert.equal(afterCas.records.length, 2);
      assert.equal(verifyFindingLedgerReceipt(seedReceipt, ledgerTrust), true);
      assert.equal(verifyFindingLedgerReceipt(casReceipt, ledgerTrust), true);
      const acceptedReceiptKeys = [
        'schemaVersion', 'ledgerSchemaEpoch', 'minimumWriterCapability', 'receiptId', 'storyId',
        'idempotencyKey', 'exactRequestDigest', 'operation', 'recordIds', 'casBindings', 'priorLedgerDigest',
        'committedLedgerDigest', 'replayed', 'committedAt', 'writerSessionId', 'writerLeaseId',
        'writerFenceToken', 'keyId', 'algorithm', 'trustRootDigest', 'keyFreshnessPolicyDigest',
        'receiptHash', 'signature',
      ].sort();
      assert.deepEqual(Object.keys(casReceipt).sort(), acceptedReceiptKeys);
      console.log('ledger.receipt_contract: PASS signedFields=complete');
      console.log('ledger.exact_record_cas: PASS committed=true');

      const replay = appendFindingLedger(casOptions);
      const afterReplay = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      assert.equal(replay.receiptId, casReceipt.receiptId);
      assert.deepEqual(replay.recordIds, casReceipt.recordIds);
      assert.equal(replay.signature, casReceipt.signature);
      assert.equal(afterReplay.records.length, afterCas.records.length);
      assert.equal(afterReplay.receipts.length, afterCas.receipts.length);
      assert.equal(afterReplay.records.filter((record) => record.recordType === 'finding_ledger_receipt').length, 0);
      console.log('ledger.receipt_replay: PASS newRows=0 sameIds=true recursiveReceipts=0');

      const relabelIdempotencyKey = 'chk003:idempotency-digest-relabel';
      const relabelV1Options: LedgerAppendOptions<JsonValue> = {
        ...baseOptions(relabelIdempotencyKey),
        operation: 'append_candidate',
        records: [{ recordType: 'candidate', payload: { candidateId: 'digest-relabel', version: 1 } }],
      };
      appendFindingLedger(relabelV1Options);
      const relabelLedgerPath = integrityStore.findingLedgerPath(integrityStoryId);
      const relabelOriginalLedger = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      const relabelV2Options: LedgerAppendOptions<JsonValue> = {
        ...relabelV1Options,
        records: [{ recordType: 'candidate', payload: { candidateId: 'digest-relabel', version: 2 } }],
      };
      const digestFor = (options: LedgerAppendOptions<JsonValue>): string => canonicalHash({
        storyId: options.storyId,
        operation: options.operation,
        idempotencyKey: options.idempotencyKey,
        records: options.records,
        casBindings: options.casBindings ?? [],
        ...(options.expectedPriorLedgerDigest !== undefined
          ? { expectedPriorLedgerDigest: options.expectedPriorLedgerDigest }
          : {}),
      });
      const relabeledLedger = structuredClone(relabelOriginalLedger) as typeof relabelOriginalLedger & {
        receipts: Array<Record<string, unknown>>;
      };
      const relabeledCarrier = relabeledLedger.receipts.find((receipt) => (
        receipt.idempotencyKey === relabelIdempotencyKey
      ))!;
      (relabeledCarrier as unknown as Record<string, unknown>).exactRequestDigest = digestFor(relabelV2Options);
      writeFileSync(relabelLedgerPath, `${JSON.stringify(relabeledLedger, null, 2)}\n`);
      let relabeledReplayAccepted = false;
      try {
        appendFindingLedger(relabelV2Options);
        relabeledReplayAccepted = true;
      } catch (error) {
        assert.match(String(error), /IDEMPOTENCY_CONFLICT/);
      }
      const relabeledPersisted = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      const relabeledPayload = relabeledPersisted.records.find((record) => (
        record.idempotencyKey === relabelIdempotencyKey
      ))?.payload as Record<string, JsonValue> | undefined;
      writeFileSync(relabelLedgerPath, `${JSON.stringify(relabelOriginalLedger, null, 2)}\n`);
      if (relabeledReplayAccepted) {
        console.log(`ledger.idempotency_digest_relabel_refused: RED replayV2=accepted persistedVersion=${String(relabeledPayload?.version)}`);
      }
      assert.equal(
        relabeledReplayAccepted,
        false,
        'changing only unsigned exactRequestDigest must not relabel a v2 request as a v1 replay',
      );
      assert.equal(relabeledPayload?.version, 1, 'replay refusal must preserve the original v1 payload');
      let relabelRefusals = relabeledReplayAccepted ? 0 : 1;
      const expectReplayBindingRefusal = (
        candidate: typeof relabelOriginalLedger,
        options: LedgerAppendOptions<JsonValue>,
      ): void => {
        writeFileSync(relabelLedgerPath, `${JSON.stringify(candidate, null, 2)}\n`);
        assert.throws(() => appendFindingLedger(options), /IDEMPOTENCY_CONFLICT/);
        relabelRefusals += 1;
        writeFileSync(relabelLedgerPath, `${JSON.stringify(relabelOriginalLedger, null, 2)}\n`);
      };
      const semanticRelabels: LedgerAppendOptions<JsonValue>[] = [
        { ...relabelV1Options, operation: 'append_deferral' },
        { ...relabelV1Options, records: [{ recordType: 'candidate_route', payload: { candidateId: 'digest-relabel', version: 1 } }] },
        {
          ...relabelV1Options,
          casBindings: [{
            recordType: 'finding', expectedRecordId: seedReceipt.recordIds[0]!,
            expectedRecordHash: exactLedgerRecordHash(seedRecord),
            observedChainHeadId: seedRecord.recordId,
            observedChainHeadHash: exactLedgerRecordHash(seedRecord),
            predicateDigest: 'relabel-cas-predicate',
          }],
        },
        { ...relabelV1Options, expectedPriorLedgerDigest: '0'.repeat(64) },
      ];
      for (const options of semanticRelabels) {
        const candidate = structuredClone(relabelOriginalLedger) as typeof relabelOriginalLedger & {
          receipts: Array<Record<string, unknown>>;
        };
        const carrier = candidate.receipts.find((receipt) => receipt.idempotencyKey === relabelIdempotencyKey)!;
        (carrier as unknown as Record<string, unknown>).exactRequestDigest = digestFor(options);
        expectReplayBindingRefusal(candidate, options);
      }

      for (const mutateCarrier of [
        (carrier: Record<string, unknown>) => { carrier.idempotencyKey = 'chk003:idempotency-carrier-relabel'; },
        (carrier: Record<string, unknown>) => { carrier.operation = 'append_deferral'; },
        (carrier: Record<string, unknown>) => { carrier.recordIds = [...seedReceipt.recordIds]; },
        (carrier: Record<string, unknown>) => { carrier.priorLedgerDigest = '0'.repeat(64); },
        (carrier: Record<string, unknown>) => { carrier.requestDigest = '0'.repeat(64); },
      ]) {
        const candidate = structuredClone(relabelOriginalLedger) as typeof relabelOriginalLedger & {
          receipts: Array<Record<string, unknown>>;
        };
        const carrier = candidate.receipts.find((receipt) => receipt.idempotencyKey === relabelIdempotencyKey)!;
        mutateCarrier(carrier as unknown as Record<string, unknown>);
        const candidateKey = String((carrier as unknown as Record<string, unknown>).idempotencyKey);
        expectReplayBindingRefusal(candidate, { ...relabelV1Options, idempotencyKey: candidateKey });
      }

      const legacyCandidate = structuredClone(relabelOriginalLedger) as typeof relabelOriginalLedger & {
        receipts: Array<Record<string, unknown>>;
      };
      const legacyCarrier = legacyCandidate.receipts.find((receipt) => receipt.idempotencyKey === relabelIdempotencyKey)!;
      const signedOriginal = (legacyCarrier as unknown as Record<string, unknown>).findingLedgerReceipt as ReturnType<typeof signFindingLedgerReceipt>;
      const {
        exactRequestDigest: _legacyExactRequestDigest,
        receiptHash: _legacyReceiptHash,
        signature: _legacySignature,
        ...legacyUnsigned
      } = signedOriginal;
      (legacyCarrier as unknown as Record<string, unknown>).findingLedgerReceipt = signFindingLedgerReceipt(
        legacyUnsigned,
        ledgerSigner,
      );
      expectReplayBindingRefusal(legacyCandidate, relabelV1Options);
      assert.equal(relabelRefusals, 11);
      console.log('ledger.idempotency_digest_relabel_refused: PASS replayV2=refused persistedVersion=1 signedBinding=true semanticRelabels=4 carrierRelabels=5 legacyReplay=refused');

      const staleBaseCount = integrityStore.readFindingLedger<JsonValue>(integrityStoryId).records.length;
      const staleAttempts: Array<LedgerAppendOptions<JsonValue>> = [
        {
          ...baseOptions('chk003:stale-id'), operation: 'append_candidate_route',
          records: [{ recordType: 'candidate_route', payload: { rejected: 'record-id' } }],
          casBindings: [{ ...casBinding, expectedRecordId: 'missing-record' }],
          expectedPriorLedgerDigest: afterReplay.committedLedgerDigest,
          verifyPredicate: () => ({ accepted: true, predicateDigest }),
        },
        {
          ...baseOptions('chk003:stale-hash'), operation: 'append_candidate_route',
          records: [{ recordType: 'candidate_route', payload: { rejected: 'record-hash' } }],
          casBindings: [{ ...casBinding, expectedRecordHash: '0'.repeat(64) }],
          expectedPriorLedgerDigest: afterReplay.committedLedgerDigest,
          verifyPredicate: () => ({ accepted: true, predicateDigest }),
        },
        {
          ...baseOptions('chk003:stale-head'), operation: 'append_candidate_route',
          records: [{ recordType: 'candidate_route', payload: { rejected: 'chain-head' } }],
          casBindings: [{ ...casBinding }],
          expectedPriorLedgerDigest: afterReplay.committedLedgerDigest,
          verifyPredicate: () => ({ accepted: true, predicateDigest }),
        },
        {
          ...baseOptions('chk003:stale-predicate'), operation: 'append_candidate_route',
          records: [{ recordType: 'candidate_route', payload: { rejected: 'predicate' } }],
          casBindings: [{
            ...casBinding,
            observedChainHeadId: afterReplay.records.at(-1)!.recordId,
            observedChainHeadHash: exactLedgerRecordHash(afterReplay.records.at(-1)!),
          }],
          expectedPriorLedgerDigest: afterReplay.committedLedgerDigest,
          verifyPredicate: () => ({ accepted: true, predicateDigest: 'different-predicate' }),
        },
        {
          ...baseOptions('chk003:stale-ledger'), operation: 'append_candidate_route',
          records: [{ recordType: 'candidate_route', payload: { rejected: 'prior-ledger' } }],
          expectedPriorLedgerDigest: '0'.repeat(64),
        },
      ];
      for (const attempt of staleAttempts) {
        assert.throws(() => appendFindingLedger(attempt), /CAS_CONFLICT/);
      }
      assert.equal(integrityStore.readFindingLedger(integrityStoryId).records.length, staleBaseCount);
      console.log('ledger.stale_cas: PASS semanticWrites=0');

      const proposal = signedApplicableProposal(proposalPair.privateKey, proposalPair.publicKey, 'assessment-authority-digest');
      const proposalOptions = {
        ...baseOptions('chk003:proposal'),
        proposal,
        proposalPublicKey: proposalPair.publicKey,
        expectedAuthorityDigest: 'assessment-authority-digest',
        now: new Date('2030-01-01T00:30:00.000Z'),
      };
      const proposalReceipt = appendAssessmentProposal(proposalOptions);
      const proposalLedger = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      const proposalRecord = proposalLedger.records.find((record) => record.recordType === 'assessment_proposal')!;
      const proposalReceiptRows = proposalLedger.receipts.filter((receipt) => (
        receipt as typeof receipt & { findingLedgerReceipt?: unknown }
      ).findingLedgerReceipt !== undefined);
      assert.equal(proposalLedger.records.filter((record) => record.recordType === 'assessment_proposal').length, 1);
      assert.equal(proposalReceiptRows.filter((receipt) => receipt.receiptId === proposalReceipt.receiptId).length, 1);
      assert.equal(proposalLedger.records.filter((record) => record.recordType.includes('receipt')).length, 0);
      console.log('ledger.assessment_proposal_atomic: PASS proposalRows=1 receiptRows=1 recursiveReceipts=0');

      const validProposal = verifyAssessmentProposal(proposal, {
        publicKey: proposalPair.publicKey,
        expectedAuthorityDigest: 'assessment-authority-digest',
        now: new Date('2030-01-01T00:30:00.000Z'),
        expectedFindingHash: 'finding-hash-001',
        expectedHeadHash: 'head-001',
        expectedMaterialHash: 'material-001',
        expectedStoryFilesHash: 'story-files-001',
        receipt: proposalReceipt,
        receiptTrust: ledgerTrust,
        proposalRecord,
        requireReceipt: true,
        receiptIsCurrent: true,
        finalAssessment: {
          ...proposal,
          assessmentId: 'assessment-001',
          assessmentProposalDigest: proposal.proposalDigest,
          proposalReceipt: {
            receiptId: proposalReceipt.receiptId,
            receiptHash: proposalReceipt.receiptHash,
            operation: 'append_assessment_proposal',
          },
          assessmentHash: 'assessment-hash-001',
          signature: 'final-signature-placeholder',
        },
      });
      assert.equal(validProposal.valid, true);

      const proposalReplayBefore = canonicalJson(proposalRecord);
      const proposalReplay = appendAssessmentProposal(proposalOptions);
      const proposalLedgerAfterReplay = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      assert.equal(proposalReplay.receiptId, proposalReceipt.receiptId);
      assert.deepEqual(proposalReplay.recordIds, proposalReceipt.recordIds);
      assert.equal(proposalLedgerAfterReplay.records.length, proposalLedger.records.length);
      assert.equal(canonicalJson(proposalLedgerAfterReplay.records.find((record) => record.recordId === proposalRecord.recordId)), proposalReplayBefore);
      console.log('ledger.assessment_proposal_replay: PASS newRows=0 sameIds=true bytesUnchanged=true');

      const attacker = generateEd25519KeyPair();
      const wrongSignature = { ...proposal, proposalSignature: 'invalid-signature' };
      const expiredWithoutCallerNow = signedApplicableProposal(
        proposalPair.privateKey,
        proposalPair.publicKey,
        'assessment-authority-digest',
        {
          proposalId: 'proposal-expired-2000',
          issuedAt: '2000-01-01T00:00:00.000Z',
          expiresAt: '2000-01-01T02:00:00.000Z',
        },
      );
      const alteredExactUnion = signAssessmentProposal({
        ...proposalUnsignedForSmoke(proposal),
        owner: 'meta',
      }, proposalPair.privateKey);
      const rejected = [
        verifyAssessmentProposal(proposal, {
          publicKey: proposalPair.publicKey, expectedAuthorityDigest: 'wrong-authority',
        }),
        verifyAssessmentProposal(wrongSignature, {
          publicKey: attacker.publicKey, expectedAuthorityDigest: 'assessment-authority-digest',
        }),
        verifyAssessmentProposal(alteredExactUnion, {
          publicKey: proposalPair.publicKey, expectedAuthorityDigest: 'assessment-authority-digest',
        }),
        verifyAssessmentProposal(proposal, {
          publicKey: proposalPair.publicKey, expectedAuthorityDigest: 'assessment-authority-digest', requireReceipt: true,
        }),
        verifyAssessmentProposal(proposal, {
          publicKey: proposalPair.publicKey, expectedAuthorityDigest: 'assessment-authority-digest',
          now: new Date('2030-01-01T03:00:00.000Z'),
        }),
        verifyAssessmentProposal(expiredWithoutCallerNow, {
          publicKey: proposalPair.publicKey, expectedAuthorityDigest: 'assessment-authority-digest',
        }),
        verifyAssessmentProposal(proposal, {
          publicKey: proposalPair.publicKey, expectedAuthorityDigest: 'assessment-authority-digest',
          receipt: proposalReceipt, receiptTrust: ledgerTrust, proposalRecord,
          finalAssessment: {
            ...proposal,
            findingHash: 'altered-final-finding-hash',
            assessmentProposalDigest: proposal.proposalDigest,
          },
        }),
      ];
      assert.equal(rejected.every((result) => !result.valid), true);
      assert.equal(integrityStore.readFindingLedger(integrityStoryId).records.length, proposalLedgerAfterReplay.records.length);
      assert.equal(rejected[5]?.rejection, 'proposal_expired');
      console.log('ledger.assessment_proposal_rejections: PASS wrongAuthority=reject wrongSignature=reject exactUnion=reject missingReceipt=reject staleExpired=reject proposalFinalDivergence=reject semanticWrites=0 omittedNowExpired=reject');
      const resign = (overrides: Record<string, unknown>) => signAssessmentProposal({
        ...proposalUnsignedForSmoke(proposal),
        ...overrides,
      }, proposalPair.privateKey);
      const findingRef = proposal.findingRef as Record<string, unknown>;
      const signerMetadata = proposal.proposalSigner as Record<string, unknown>;
      const witness = proposal.currentWitness as Record<string, unknown>;
      const dependencyBundle = proposal.dependencyBundle as Record<string, unknown>;
      const structuralRejections = [
        verifyAssessmentProposal(resign({ findingRef: {
          storyId: findingRef.storyId, findingId: findingRef.findingId,
        } }), {
          publicKey: proposalPair.publicKey, expectedAuthorityDigest: 'assessment-authority-digest',
        }),
        verifyAssessmentProposal(resign({ currentWitness: { ...witness, receiptIds: [] } }), {
          publicKey: proposalPair.publicKey, expectedAuthorityDigest: 'assessment-authority-digest',
        }),
        verifyAssessmentProposal(resign({ proposalSigner: { ...signerMetadata, keyId: 'caller-selected-key' } }), {
          publicKey: proposalPair.publicKey, expectedAuthorityDigest: 'assessment-authority-digest',
        }),
        verifyAssessmentProposal(resign({ dependencyBundle: { ...dependencyBundle, digest: 'wrong-digest' } }), {
          publicKey: proposalPair.publicKey, expectedAuthorityDigest: 'assessment-authority-digest',
        }),
        verifyAssessmentProposal(proposal, {
          publicKey: proposalPair.publicKey,
          expectedAuthorityDigest: 'assessment-authority-digest',
          receipt: proposalReceipt,
          receiptTrust: ledgerTrust,
          proposalRecord,
        }),
      ];
      assert.equal(structuralRejections.every((result) => !result.valid), true);
      console.log('ledger.assessment_proposal_structural_chain: PASS findingRecordId=required witness=nonempty signer=truthful dependencyDigest=exact receiptCurrent=required semanticWrites=0');

      const {
        verdict: _applicableVerdict,
        basis: _applicableBasis,
        owner: _applicableOwner,
        currentWitness: _applicableWitness,
        ...proposalEnvelope
      } = proposalUnsignedForSmoke(proposal);
      const signVariant = (variant: Record<string, unknown>) => signAssessmentProposal({
        ...proposalEnvelope,
        owner: 'meta',
        ...variant,
      }, proposalPair.privateKey);
      const validVariants = {
        preExisting: signVariant({
          verdict: 'pre_existing_unaffected',
          basis: 'base_head_reproduction',
          baseHead: {
            baseRef: 'main~1', baseResult: 'reproduced', headRef: 'HEAD', headResult: 'reproduced',
            worsenedByStory: false, receiptIds: ['runtime-base', 'runtime-head'],
          },
        }),
        outOfScope: signVariant({
          verdict: 'out_of_scope', basis: 'decision_scope', excludedScopeProofDigest: 'scope-proof-digest',
        }),
        duplicate: signVariant({
          verdict: 'duplicate', basis: 'canonical_duplicate',
          canonicalDefectRef: {
            canonicalDefectId: 'DEF-001', identityDigest: 'identity-digest', canonicalOwner: 'B-OWNER',
            currentCanonicalFinding: {
              storyId: 'B-OWNER', findingId: 'B-OWNER:F-001', recordId: 'record-owner-001', hash: 'finding-hash-owner',
            },
          },
        }),
        notReproduced: signVariant({
          verdict: 'not_reproduced_under_current_witness', basis: 'counter_evidence',
          currentWitness: {
            receiptIds: ['runtime-negative'], reproduced: false,
            commandPolicyDigest: 'command-policy', runtimeEvidenceDigest: 'runtime-evidence',
            negativeWitnessDigest: 'negative-witness',
          },
        }),
        unknown: signVariant({ verdict: 'unknown', basis: 'counter_evidence' }),
      };
      const verifyVariant = (candidate: Record<string, unknown>) => verifyAssessmentProposal(candidate, {
        publicKey: proposalPair.publicKey,
        expectedAuthorityDigest: 'assessment-authority-digest',
        now: new Date('2030-01-01T00:30:00.000Z'),
      });
      assert.equal(Object.values(validVariants).every((candidate) => verifyVariant(candidate).valid), true);

      const resignVariant = (candidate: Record<string, unknown>, overrides: Record<string, unknown>) =>
        signAssessmentProposal({ ...proposalUnsignedForSmoke(candidate), ...overrides }, proposalPair.privateKey);
      const preExistingBase = validVariants.preExisting.baseHead as Record<string, unknown>;
      const { headRef: _missingHeadRef, ...baseHeadMissingHead } = preExistingBase;
      const duplicateBase = validVariants.duplicate.canonicalDefectRef as Record<string, unknown>;
      const { canonicalOwner: _missingCanonicalOwner, ...duplicateMissingOwner } = duplicateBase;
      const negativeWitness = validVariants.notReproduced.currentWitness as Record<string, unknown>;
      const { negativeWitnessDigest: _missingNegativeDigest, ...negativeMissingDigest } = negativeWitness;
      const invalidVariants = [
        resignVariant(validVariants.preExisting, { baseHead: null }),
        resignVariant(validVariants.preExisting, { baseHead: baseHeadMissingHead }),
        resignVariant(validVariants.preExisting, { baseHead: { ...preExistingBase, receiptIds: [] } }),
        resignVariant(validVariants.preExisting, { baseHead: { ...preExistingBase, worsenedByStory: true } }),
        resignVariant(validVariants.outOfScope, { excludedScopeProofDigest: null }),
        resignVariant(validVariants.outOfScope, { excludedScopeProofDigest: '' }),
        resignVariant(validVariants.duplicate, { canonicalDefectRef: null }),
        resignVariant(validVariants.duplicate, { canonicalDefectRef: duplicateMissingOwner }),
        resignVariant(validVariants.duplicate, {
          canonicalDefectRef: { ...duplicateBase, currentCanonicalFinding: null },
        }),
        resignVariant(validVariants.notReproduced, { currentWitness: null }),
        resignVariant(validVariants.notReproduced, { currentWitness: negativeMissingDigest }),
        resignVariant(validVariants.notReproduced, {
          currentWitness: { ...negativeWitness, receiptIds: [], reproduced: true },
        }),
      ];
      assert.equal(invalidVariants.every((candidate) => !verifyVariant(candidate).valid), true);
      assert.equal(invalidVariants.every((candidate) => verifyVariant(candidate).rejection === 'proposal_exact_union_invalid'), true);
      console.log('ledger.assessment_non_applicable_exact_union: PASS valid=5 nullMissingInvalid=12 baseHeadNull=reject unknownApplicable=preserved');

      const standaloneReceipt = appendFindingLedger({
        ...baseOptions('chk003:standalone-receipt'),
        operation: 'append_route_receipt',
        records: [{
          recordType: 'route_receipt',
          payload: { receiptId: 'route-receipt-standalone', profile: 'candidate_route', gateAuthority: false },
          uniqueBindingKey: 'route-receipt:standalone',
        }],
      });
      const beforeStandaloneConflict = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      const standaloneRecord = beforeStandaloneConflict.records.find((record) => record.recordId === standaloneReceipt.recordIds[0])!;
      const standaloneBytes = canonicalJson(standaloneRecord);
      const standaloneHead = beforeStandaloneConflict.records.at(-1)!;
      assert.throws(() => appendFindingLedger({
        ...baseOptions('chk003:standalone-route-conflict'),
        operation: 'append_candidate_route',
        records: [{ recordType: 'candidate_route', payload: { id: 'must-not-exist' } }],
        expectedPriorLedgerDigest: beforeStandaloneConflict.committedLedgerDigest,
        casBindings: [{
          recordType: standaloneRecord.recordType,
          expectedRecordId: standaloneRecord.recordId,
          expectedRecordHash: '0'.repeat(64),
          observedChainHeadId: standaloneHead.recordId,
          observedChainHeadHash: exactLedgerRecordHash(standaloneHead),
          predicateDigest: 'standalone-route-predicate',
        }],
        verifyPredicate: () => ({ accepted: true, predicateDigest: 'standalone-route-predicate' }),
      }), /CAS_CONFLICT/);
      const afterStandaloneConflict = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      assert.equal(canonicalJson(afterStandaloneConflict.records.find((record) => record.recordId === standaloneRecord.recordId)), standaloneBytes);
      assert.equal(afterStandaloneConflict.records.some((record) => (record.payload as Record<string, JsonValue>).id === 'must-not-exist'), false);
      console.log('ledger.standalone_receipt_conflict: PASS receiptPreserved=true routeWrites=0');

      const baselineBundle = appendFindingLedger({
        ...baseOptions('chk003:baseline-bundle'),
        operation: 'append_progress_baseline_set',
        records: [
          { recordType: 'route_receipt', payload: { receiptId: 'finding-route-bundle', profile: 'finding_route', gateAuthority: false } },
          ...['target_source_change', 'target_test_result', 'target_delivery_state', 'target_status_transition'].map((kind) => ({
            recordType: 'progress_baseline',
            payload: { baselineSetId: 'baseline-set-001', kind, gateAuthority: false } as JsonValue,
          })),
        ],
      });
      assert.equal(baselineBundle.recordIds.length, 5);
      const beforeBundleCrash = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      const baselineRecords = baselineBundle.recordIds.map((recordId) => (
        beforeBundleCrash.records.find((record) => record.recordId === recordId)!
      ));
      const baselineHead = beforeBundleCrash.records.at(-1)!;
      const baselinePredicateDigest = canonicalHash({
        profile: 'exact-four-progress-baselines-v1',
        recordIds: baselineBundle.recordIds,
      });
      const baselineBindings = baselineRecords.map((record) => ({
        recordType: record.recordType,
        expectedRecordId: record.recordId,
        expectedRecordHash: exactLedgerRecordHash(record),
        observedChainHeadId: baselineHead.recordId,
        observedChainHeadHash: exactLedgerRecordHash(baselineHead),
        predicateDigest: baselinePredicateDigest,
      }));
      const verifyBaselineBundle = (snapshot: Parameters<NonNullable<LedgerAppendOptions<JsonValue>['verifyPredicate']>>[0]) => {
        const kinds = snapshot.referencedRecords
          .filter(({ record }) => record.recordType === 'progress_baseline')
          .map(({ record }) => String((record.payload as Record<string, JsonValue>).kind))
          .sort();
        const expectedKinds = [
          'target_delivery_state', 'target_source_change', 'target_status_transition', 'target_test_result',
        ];
        const routeCount = snapshot.referencedRecords.filter(({ record }) => record.recordType === 'route_receipt').length;
        return {
          accepted: routeCount === 1 && canonicalJson(kinds) === canonicalJson(expectedKinds),
          predicateDigest: baselinePredicateDigest,
        };
      };
      const deferralAttempt = (
        idempotencyKey: string,
        casBindings = baselineBindings,
        verifyPredicate: LedgerAppendOptions<JsonValue>['verifyPredicate'] = verifyBaselineBundle,
        commitOptions?: LedgerAppendOptions<JsonValue>['commitOptions'],
      ) => appendFindingLedger({
        ...baseOptions(idempotencyKey),
        operation: 'apply_manifest',
        records: [
          { recordType: 'deferral', payload: { deferralId: idempotencyKey } },
          { recordType: 'manifest', payload: { manifestId: `${idempotencyKey}:manifest`, deferralId: idempotencyKey } },
        ],
        expectedPriorLedgerDigest: beforeBundleCrash.committedLedgerDigest,
        casBindings,
        verifyPredicate,
        commitOptions,
      });
      const wrongId = baselineBindings.map((binding, index) => index === 1
        ? { ...binding, expectedRecordId: 'missing-baseline-record' }
        : binding);
      const wrongHash = baselineBindings.map((binding, index) => index === 2
        ? { ...binding, expectedRecordHash: '0'.repeat(64) }
        : binding);
      const changedBaseline = { ...baselineRecords[3]!, payload: { baselineSetId: 'baseline-set-001', kind: 'changed-bytes' } };
      const changedBytes = baselineBindings.map((binding, index) => index === 3
        ? { ...binding, expectedRecordHash: exactLedgerRecordHash(changedBaseline) }
        : binding);
      const negativeAttempts = [
        () => deferralAttempt('chk003:deferral-wrong-id', wrongId),
        () => deferralAttempt('chk003:deferral-wrong-hash', wrongHash),
        () => deferralAttempt('chk003:deferral-missing-kind', baselineBindings.slice(0, -1)),
        () => deferralAttempt('chk003:deferral-baseline-bytes-changed', changedBytes),
        () => deferralAttempt('chk003:deferral-caller-refusal', baselineBindings, () => ({
          accepted: false, predicateDigest: baselinePredicateDigest,
        })),
      ];
      for (const attempt of negativeAttempts) assert.throws(attempt, /CAS_CONFLICT/);
      assert.equal(integrityStore.readFindingLedger<JsonValue>(integrityStoryId).records.length, beforeBundleCrash.records.length);
      assert.throws(() => deferralAttempt(
        'chk003:deferral-bundle-crash',
        baselineBindings,
        verifyBaselineBundle,
        { beforeRename: () => { throw new Error('injected bundle crash'); } },
      ), /injected bundle crash/);
      const afterBundleCrash = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      assert.equal(afterBundleCrash.records.length, beforeBundleCrash.records.length);
      assert.equal(afterBundleCrash.records.some((record) => canonicalJson(record.payload).includes('deferral-crash')), false);
      const appliedDeferral = deferralAttempt('chk003:deferral-bundle-applied');
      assert.equal(appliedDeferral.recordIds.length, 2);
      const appliedReplay = deferralAttempt('chk003:deferral-bundle-applied');
      assert.deepEqual(appliedReplay.recordIds, appliedDeferral.recordIds);
      console.log('ledger.baseline_bundle_refusal: PASS wrongId=reject wrongHash=reject missingKind=reject bytesChanged=reject callerRefusal=reject zeroWrites=true');
      console.log('ledger.atomic_bundle: PASS halfBundles=0 kinds=4 crashRetry=true');

      const requiredRecord = {
        schemaVersion: 1, mandatoryRepairId: 'mandatory-repair-required-001',
        findingRef: { storyId: integrityStoryId, findingId: 'B-CAS:F-001' },
        state: 'required', classificationHash: 'classification-required-hash',
      };
      const requiredManifest = {
        schemaVersion: 1, manifestId: 'mandatory-manifest-required-001',
        mandatoryRepairId: requiredRecord.mandatoryRepairId,
      };
      const requiredOptions = {
        ...baseOptions('chk003:mandatory-required'),
        record: requiredRecord,
        manifest: requiredManifest,
      };
      const requiredReceipt = classifyMandatoryRepair(requiredOptions);
      const afterRequired = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      const requiredBytes = requiredReceipt.recordIds.map((recordId) => canonicalJson(afterRequired.records.find((record) => record.recordId === recordId)));
      const requiredReplay = classifyMandatoryRepair(requiredOptions);
      assert.deepEqual(requiredReplay.recordIds, requiredReceipt.recordIds);
      assert.equal(requiredReplay.receiptId, requiredReceipt.receiptId);

      const closedRecord = {
        schemaVersion: 1, mandatoryRepairId: 'mandatory-repair-closure-001',
        supersedesMandatoryRepairId: requiredRecord.mandatoryRepairId,
        state: 'closure_proven', classificationHash: 'classification-closure-hash',
        closure: {
          redOrReproductionEvidenceRefs: ['red:1'], rootCauseEvidenceRefs: ['root:1'],
          fixEvidenceRefs: ['fix:1'], greenEvidenceRefs: ['green:1'], closureEvidenceRefs: ['close:1'],
        },
      };
      const closeReceipt = closeMandatoryRepair({
        ...baseOptions('chk003:mandatory-closure'),
        record: closedRecord,
        manifest: {
          schemaVersion: 1, manifestId: 'mandatory-manifest-closure-001',
          mandatoryRepairId: closedRecord.mandatoryRepairId,
          supersedesMandatoryRepairId: requiredRecord.mandatoryRepairId,
        },
      });
      assert.equal(closeReceipt.recordIds.length, 2);
      const beforeMandatoryCrash = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      assert.throws(() => classifyMandatoryRepair({
        ...baseOptions('chk003:mandatory-crash'),
        record: { ...requiredRecord, mandatoryRepairId: 'mandatory-repair-crash' },
        manifest: { manifestId: 'mandatory-manifest-crash', mandatoryRepairId: 'mandatory-repair-crash' },
        commitOptions: { beforeRename: () => { throw new Error('injected mandatory crash'); } },
      }), /injected mandatory crash/);
      const afterMandatoryCrash = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      assert.equal(afterMandatoryCrash.records.length, beforeMandatoryCrash.records.length);
      assert.deepEqual(requiredReceipt.recordIds.map((recordId) => canonicalJson(afterMandatoryCrash.records.find((record) => record.recordId === recordId))), requiredBytes);
      assert.equal(new Set([...requiredReceipt.recordIds, ...closeReceipt.recordIds]).size, 4);
      console.log('ledger.mandatory_repair_records: PASS appendOnly=true idempotent=true halfVisible=0');

      const expiryRecord = {
        schemaVersion: 1, policyVersion: 'v1', policyDigest: 'expiry-policy-digest-001',
        effectiveAt: '2030-01-01T00:00:00.000Z', signedByAuthority: 'command_policy_authority',
      };
      const expiryOptions = {
        ...baseOptions('chk003:expiry-policy'),
        record: expiryRecord,
        manifest: { schemaVersion: 1, manifestId: 'expiry-manifest-001', policyDigest: expiryRecord.policyDigest },
      };
      const expiryReceipt = appendDeferralExpiryPolicy(expiryOptions);
      const expiryReplay = appendDeferralExpiryPolicy(expiryOptions);
      assert.equal(expiryReplay.receiptId, expiryReceipt.receiptId);
      assert.deepEqual(expiryReplay.recordIds, expiryReceipt.recordIds);
      const beforeExpiryCrash = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      assert.throws(() => appendDeferralExpiryPolicy({
        ...baseOptions('chk003:expiry-policy-crash'),
        record: { ...expiryRecord, policyDigest: 'expiry-policy-digest-crash' },
        manifest: { manifestId: 'expiry-manifest-crash', policyDigest: 'expiry-policy-digest-crash' },
        commitOptions: { beforeRename: () => { throw new Error('injected expiry crash'); } },
      }), /injected expiry crash/);
      assert.equal(integrityStore.readFindingLedger(integrityStoryId).records.length, beforeExpiryCrash.records.length);
      console.log('ledger.expiry_policy_records: PASS appendOnly=true idempotent=true halfVisible=0');

      const mutatedReceipts: Array<typeof casReceipt> = [];
      const mutate = (field: string, value: unknown): void => {
        const copy = structuredClone(casReceipt) as unknown as Record<string, unknown>;
        copy[field] = value;
        mutatedReceipts.push(copy as unknown as typeof casReceipt);
      };
      mutate('schemaVersion', 2);
      mutate('ledgerSchemaEpoch', 2);
      mutate('minimumWriterCapability', 'other-writer');
      mutate('receiptId', 'other-receipt');
      mutate('storyId', 'B-OTHER');
      mutate('idempotencyKey', 'other-idempotency');
      mutate('exactRequestDigest', '0'.repeat(64));
      mutate('operation', 'append_deferral');
      mutate('recordIds', [...casReceipt.recordIds, 'extra-record']);
      mutate('casBindings', [{ ...casReceipt.casBindings[0]!, predicateDigest: 'other-predicate' }]);
      mutate('priorLedgerDigest', '1'.repeat(64));
      mutate('committedLedgerDigest', '2'.repeat(64));
      mutate('replayed', true);
      mutate('committedAt', '2031-01-01T00:00:00.000Z');
      mutate('writerSessionId', 'other-session');
      mutate('writerLeaseId', 'other-lease');
      mutate('writerFenceToken', 'other-fence');
      mutate('keyId', 'other-key');
      mutate('algorithm', 'other-algorithm');
      mutate('trustRootDigest', 'other-trust-root');
      mutate('keyFreshnessPolicyDigest', 'other-freshness');
      mutate('receiptHash', '3'.repeat(64));
      mutate('signature', 'invalid-signature');
      const reorderedIds = structuredClone(baselineBundle);
      reorderedIds.recordIds = [...reorderedIds.recordIds].reverse();
      mutatedReceipts.push(reorderedIds);
      const extraField = structuredClone(casReceipt) as unknown as Record<string, unknown>;
      extraField.unaccepted = true;
      mutatedReceipts.push(extraField as unknown as typeof casReceipt);
      assert.equal(mutatedReceipts.filter((candidate) => verifyFindingLedgerReceipt(candidate, ledgerTrust)).length, 0);
      console.log('ledger.receipt_mutation_matrix: PASS acceptedMutations=0');

      const applySeed = appendFindingLedger({
        ...baseOptions('chk003:apply-seed'), operation: 'append_route_receipt',
        records: [{ recordType: 'route_receipt', payload: { receiptId: 'apply-seed', status: 'current' } }],
      });
      const beforeApply = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      const applyRecord = beforeApply.records.find((record) => record.recordId === applySeed.recordIds[0])!;
      const applyHead = beforeApply.records.at(-1)!;
      const applyPredicate = 'apply-current-receipt';
      const applyBinding = {
        recordType: applyRecord.recordType,
        expectedRecordId: applyRecord.recordId,
        expectedRecordHash: exactLedgerRecordHash(applyRecord),
        observedChainHeadId: applyHead.recordId,
        observedChainHeadHash: exactLedgerRecordHash(applyHead),
        predicateDigest: applyPredicate,
      };
      appendFindingLedger({
        ...baseOptions('chk003:apply-wins'), operation: 'apply_manifest',
        records: [
          { recordType: 'deferral', payload: { deferralId: 'serialized-apply' } },
          { recordType: 'manifest', payload: { manifestId: 'serialized-apply-manifest', deferralId: 'serialized-apply' } },
        ],
        expectedPriorLedgerDigest: beforeApply.committedLedgerDigest,
        casBindings: [applyBinding],
        verifyPredicate: () => ({ accepted: true, predicateDigest: applyPredicate }),
      });
      assert.throws(() => appendFindingLedger({
        ...baseOptions('chk003:late-revoke'), operation: 'append_supersession',
        records: [{ recordType: 'supersession', payload: { supersedes: 'apply-seed' } }],
        expectedPriorLedgerDigest: beforeApply.committedLedgerDigest,
        casBindings: [applyBinding],
        verifyPredicate: () => ({ accepted: true, predicateDigest: applyPredicate }),
      }), /CAS_CONFLICT/);

      const revokeSeed = appendFindingLedger({
        ...baseOptions('chk003:revoke-seed'), operation: 'append_route_receipt',
        records: [{ recordType: 'route_receipt', payload: { receiptId: 'revoke-seed', status: 'current' } }],
      });
      const beforeRevoke = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      const revokeRecord = beforeRevoke.records.find((record) => record.recordId === revokeSeed.recordIds[0])!;
      const revokeBinding = {
        recordType: revokeRecord.recordType,
        expectedRecordId: revokeRecord.recordId,
        expectedRecordHash: exactLedgerRecordHash(revokeRecord),
        observedChainHeadId: revokeRecord.recordId,
        observedChainHeadHash: exactLedgerRecordHash(revokeRecord),
        predicateDigest: 'revoke-current-receipt',
      };
      appendFindingLedger({
        ...baseOptions('chk003:revoke-wins'), operation: 'append_supersession',
        records: [{ recordType: 'supersession', payload: { supersedes: 'revoke-seed' } }],
        expectedPriorLedgerDigest: beforeRevoke.committedLedgerDigest,
        casBindings: [revokeBinding],
        verifyPredicate: () => ({ accepted: true, predicateDigest: 'revoke-current-receipt' }),
      });
      assert.throws(() => appendFindingLedger({
        ...baseOptions('chk003:late-apply'), operation: 'apply_manifest',
        records: [{ recordType: 'deferral', payload: { deferralId: 'non-latest-must-not-commit' } }],
        expectedPriorLedgerDigest: beforeRevoke.committedLedgerDigest,
        casBindings: [revokeBinding],
        verifyPredicate: () => ({ accepted: true, predicateDigest: 'revoke-current-receipt' }),
      }), /CAS_CONFLICT/);
      assert.equal(integrityStore.readFindingLedger<JsonValue>(integrityStoryId).records.some((record) => canonicalJson(record.payload).includes('non-latest-must-not-commit')), false);
      console.log('ledger.revoke_apply_serialization: PASS nonLatestCommits=0');

      const beforeCallbackCrash = integrityStore.readFindingLedger<JsonValue>(integrityStoryId);
      const callbackRecord = beforeCallbackCrash.records.at(-1)!;
      const callbackPredicate = 'opaque-caller-predicate';
      assert.throws(() => appendFindingLedger({
        ...baseOptions('chk003:callback-crash'), operation: 'append_candidate',
        records: [{ recordType: 'opaque_future_record', payload: { uninterpreted: ['route', 'assessment', 'gate'] } }],
        expectedPriorLedgerDigest: beforeCallbackCrash.committedLedgerDigest,
        casBindings: [{
          recordType: callbackRecord.recordType,
          expectedRecordId: callbackRecord.recordId,
          expectedRecordHash: exactLedgerRecordHash(callbackRecord),
          observedChainHeadId: callbackRecord.recordId,
          observedChainHeadHash: exactLedgerRecordHash(callbackRecord),
          predicateDigest: callbackPredicate,
        }],
        verifyPredicate: () => { throw new Error('schema-neutral callback crash'); },
      }), /schema-neutral callback crash/);
      assert.equal(integrityStore.readFindingLedger(integrityStoryId).records.length, beforeCallbackCrash.records.length);
      console.log('ledger.callback_crash_boundary: PASS semanticWrites=0 schemaNeutral=true');
    } finally {
      integrityLock.release();
    }
const mixedFile = join(scratch, 'mixed', 'finding-ledger.json');
const mixedLock = join(scratch, 'locks', 'mixed.lock');
const mixedTypes = [
      'finding',
      'candidate_route',
      'assessment',
      'mandatory_repair',
      'expiry_policy',
      'deferral',
      'route',
      'baseline_set',
      'material_drift_reattestation',
      'manifest',
    ];
await runWorkers(mixedTypes.map((recordType, index) => ({
      ledgerFile: mixedFile,
      lockDir: mixedLock,
      prefix: `mixed-${index}`,
      count: 2,
      recordType,
      payloadBase: { ref: 'root' },
    })));
const mixed = readLedger(mixedFile);
assert.equal(mixed.records.length, mixedTypes.length * 2);
assert.equal(mixed.records.filter((record) => (record.payload as Record<string, JsonValue>).ref !== 'root').length, 0);
console.log('ledger.mixed_transactions: PASS lost=0 brokenRefs=0');
const legacyFile = join(scratch, 'legacy', 'finding-ledger.json');
const legacyLockDir = join(scratch, 'locks', 'legacy.lock');
const legacyFindingPath = join(scratch, 'legacy', 'findings.json');
mkdirSync(join(scratch, 'legacy'), { recursive: true });
const legacyBytes = '{\n  "findings": [{"id":"B-OLD:F-001","desc":"legacy bytes"}]\n}\n';
writeFileSync(legacyFindingPath, legacyBytes, 'utf8');
await runWorkers(Array.from({ length: 12 }, (_, index) => ({
      ledgerFile: legacyFile,
      lockDir: legacyLockDir,
      prefix: `legacy-${index}`,
      count: 1,
      recordType: 'legacy_identity_binding',
      payloadBase: { storyId: 'B-OLD', findingId: 'B-OLD:F-001', findingHash: 'abc123' },
      uniqueBindingKey: 'legacy:B-OLD:B-OLD:F-001',
    })));
const legacy = readLedger(legacyFile);
assert.equal(legacy.records.length, 1);
assert.equal(new Set(legacy.receipts.flatMap((receipt) => receipt.recordIds)).size, 1);
const legacyConflictLock = acquireMkdirLock(legacyLockDir, {
      label: 'legacy binding conflict', requireHolderToken: true,
    });
try {
      const fence = captureMkdirLockFence(legacyLockDir);
      assert.throws(() => appendLedgerTransaction(
        legacyFile,
        request(
          fence.writerFenceToken,
          'legacy-conflicting-hash',
          'legacy_identity_binding',
          { storyId: 'B-OLD', findingId: 'B-OLD:F-001', findingHash: 'changed' },
          'legacy:B-OLD:B-OLD:F-001',
        ),
        fence,
      ), /IMMUTABLE_BINDING_CONFLICT|already bound/);
    } finally {
      legacyConflictLock.release();
    }
assert.equal(readLedger(legacyFile).records.length, 1);
assert.equal(readFileSync(legacyFindingPath, 'utf8'), legacyBytes);
console.log('ledger.legacy_binding: PASS singleRecord=true rewrite=false');
console.log('green.legacy_migration: PASS legacyRewrites=0');
const refusalFile = join(scratch, 'refusal', 'finding-ledger.json');
const refusalLockDir = join(scratch, 'locks', 'refusal.lock');
const refusalLock = acquireMkdirLock(refusalLockDir, { label: 'capability refusal', requireHolderToken: true });
try {
      const fence = captureMkdirLockFence(refusalLockDir);
      const base = request(fence.writerFenceToken, 'refusal', 'finding', { id: 'refused' });
      const attempts: AppendRequest<JsonValue>[] = [
        { ...base, storageCapability: 'nfs-multi-host' },
        { ...base, ledgerSchemaEpoch: FINDING_LEDGER_SCHEMA_EPOCH + 1 },
        { ...base, writerCapability: 'legacy-writer-v0' },
      ];
      for (const attempt of attempts) {
        assert.throws(() => appendLedgerTransaction(refusalFile, attempt, fence), LedgerRefusal);
      }
    } finally {
      refusalLock.release();
    }
assert.equal(existsSync(refusalFile), false);
console.log('ledger.capability_boundary: PASS writes=0');
const crashFile = join(scratch, 'crash', 'finding-ledger.json');
const crashLockDir = join(scratch, 'locks', 'crash.lock');
const crashLock = acquireMkdirLock(crashLockDir, { label: 'crash boundary', requireHolderToken: true });
try {
      const fence = captureMkdirLockFence(crashLockDir);
      assert.throws(() => appendLedgerTransaction(
        crashFile,
        request(fence.writerFenceToken, 'crash:1', 'finding', { id: 'half' }),
        fence,
        { beforeRename: () => { throw new Error('injected crash before rename'); } },
      ), /injected crash/);
    } finally {
      crashLock.release();
    }
assert.equal(recoverLedger(crashFile).records.length, 0);
console.log('ledger.crash_recovery: PASS halfVisible=0');
const staleFile = join(scratch, 'stale', 'finding-ledger.json');
const staleLockDir = join(scratch, 'locks', 'stale.lock');
const staleHolder = acquireMkdirLock(staleLockDir, {
      label: 'stale holder', requireHolderToken: true, staleMs: 5, deadlineMs: 50,
    });
const staleFence = captureMkdirLockFence(staleLockDir);
const oldTime = new Date(Date.now() - 10_000);
utimesSync(staleLockDir, oldTime, oldTime);
const successor = acquireMkdirLock(staleLockDir, {
      label: 'successor holder', requireHolderToken: true, staleMs: 5, deadlineMs: 1_000,
      // Current mkdir-lock semantics never age-steal a provably live same-host
      // holder. This fixture runs both logical holders in one process, so use
      // the explicit classifier seam to model the dead/stale predecessor whose
      // token the ledger fence must reject.
      classifyExistingLock: () => 'stale',
    });
try {
      assert.throws(() => appendLedgerTransaction(
        staleFile,
        request(staleFence.writerFenceToken, 'stale:1', 'finding', { id: 'stale' }),
        staleFence,
      ), /STALE_FENCE|ownership changed/);
      assert.equal(existsSync(staleFile), false);
      const successorFence = captureMkdirLockFence(staleLockDir);
      appendLedgerTransaction(
        staleFile,
        request(successorFence.writerFenceToken, 'successor:1', 'finding', { id: 'current' }),
        successorFence,
      );
      staleHolder.release();
      assert.equal(successor.isCurrent?.(), true);
    } finally {
      successor.release();
    }
assert.equal(readLedger(staleFile).records.length, 1);
console.log('ledger.stale_fence: PASS staleWrites=0');
const interleavingFile = join(scratch, 'stale-interleaving', 'finding-ledger.json');
const interleavingLockDir = join(scratch, 'locks', 'stale-interleaving.lock');
const oldWriter = acquireMkdirLock(interleavingLockDir, {
      label: 'old writer interleaving', requireHolderToken: true,
    });
const oldFence = captureMkdirLockFence(interleavingLockDir);
let successorIssuedBeforePublication = false;
let successorWriter: ReturnType<typeof acquireMkdirLock> | undefined;
assert.throws(() => appendLedgerTransaction(
      interleavingFile,
      request(oldFence.writerFenceToken, 'interleaving:old', 'finding', { id: 'must-not-commit' }),
      oldFence,
      {
        beforeRename: () => {
          oldWriter.release();
          successorWriter = acquireMkdirLock(interleavingLockDir, {
            label: 'successor writer interleaving', requireHolderToken: true,
          });
          successorIssuedBeforePublication = true;
        },
      },
    ), /STALE_FENCE|ownership changed/);
assert.equal(successorIssuedBeforePublication, true);
assert.equal(existsSync(interleavingFile), false);
try {
      const successorFence = captureMkdirLockFence(interleavingLockDir);
      appendLedgerTransaction(
        interleavingFile,
        request(successorFence.writerFenceToken, 'interleaving:successor', 'finding', { id: 'successor-only' }),
        successorFence,
      );
    } finally {
      successorWriter?.release();
    }
const interleavingLedger = readLedger(interleavingFile);
assert.deepEqual(interleavingLedger.records.map((record) => (
      record.payload as Record<string, JsonValue>
    ).id), ['successor-only']);
console.log('ledger.stale_fence_interleaving: PASS successorIssuedBeforePublication=true staleWriterCommitted=false');
const normalCompatibilityLock = join(scratch, 'story', 'B-SMOKE', 'findings.lock');
const normal = acquireMkdirLock(normalCompatibilityLock, {
      label: 'normal Finding compatibility', requireHolderToken: true,
    });
try {
      const fence = captureMkdirLockFence(normalCompatibilityLock);
      appendLedgerTransaction(
        join(scratch, 'story', 'B-SMOKE', 'finding-ledger.json'),
        request(fence.writerFenceToken, 'lock-normal', 'finding', { id: 'normal' }),
        fence,
      );
    } finally {
      normal.release();
    }
const main = acquireMainWriteLock(scratch, { label: 'B-META ledger compatibility', onContention: 'wait' });
try {
      const canonicalMainLock = mainWriteLockPath(scratch);
      assert.equal(main.lockDir, canonicalMainLock);
      const fence = captureMkdirLockFence(canonicalMainLock);
      appendLedgerTransaction(
        join(scratch, 'story', 'B-META-framework-audit', 'finding-ledger.json'),
        request(fence.writerFenceToken, 'lock-meta', 'finding', { id: 'meta' }),
        fence,
      );
    } finally {
      main.release();
    }
console.log('ledger.lock_compatibility: PASS deadlocks=0');
}
