/** Story 3A/CHK-003: public, schema-neutral Finding ledger transaction helpers. */
import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  canonicalHash, canonicalJson, planAppend, readLedger,
  FINDING_LEDGER_SCHEMA_EPOCH, FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY,
  FINDING_LEDGER_LOCAL_FS_CAPABILITY,
  type AppendLedgerOptions, type AppendPlan, type AppendRequest,
  type JsonValue, type LedgerCommitReceipt, type LedgerEnvelope, type LedgerFence,
  type LedgerRecord,
} from '../core/finding-ledger.js';
import { canonicalDigest, signCanonical, verifyCanonical } from '../core/authority-signing.js';
import type { StoryStore } from '../core/store.js';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import { getSessionIdentity } from '../core/owner-session.js';
import { readOwnerLease } from '../core/story-owner-lease.js';
import { captureMkdirLockFence, withMkdirLock } from '../core/mkdir-lock.js';
import {
  RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY,
  createRuntimeEvidenceBlobStore,
} from '../core/evidence/artifact-store.js';
import {
  RuntimeEvidenceRefusal,
  executeRuntimeEvidence,
  redactEnvironment,
  verifyRuntimeEvidenceCurrent,
  type RuntimeEvidenceReceipt,
  type RuntimeReceiptSigner,
  type RuntimeReceiptTrust,
} from '../core/runtime-evidence-receipt.js';
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

export interface RuntimeReceiptAppendOptions extends Omit<LedgerAppendOptions<JsonValue>, 'operation' | 'records'> {
  runtimeReceipt: RuntimeEvidenceReceipt;
}

/** Persist one runtime receipt through the same signed, fenced CHK-003 transaction. */
export function appendRuntimeReceipt(options: RuntimeReceiptAppendOptions): FindingLedgerReceipt {
  return appendFindingLedger({
    ...options,
    operation: 'append_runtime_receipt',
    records: [{
      recordType: 'runtime_evidence_receipt',
      payload: options.runtimeReceipt as unknown as JsonValue,
      uniqueBindingKey: `runtime-evidence-receipt:${options.runtimeReceipt.receiptId}`,
    }],
  });
}

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

export interface RuntimeEvidenceCommandSpec {
  executable: string;
  args?: string[];
  cwd?: string;
}

export interface FindingRuntimeEvidenceRunArgs {
  storyId: string;
  idempotencyKey: string;
  buildCommand: RuntimeEvidenceCommandSpec;
  executionCommand: RuntimeEvidenceCommandSpec;
  artifactPaths: string[];
  environmentAllowlist?: string[];
  excludedEnvironmentVariables?: string[];
  compilerVersion: string;
  timeoutMs?: number;
  buildInProgress?: boolean;
  storageCapability?: string;
  /** Internal fault-injection seam; intentionally absent from the CLI schema. */
  commitOptions?: AppendLedgerOptions;
}

export interface FindingRuntimeEvidenceVerifyArgs {
  storyId: string;
  runtimeReceiptId: string;
  buildCommand: RuntimeEvidenceCommandSpec;
  executionCommand: RuntimeEvidenceCommandSpec;
  environmentAllowlist?: string[];
  excludedEnvironmentVariables?: string[];
  compilerVersion: string;
  publicKey?: string;
  keyStatus?: 'fresh' | 'unknown' | 'revoked' | 'expired';
  storageCapability?: string;
}

export const RUNTIME_EVIDENCE_PRIVATE_KEY_ENV = 'PROOF_OR_STOP_RUNTIME_EVIDENCE_PRIVATE_KEY';
export const RUNTIME_EVIDENCE_PUBLIC_KEY_ENV = 'PROOF_OR_STOP_RUNTIME_EVIDENCE_PUBLIC_KEY';
export const RUNTIME_EVIDENCE_BUILD_POLICY_DIGEST = canonicalDigest({
  version: 1,
  adapter: 'structured-spawn-sync',
  shell: false,
  executable: 'absolute-realpath-bound',
  environment: 'allowlisted-redacted-complete-child-env',
  artifactStability: ['pre', 'during', 'post'],
  storageCapability: RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY,
});
export const RUNTIME_EVIDENCE_KEY_FRESHNESS_POLICY_DIGEST = canonicalDigest({
  version: 1,
  policy: 'caller-trust-registry-current-key-state-required',
});

function runtimeSignerFromEnvironment(): RuntimeReceiptSigner {
  const privateKey = process.env[RUNTIME_EVIDENCE_PRIVATE_KEY_ENV]?.trim() ?? '';
  const publicKey = process.env[RUNTIME_EVIDENCE_PUBLIC_KEY_ENV]?.trim() ?? '';
  if (!privateKey || !publicKey) {
    throw new RuntimeEvidenceRefusal('unknown_signing_key', 'runtime evidence signing key is not configured');
  }
  const publicKeyDigest = canonicalDigest({ publicKey });
  return {
    privateKey,
    publicKey,
    keyId: `runtime-evidence-${publicKeyDigest.slice(0, 24)}`,
    trustRootDigest: canonicalDigest({ profile: 'runtime-evidence-trust-root-v1', publicKey }),
    keyFreshnessPolicyDigest: RUNTIME_EVIDENCE_KEY_FRESHNESS_POLICY_DIGEST,
    algorithm: 'ed25519',
  };
}

function runtimeTrust(publicKey: string, keyStatus: RuntimeReceiptTrust['keyStatus'] = 'fresh'): RuntimeReceiptTrust {
  const publicKeyDigest = canonicalDigest({ publicKey });
  return {
    publicKey,
    keyId: `runtime-evidence-${publicKeyDigest.slice(0, 24)}`,
    algorithm: 'ed25519',
    trustRootDigest: canonicalDigest({ profile: 'runtime-evidence-trust-root-v1', publicKey }),
    keyFreshnessPolicyDigest: RUNTIME_EVIDENCE_KEY_FRESHNESS_POLICY_DIGEST,
    keyStatus,
  };
}

type ResolvedRuntimeCommand = Required<Pick<RuntimeEvidenceCommandSpec, 'executable' | 'args'>> & {
  /** Canonical receipt value; always project-relative and never a protected physical path. */
  cwd: string;
  /** Execution-only physical cwd; canonicalizeRuntimeCommand deliberately ignores this field. */
  executionCwd: string;
};

function resolveRuntimeCommand(root: string, command: RuntimeEvidenceCommandSpec): ResolvedRuntimeCommand {
  try {
    if (!command || typeof command.executable !== 'string' || !isAbsolute(command.executable)) {
      throw new Error('invalid executable');
    }
    const executable = realpathSync(command.executable);
    if (!statSync(executable).isFile()) throw new Error('invalid executable');
    const rootReal = realpathSync(root);
    const cwd = realpathSync(resolve(rootReal, command.cwd ?? '.'));
    const rel = relative(rootReal, cwd);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel) || !statSync(cwd).isDirectory()) {
      throw new Error('cwd escape');
    }
    return { executable, args: [...(command.args ?? [])], cwd: rel || '.', executionCwd: cwd };
  } catch {
    throw new RuntimeEvidenceRefusal('realpath_policy_violation', 'runtime command violates executable/cwd policy');
  }
}

function runRuntimeCommand(
  command: ReturnType<typeof resolveRuntimeCommand>,
  environment: Record<string, string>,
  timeoutMs: number,
): { stdout: Buffer; stderr: Buffer; exitCode: number } {
  const result = spawnSync(command.executable, command.args, {
    cwd: command.executionCwd,
    env: environment,
    shell: false,
    encoding: 'buffer',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw new Error('runtime-evidence: command_spawn_failed');
  return {
    stdout: Buffer.from(result.stdout ?? Buffer.alloc(0)),
    stderr: Buffer.from(result.stderr ?? Buffer.alloc(0)),
    exitCode: typeof result.status === 'number' ? result.status : 1,
  };
}

function runtimeEnvironment(args: {
  environmentAllowlist?: string[];
  excludedEnvironmentVariables?: string[];
}) {
  return redactEnvironment(process.env, {
    allowlist: args.environmentAllowlist ?? [],
    excludedVariableNames: args.excludedEnvironmentVariables ?? [],
  });
}

function runtimeToolchain(compilerVersion: string): RuntimeEvidenceReceipt['toolchain'] {
  assertText(compilerVersion, 'compilerVersion');
  const value = { compilerVersion: compilerVersion.trim(), runtimeVersion: process.version };
  return { ...value, toolchainDigest: canonicalDigest(value) };
}

function runtimeLedgerTrust(signer: RuntimeReceiptSigner): LedgerReceiptTrust {
  return {
    publicKey: signer.publicKey,
    keyId: signer.keyId,
    algorithm: 'ed25519',
    trustRootDigest: signer.trustRootDigest,
    keyFreshnessPolicyDigest: signer.keyFreshnessPolicyDigest,
  };
}

function runtimeReplay(
  ctx: HandlerContext,
  args: FindingRuntimeEvidenceRunArgs,
  signer: RuntimeReceiptSigner,
  expected: Parameters<typeof verifyRuntimeEvidenceCurrent>[1],
): { runtimeReceipt: RuntimeEvidenceReceipt; runtimeRecordId: string; ledgerReceipt: FindingLedgerReceipt } | null {
  const ledger = ctx.store.readFindingLedger<JsonValue>(args.storyId);
  const commit = ledger.receipts.find((candidate) => candidate.idempotencyKey === args.idempotencyKey) as PersistedCommitReceipt | undefined;
  if (!commit) return null;
  if (!commit.findingLedgerReceipt
    || !verifyFindingLedgerReceipt(commit.findingLedgerReceipt, runtimeLedgerTrust(signer))
    || commit.findingLedgerReceipt.operation !== 'append_runtime_receipt'
    || commit.recordIds.length !== 1) {
    throw new Error('IDEMPOTENCY_CONFLICT: original runtime ledger receipt is invalid');
  }
  const record = ledger.records.find((candidate) => candidate.recordId === commit.recordIds[0]);
  if (!record || record.recordType !== 'runtime_evidence_receipt') {
    throw new Error('IDEMPOTENCY_CONFLICT: original runtime record is missing');
  }
  const runtimeReceipt = record.payload as unknown as RuntimeEvidenceReceipt;
  const verification = verifyRuntimeEvidenceCurrent(runtimeReceipt, expected);
  if (!verification.valid) {
    throw new Error(`IDEMPOTENCY_CONFLICT: original runtime receipt is not current (${verification.refusal})`);
  }
  return { runtimeReceipt, runtimeRecordId: record.recordId, ledgerReceipt: commit.findingLedgerReceipt };
}

function runtimeExpectedState(
  ctx: HandlerContext,
  args: Pick<FindingRuntimeEvidenceRunArgs, 'storyId' | 'buildCommand' | 'executionCommand' | 'environmentAllowlist' | 'excludedEnvironmentVariables' | 'compilerVersion' | 'storageCapability'>,
  trust: RuntimeReceiptTrust,
) {
  const headHash = currentGitHead(ctx.root);
  const sourceMaterialHash = currentMaterialHash(ctx.root, 'HEAD', ctx.root);
  if (!headHash || !sourceMaterialHash) throw new RuntimeEvidenceRefusal('source_stale', 'source identity is unavailable');
  return {
    storyId: args.storyId,
    headHash,
    sourceMaterialHash,
    buildPolicyDigest: RUNTIME_EVIDENCE_BUILD_POLICY_DIGEST,
    buildCommand: resolveRuntimeCommand(ctx.root, args.buildCommand),
    executionCommand: resolveRuntimeCommand(ctx.root, args.executionCommand),
    environment: runtimeEnvironment(args),
    toolchain: runtimeToolchain(args.compilerVersion),
    trust,
    blobStore: createRuntimeEvidenceBlobStore(ctx.root, args.storageCapability),
    artifactRoot: ctx.root,
    producer: 'finding_runtime_evidence_run',
  };
}

export function createFindingLedgerHandlers(ctx: HandlerContext) {
  return {
    finding_runtime_evidence_run(args: FindingRuntimeEvidenceRunArgs) {
      assertText(args.storyId, 'storyId');
      assertText(args.idempotencyKey, 'idempotencyKey');
      assertCwdInWorktree(ctx.store, args.storyId);
      ctx.store.readStory(args.storyId);
      if (args.buildInProgress) throw new RuntimeEvidenceRefusal('build_in_progress');
      const timeoutMs = args.timeoutMs ?? 60_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
        throw new Error('timeoutMs must be an integer from 1 to 300000');
      }
      const signer = runtimeSignerFromEnvironment();
      const trust = runtimeTrust(signer.publicKey);
      const expected = runtimeExpectedState(ctx, args, trust);
      const findingLockDir = ctx.store.storyFilePath(args.storyId, 'findings.lock');
      const replay = withMkdirLock(findingLockDir, () => runtimeReplay(ctx, args, signer, expected), {
        label: 'runtime receipt replay lookup', requireHolderToken: true,
      });
      if (replay) {
        return {
          command: 'finding_runtime_evidence_run', persisted: true, replayed: true,
          runtimeReceiptId: replay.runtimeReceipt.receiptId,
          runtimeRecordId: replay.runtimeRecordId,
          ledgerReceiptId: replay.ledgerReceipt.receiptId,
          publicKey: signer.publicKey,
          receipt: replay.runtimeReceipt,
          ledgerReceipt: replay.ledgerReceipt,
        };
      }

      const buildLockDir = ctx.store.runtimeLockDirPath(args.storyId, 'build', 'runtime-evidence');
      return withMkdirLock(buildLockDir, () => {
        const childEnvironment = { ...expected.environment.values };
        const buildResult = runRuntimeCommand(expected.buildCommand, childEnvironment, timeoutMs);
        if (buildResult.exitCode !== 0) throw new Error('runtime-evidence: build_failed');
        const runtime = executeRuntimeEvidence({
          storyId: args.storyId,
          headHash: expected.headHash,
          sourceMaterialHash: expected.sourceMaterialHash,
          buildPolicyDigest: expected.buildPolicyDigest,
          buildCommand: expected.buildCommand,
          executionCommand: expected.executionCommand,
          environment: expected.environment,
          toolchain: expected.toolchain,
          producer: expected.producer,
          root: ctx.root,
          artifactInputs: args.artifactPaths.map((path) => ({ path, sourceHead: expected.headHash })),
          blobStore: expected.blobStore,
          receiptId: `rer_${canonicalDigest({ storyId: args.storyId, idempotencyKey: args.idempotencyKey }).slice(0, 32)}`,
          run: () => runRuntimeCommand(expected.executionCommand, childEnvironment, timeoutMs),
        }, signer);
        if (currentGitHead(ctx.root) !== expected.headHash
          || currentMaterialHash(ctx.root, 'HEAD', ctx.root) !== expected.sourceMaterialHash) {
          throw new RuntimeEvidenceRefusal('source_stale');
        }

        const identity = getSessionIdentity();
        const ownerLease = readOwnerLease(ctx.store.storyDirPath(args.storyId));
        const persisted = withMkdirLock(findingLockDir, () => {
          const lateReplay = runtimeReplay(ctx, args, signer, expected);
          if (lateReplay) return lateReplay;
          const fence = captureMkdirLockFence(findingLockDir);
          const ledgerReceipt = appendRuntimeReceipt({
            storyId: args.storyId,
            store: ctx.store,
            idempotencyKey: args.idempotencyKey,
            runtimeReceipt: runtime.receipt,
            writerSessionId: identity.sessionId,
            writerLeaseId: ownerLease?.sessionId ?? identity.sessionId,
            writerFenceToken: fence.writerFenceToken,
            fence,
            signer,
            commitOptions: args.commitOptions,
          });
          return {
            runtimeReceipt: runtime.receipt,
            runtimeRecordId: ledgerReceipt.recordIds[0],
            ledgerReceipt,
          };
        }, { label: 'append runtime receipt', requireHolderToken: true });
        return {
          command: 'finding_runtime_evidence_run', persisted: true,
          replayed: persisted.runtimeReceipt !== runtime.receipt,
          runtimeReceiptId: persisted.runtimeReceipt.receiptId,
          runtimeRecordId: persisted.runtimeRecordId,
          ledgerReceiptId: persisted.ledgerReceipt.receiptId,
          publicKey: signer.publicKey,
          receipt: persisted.runtimeReceipt,
          ledgerReceipt: persisted.ledgerReceipt,
        };
      }, {
        label: 'runtime evidence build/execution',
        requireHolderToken: true,
        failFastIfHeld: true,
        heldMessage: 'runtime-evidence: build_in_progress',
      });
    },

    finding_runtime_evidence_verify(args: FindingRuntimeEvidenceVerifyArgs) {
      assertText(args.storyId, 'storyId');
      assertText(args.runtimeReceiptId, 'runtimeReceiptId');
      assertCwdInWorktree(ctx.store, args.storyId);
      ctx.store.readStory(args.storyId);
      const publicKey = args.publicKey?.trim() || process.env[RUNTIME_EVIDENCE_PUBLIC_KEY_ENV]?.trim() || '';
      if (!publicKey) throw new RuntimeEvidenceRefusal('unknown_signing_key');
      const trust = runtimeTrust(publicKey, args.keyStatus ?? 'fresh');
      const expected = runtimeExpectedState(ctx, args, trust);
      const ledger = ctx.store.readFindingLedger<JsonValue>(args.storyId);
      const record = ledger.records.find((candidate) => candidate.recordType === 'runtime_evidence_receipt'
        && (candidate.payload as unknown as RuntimeEvidenceReceipt).receiptId === args.runtimeReceiptId);
      if (!record) throw new Error('runtime-evidence: receipt_not_found');
      const receipt = record.payload as unknown as RuntimeEvidenceReceipt;
      const verification = verifyRuntimeEvidenceCurrent(receipt, expected);
      if (!verification.valid) throw new RuntimeEvidenceRefusal(verification.refusal ?? 'receipt_shape_invalid');
      return {
        command: 'finding_runtime_evidence_verify', verified: true,
        runtimeReceiptId: receipt.receiptId,
        runtimeRecordId: record.recordId,
        receiptHash: receipt.receiptHash,
      };
    },
  };
}

export function readFindingLedger<T = JsonValue>(file: string): LedgerEnvelope<T> { return readLedger<T>(file); }
export { canonicalHash, canonicalJson };
