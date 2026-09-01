/** Story 3A/CHK-003: public, schema-neutral Finding ledger transaction helpers. */
import {
  canonicalHash, canonicalJson, planAppend, readLedger,
  FINDING_LEDGER_SCHEMA_EPOCH, FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY,
  FINDING_LEDGER_LOCAL_FS_CAPABILITY,
  type AppendLedgerOptions, type AppendPlan, type AppendRequest,
  type JsonValue, type LedgerCommitReceipt, type LedgerEnvelope, type LedgerFence,
  type LedgerRecord,
} from '../core/finding-ledger.js';
import { signCanonical, verifyCanonical } from '../core/authority-signing.js';
import type { StoryStore } from '../core/store.js';
import type {
  FindingLedgerCasBinding,
  FindingLedgerOperation,
  FindingLedgerReceipt,
} from '../core/types.js';

export type { FindingLedgerCasBinding, FindingLedgerOperation, FindingLedgerReceipt } from '../core/types.js';

export interface LedgerSigner {
  privateKey: string;
  publicKey: string;
  keyId: string;
  trustRootDigest: string;
  keyFreshnessPolicyDigest: string;
}
export interface LedgerReceiptTrust extends Omit<LedgerSigner, 'privateKey'> {
  algorithm: 'ed25519';
}
export interface LedgerExactCasSnapshot<T extends JsonValue = JsonValue> {
  ledger: LedgerEnvelope<T>;
  referencedRecords: Array<{ record: LedgerRecord<T>; canonicalBytes: string }>;
  currentChainHeadId: string;
  currentChainHeadHash: string;
}
export interface LedgerPredicateResult { accepted: boolean; predicateDigest: string; }
export interface LedgerAppendOptions<T extends JsonValue = JsonValue> {
  storyId: string; store: StoryStore; operation: FindingLedgerOperation; idempotencyKey: string;
  records: Array<{ recordType: string; payload: T; uniqueBindingKey?: string }>;
  writerSessionId: string; writerLeaseId: string; writerFenceToken: string; fence: LedgerFence;
  signer: LedgerSigner; casBindings?: FindingLedgerCasBinding[]; expectedPriorLedgerDigest?: string;
  verifyPredicate?: (snapshot: LedgerExactCasSnapshot<T>) => LedgerPredicateResult;
  commitOptions?: AppendLedgerOptions;
}

function unsignedReceipt(receipt: FindingLedgerReceipt): Omit<FindingLedgerReceipt, 'receiptHash' | 'signature'> {
  const { receiptHash: _hash, signature: _signature, ...unsigned } = receipt;
  return unsigned;
}
function receiptHash(receipt: FindingLedgerReceipt): string { return canonicalHash(unsignedReceipt(receipt)); }
function assertText(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
}

export function signFindingLedgerReceipt(receipt: Omit<FindingLedgerReceipt, 'receiptHash' | 'signature'>, signer: LedgerSigner): FindingLedgerReceipt {
  assertText(signer.privateKey, 'signer.privateKey');
  const hash = canonicalHash(receipt);
  return { ...receipt, receiptHash: hash, signature: signCanonical({ ...receipt, receiptHash: hash }, signer.privateKey) };
}

const RECEIPT_KEYS = [
  'schemaVersion', 'ledgerSchemaEpoch', 'minimumWriterCapability', 'receiptId', 'storyId',
  'idempotencyKey', 'operation', 'recordIds', 'casBindings', 'priorLedgerDigest',
  'committedLedgerDigest', 'replayed', 'committedAt', 'writerSessionId', 'writerLeaseId',
  'writerFenceToken', 'keyId', 'algorithm', 'trustRootDigest', 'keyFreshnessPolicyDigest',
  'receiptHash', 'signature',
].sort();
const CAS_KEYS = [
  'recordType', 'expectedRecordId', 'expectedRecordHash', 'observedChainHeadId',
  'observedChainHeadHash', 'predicateDigest',
].sort();
const LEDGER_OPERATIONS = new Set<FindingLedgerOperation>([
  'append_finding', 'append_legacy_identity_binding', 'append_detector_signal',
  'append_candidate_route', 'append_candidate', 'append_assessment_proposal',
  'append_assessment', 'append_mandatory_repair', 'append_deferral_expiry_policy',
  'append_deferral', 'append_route_receipt', 'append_progress_baseline_set',
  'append_material_drift_reattestation', 'append_runtime_receipt',
  'append_canonical_defect_supersession', 'append_canonical_defect',
  'append_supersession', 'apply_manifest',
]);

function exactKeys(value: object, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected);
}

export function verifyFindingLedgerReceipt(
  receipt: FindingLedgerReceipt,
  trust: string | LedgerReceiptTrust,
): boolean {
  try {
    if (!exactKeys(receipt, RECEIPT_KEYS)
      || !receipt.casBindings.every((binding) => exactKeys(binding, CAS_KEYS))) return false;
    const publicKey = typeof trust === 'string' ? trust : trust.publicKey;
    if (typeof trust !== 'string' && (
      receipt.keyId !== trust.keyId
      || receipt.algorithm !== trust.algorithm
      || receipt.trustRootDigest !== trust.trustRootDigest
      || receipt.keyFreshnessPolicyDigest !== trust.keyFreshnessPolicyDigest
    )) return false;
    if (receipt.schemaVersion !== 1 || receipt.ledgerSchemaEpoch !== FINDING_LEDGER_SCHEMA_EPOCH
      || receipt.minimumWriterCapability !== FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY
      || receipt.algorithm !== 'ed25519'
      || !LEDGER_OPERATIONS.has(receipt.operation)
      || !receipt.recordIds.length
      || new Set(receipt.recordIds).size !== receipt.recordIds.length
      || [
        receipt.receiptId, receipt.storyId, receipt.idempotencyKey, receipt.priorLedgerDigest,
        receipt.committedLedgerDigest, receipt.committedAt, receipt.writerSessionId,
        receipt.writerLeaseId, receipt.writerFenceToken, receipt.keyId, receipt.trustRootDigest,
        receipt.keyFreshnessPolicyDigest, receipt.receiptHash, receipt.signature,
      ].some((value) => typeof value !== 'string' || !value.trim())
      || receipt.casBindings.some((binding) => Object.values(binding).some((value) => !value.trim()))
      || receipt.receiptHash !== receiptHash(receipt)) return false;
    return verifyCanonical({ ...unsignedReceipt(receipt), receiptHash: receipt.receiptHash }, receipt.signature, publicKey);
  } catch { return false; }
}

type PersistedCommitReceipt = LedgerCommitReceipt & {
  exactRequestDigest?: string;
  findingLedgerReceipt?: FindingLedgerReceipt;
};

function currentChainHead<T>(ledger: LedgerEnvelope<T>): { id: string; hash: string } {
  const head = ledger.records.at(-1);
  return head
    ? { id: head.recordId, hash: canonicalHash(head) }
    : { id: 'ledger:empty', hash: canonicalHash([]) };
}

export function exactLedgerRecordHash(record: LedgerRecord<unknown>): string {
  return canonicalHash(record);
}

function exactRequestDigest<T extends JsonValue>(options: LedgerAppendOptions<T>): string {
  return canonicalHash({
    storyId: options.storyId,
    operation: options.operation,
    idempotencyKey: options.idempotencyKey,
    records: options.records,
    casBindings: options.casBindings ?? [],
    ...(options.expectedPriorLedgerDigest !== undefined
      ? { expectedPriorLedgerDigest: options.expectedPriorLedgerDigest }
      : {}),
  });
}

/**
 * Compare exact referenced-record bytes, chain tip, ledger digest and a
 * caller-owned predicate under the acquired fence, then publish semantic rows
 * and the signed receipt in one atomic Store write.
 */
export function appendFindingLedger<T extends JsonValue = JsonValue>(options: LedgerAppendOptions<T>): FindingLedgerReceipt {
  if (options.fence.writerFenceToken !== options.writerFenceToken) {
    throw new Error('STALE_FENCE: request fence token does not match the acquired lock');
  }
  const request: AppendRequest<T> = {
    operation: options.operation, idempotencyKey: options.idempotencyKey, records: options.records,
    ledgerSchemaEpoch: FINDING_LEDGER_SCHEMA_EPOCH, writerCapability: FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY,
    writerSessionId: options.writerSessionId, writerFenceToken: options.writerFenceToken,
    expectedPriorLedgerDigest: options.expectedPriorLedgerDigest, storageCapability: FINDING_LEDGER_LOCAL_FS_CAPABILITY,
  };
  const transactionDigest = exactRequestDigest(options);
  return options.store.transactFindingLedger<T, FindingLedgerReceipt>(options.storyId, options.fence, (current) => {
    const existing = current.receipts.find((candidate) => candidate.idempotencyKey === options.idempotencyKey) as PersistedCommitReceipt | undefined;
    if (existing) {
      if (existing.exactRequestDigest !== transactionDigest || !existing.findingLedgerReceipt) {
        throw new Error('IDEMPOTENCY_CONFLICT: idempotency key is bound to different exact transaction bytes');
      }
      if (!verifyFindingLedgerReceipt(existing.findingLedgerReceipt, {
        publicKey: options.signer.publicKey,
        keyId: options.signer.keyId,
        algorithm: 'ed25519',
        trustRootDigest: options.signer.trustRootDigest,
        keyFreshnessPolicyDigest: options.signer.keyFreshnessPolicyDigest,
      })) throw new Error('IDEMPOTENCY_CONFLICT: original signed receipt is invalid');
      const records = existing.recordIds.map((recordId) => {
        const record = current.records.find((candidate) => candidate.recordId === recordId);
        if (!record) throw new Error(`ledger receipt references missing record ${recordId}`);
        return record;
      });
      const replayPlan: AppendPlan<T> = {
        action: 'replay', records, receipt: existing, envelope: current,
      };
      return { plan: replayPlan, result: existing.findingLedgerReceipt };
    }

    if (options.expectedPriorLedgerDigest !== undefined
      && options.expectedPriorLedgerDigest !== current.committedLedgerDigest) {
      throw new Error('CAS_CONFLICT: prior ledger digest does not match');
    }
    const bindings = options.casBindings ?? [];
    const head = currentChainHead(current);
    const referencedRecords = bindings.map((binding) => {
      const record = current.records.find((candidate) => candidate.recordId === binding.expectedRecordId);
      if (!record || record.recordType !== binding.recordType
        || exactLedgerRecordHash(record) !== binding.expectedRecordHash
        || binding.observedChainHeadId !== head.id
        || binding.observedChainHeadHash !== head.hash) {
        throw new Error('CAS_CONFLICT: exact record or current chain head does not match');
      }
      return { record, canonicalBytes: canonicalJson(record) };
    });
    if (bindings.length > 0) {
      if (!options.verifyPredicate) throw new Error('CAS_CONFLICT: predicate verifier is required');
      const predicate = options.verifyPredicate({
        ledger: current, referencedRecords, currentChainHeadId: head.id, currentChainHeadHash: head.hash,
      });
      if (!predicate.accepted || bindings.some((binding) => binding.predicateDigest !== predicate.predicateDigest)) {
        throw new Error('CAS_CONFLICT: predicate digest or result does not match');
      }
    }

    const plan = planAppend(current, request);
    const core = plan.receipt;
    const receipt = signFindingLedgerReceipt({
      schemaVersion: 1, ledgerSchemaEpoch: FINDING_LEDGER_SCHEMA_EPOCH,
      minimumWriterCapability: FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY, receiptId: core.receiptId,
      storyId: options.storyId, idempotencyKey: core.idempotencyKey, operation: options.operation,
      recordIds: core.recordIds, casBindings: bindings, priorLedgerDigest: core.priorLedgerDigest,
      committedLedgerDigest: core.committedLedgerDigest, replayed: false, committedAt: core.committedAt,
      writerSessionId: core.writerSessionId, writerLeaseId: options.writerLeaseId,
      writerFenceToken: core.writerFenceToken, keyId: options.signer.keyId, algorithm: 'ed25519',
      trustRootDigest: options.signer.trustRootDigest,
      keyFreshnessPolicyDigest: options.signer.keyFreshnessPolicyDigest,
    }, options.signer);
    const persisted = core as PersistedCommitReceipt;
    persisted.exactRequestDigest = transactionDigest;
    persisted.findingLedgerReceipt = receipt;
    return { plan, result: receipt };
  }, options.commitOptions);
}

export function replayOriginalRecordIds(receipt: FindingLedgerReceipt): string[] { return [...receipt.recordIds]; }

export interface AssessmentProposalVerification { valid: boolean; rejection?: string; proposalDigest?: string; }
export interface AssessmentProposalVerifyOptions {
  publicKey: string;
  expectedAuthorityDigest: string;
  now?: Date;
  expectedFindingHash?: string;
  expectedHeadHash?: string;
  expectedMaterialHash?: string;
  expectedStoryFilesHash?: string;
  receipt?: FindingLedgerReceipt;
  receiptTrust?: LedgerReceiptTrust;
  proposalRecord?: LedgerRecord<JsonValue>;
  requireReceipt?: boolean;
  receiptIsCurrent?: boolean;
  finalAssessment?: Record<string, unknown>;
}

const PROPOSAL_ENVELOPE_KEYS = [
  'schemaVersion', 'proposalId', 'findingRef', 'findingHash', 'findingVersion',
  'evaluationScope', 'owner', 'issuedAt', 'expiresAt', 'freshnessPolicyVersion',
  'maxAgeSeconds', 'dependencyBundle', 'evidenceRefs', 'historicalSourceRefs',
  'protectedSurfaceEvaluation', 'reviewRunId', 'reviewRound', 'scopeDigest',
  'headHash', 'materialHash', 'storyFilesHash', 'runtimeReceiptIds', 'assessedBy',
  'proposalDigest', 'proposalSigner', 'proposalSignature', 'verdict', 'basis',
];
const PROPOSAL_VARIANT_KEYS: Record<string, string[]> = {
  applicable: ['currentWitness'],
  pre_existing_unaffected: ['baseHead'],
  out_of_scope: ['excludedScopeProofDigest'],
  duplicate: ['canonicalDefectRef'],
  not_reproduced_under_current_witness: ['currentWitness'],
  unknown: [],
};

function proposalUnsigned(proposal: Record<string, unknown>): Record<string, unknown> {
  const { proposalDigest: _digest, proposalSignature: _signature, ...unsigned } = proposal;
  return unsigned;
}

export function signAssessmentProposal(
  proposal: Omit<Record<string, unknown>, 'proposalDigest' | 'proposalSignature'>,
  privateKey: string,
): Record<string, unknown> {
  const digest = canonicalHash(proposal);
  return {
    ...proposal,
    proposalDigest: digest,
    proposalSignature: signCanonical({ proposalDigest: digest }, privateKey),
  };
}

function proposalExactUnionValid(proposal: Record<string, unknown>): boolean {
  const verdict = typeof proposal.verdict === 'string' ? proposal.verdict : '';
  const variant = PROPOSAL_VARIANT_KEYS[verdict];
  if (!variant || !exactKeys(proposal, [...PROPOSAL_ENVELOPE_KEYS, ...variant].sort())) return false;
  const signer = proposal.proposalSigner;
  if (!signer || typeof signer !== 'object'
    || !exactKeys(signer, ['actorId', 'algorithm', 'authorityDigest', 'keyId', 'trustRootDigest'])) return false;
  if (proposal.schemaVersion !== 1
    || !['target_story', 'canonical_owner', 'repository_release'].includes(String(proposal.evaluationScope))
    || !Array.isArray(proposal.evidenceRefs)
    || !Array.isArray(proposal.historicalSourceRefs)
    || !Array.isArray(proposal.protectedSurfaceEvaluation)
    || !Array.isArray(proposal.runtimeReceiptIds)
    || typeof proposal.maxAgeSeconds !== 'number'
    || proposal.maxAgeSeconds <= 0) return false;
  const owner = proposal.owner;
  const basis = proposal.basis;
  if (verdict === 'applicable') {
    const witness = proposal.currentWitness;
    return owner === 'current_story' && (basis === 'introduced_by_diff' || basis === 'direct_scope')
      && !!witness && typeof witness === 'object'
      && exactKeys(witness, ['receiptIds', 'reproduced'])
      && (witness as Record<string, unknown>).reproduced === true
      && Array.isArray((witness as Record<string, unknown>).receiptIds);
  }
  if (verdict === 'pre_existing_unaffected') return (owner === 'meta' || owner === 'other_story') && basis === 'base_head_reproduction';
  if (verdict === 'out_of_scope') return (owner === 'meta' || owner === 'other_story') && basis === 'decision_scope';
  if (verdict === 'duplicate') return (owner === 'meta' || owner === 'other_story') && basis === 'canonical_duplicate';
  if (verdict === 'not_reproduced_under_current_witness') return (owner === 'meta' || owner === 'other_story') && basis === 'counter_evidence';
  return verdict === 'unknown' && (basis === 'direct_scope' || basis === 'counter_evidence')
    && !Object.hasOwn(proposal, 'nonBlockingProof');
}

function proposalMatchesFinal(proposal: Record<string, unknown>, finalAssessment: Record<string, unknown>): boolean {
  if (finalAssessment.proposalId !== proposal.proposalId
    || finalAssessment.assessmentProposalDigest !== proposal.proposalDigest) return false;
  const ignored = new Set(['proposalDigest', 'proposalSignature']);
  for (const [key, value] of Object.entries(proposal)) {
    if (ignored.has(key)) continue;
    if (!(key in finalAssessment)) return false;
    if (canonicalHash(finalAssessment[key]) !== canonicalHash(value)) return false;
  }
  return true;
}

/** Shared rejection matrix primitive: every mutation is rejected before route acceptance. */
export function verifyAssessmentProposal(
  proposal: Record<string, unknown>,
  opts: AssessmentProposalVerifyOptions,
): AssessmentProposalVerification {
  const reject = (rejection: string): AssessmentProposalVerification => ({ valid: false, rejection });
  try {
    if (!proposalExactUnionValid(proposal)) return reject('proposal_exact_union_invalid');
    const { proposalDigest: digest, proposalSignature: signature, ...unsigned } = proposal;
    if (typeof digest !== 'string' || digest !== canonicalHash(unsigned)) return reject('proposal_digest_mismatch');
    const signer = proposal.proposalSigner as Record<string, unknown> | undefined;
    if (!signer || signer.authorityDigest !== opts.expectedAuthorityDigest) return reject('proposal_authority_invalid');
    if (typeof signature !== 'string'
      || !verifyCanonical({ proposalDigest: digest }, signature, opts.publicKey)) return reject('proposal_signature_invalid');
    if (opts.expectedFindingHash && proposal.findingHash !== opts.expectedFindingHash) return reject('finding_hash_mismatch');
    if ((opts.requireReceipt || opts.finalAssessment) && !opts.receipt) return reject('proposal_receipt_missing');
    if (opts.receipt) {
      if (!opts.receiptTrust || !verifyFindingLedgerReceipt(opts.receipt, opts.receiptTrust)
        || opts.receipt.operation !== 'append_assessment_proposal'
        || !opts.receipt.recordIds.length
        || opts.receiptIsCurrent === false) return reject('proposal_receipt_invalid');
      if (opts.proposalRecord && (
        !opts.receipt.recordIds.includes(opts.proposalRecord.recordId)
        || canonicalHash(opts.proposalRecord.payload) !== canonicalHash(proposal)
      )) return reject('proposal_receipt_invalid');
    }
    const now = opts.now?.getTime();
    const expiresAt = typeof proposal.expiresAt === 'string' ? Date.parse(proposal.expiresAt) : Number.NaN;
    const issuedAt = typeof proposal.issuedAt === 'string' ? Date.parse(proposal.issuedAt) : Number.NaN;
    const maxAge = typeof proposal.maxAgeSeconds === 'number' ? proposal.maxAgeSeconds * 1_000 : Number.NaN;
    if (now !== undefined && (!Number.isFinite(expiresAt) || now >= expiresAt)) return reject('proposal_expired');
    if (now !== undefined && (!Number.isFinite(issuedAt) || !Number.isFinite(maxAge) || now >= issuedAt + maxAge)) return reject('proposal_stale');
    if ((opts.expectedHeadHash && proposal.headHash !== opts.expectedHeadHash)
      || (opts.expectedMaterialHash && proposal.materialHash !== opts.expectedMaterialHash)
      || (opts.expectedStoryFilesHash && proposal.storyFilesHash !== opts.expectedStoryFilesHash)) {
      return reject('proposal_stale');
    }
    if (opts.finalAssessment && !proposalMatchesFinal(proposal, opts.finalAssessment)) {
      return reject('proposal_final_divergence');
    }
    if (opts.finalAssessment && opts.receipt) {
      const expectedTuple = {
        receiptId: opts.receipt.receiptId,
        receiptHash: opts.receipt.receiptHash,
        operation: 'append_assessment_proposal',
      };
      if (canonicalHash(opts.finalAssessment.proposalReceipt) !== canonicalHash(expectedTuple)) {
        return reject('proposal_final_divergence');
      }
    }
    return { valid: true, proposalDigest: digest };
  } catch { return reject('proposal_malformed'); }
}

export interface AssessmentProposalAppendOptions extends Omit<LedgerAppendOptions<JsonValue>, 'operation' | 'records'> {
  proposal: Record<string, unknown>;
  proposalPublicKey: string;
  expectedAuthorityDigest: string;
  now?: Date;
}

export function appendAssessmentProposal(options: AssessmentProposalAppendOptions): FindingLedgerReceipt {
  const verified = verifyAssessmentProposal(options.proposal, {
    publicKey: options.proposalPublicKey,
    expectedAuthorityDigest: options.expectedAuthorityDigest,
    now: options.now,
  });
  if (!verified.valid) throw new Error(`ASSESSMENT_PROPOSAL_REJECTED: ${verified.rejection}`);
  assertText(options.proposal.proposalId, 'proposal.proposalId');
  return appendFindingLedger({
    ...options,
    operation: 'append_assessment_proposal',
    records: [{
      recordType: 'assessment_proposal',
      payload: options.proposal as JsonValue,
      uniqueBindingKey: `assessment-proposal:${options.proposal.proposalId}`,
    }],
  });
}

type ManifestedAppendOptions = Omit<LedgerAppendOptions<JsonValue>, 'operation' | 'records'> & {
  record: Record<string, unknown>;
  manifest: Record<string, unknown>;
};

function containsReference(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsReference(item, expected));
  if (value && typeof value === 'object') return Object.values(value).some((item) => containsReference(item, expected));
  return false;
}

function appendManifested(
  options: ManifestedAppendOptions,
  operation: 'append_mandatory_repair' | 'append_deferral_expiry_policy',
  recordType: 'mandatory_repair' | 'deferral_expiry_policy',
  semanticId: string,
): FindingLedgerReceipt {
  if (!containsReference(options.manifest, semanticId)) {
    throw new Error(`MANIFEST_REFERENCE_MISSING: ${semanticId}`);
  }
  return appendFindingLedger({
    ...options,
    operation,
    records: [
      { recordType, payload: options.record as JsonValue, uniqueBindingKey: `${recordType}:${semanticId}` },
      { recordType: 'manifest', payload: options.manifest as JsonValue, uniqueBindingKey: `manifest:${recordType}:${semanticId}` },
    ],
  });
}

export function classifyMandatoryRepair(options: ManifestedAppendOptions): FindingLedgerReceipt {
  const id = options.record.mandatoryRepairId;
  assertText(id, 'record.mandatoryRepairId');
  if (options.record.state !== 'required') throw new Error('mandatory repair classification must have state=required');
  return appendManifested(options, 'append_mandatory_repair', 'mandatory_repair', id);
}
export function closeMandatoryRepair(options: ManifestedAppendOptions): FindingLedgerReceipt {
  const id = options.record.mandatoryRepairId;
  assertText(id, 'record.mandatoryRepairId');
  if (options.record.state !== 'closure_proven') throw new Error('mandatory repair closure must have state=closure_proven');
  return appendManifested(options, 'append_mandatory_repair', 'mandatory_repair', id);
}
export function appendDeferralExpiryPolicy(options: ManifestedAppendOptions): FindingLedgerReceipt {
  const id = options.record.policyDigest;
  assertText(id, 'record.policyDigest');
  return appendManifested(options, 'append_deferral_expiry_policy', 'deferral_expiry_policy', id);
}

export function readFindingLedger<T = JsonValue>(file: string): LedgerEnvelope<T> { return readLedger<T>(file); }
export { canonicalHash, canonicalJson };
