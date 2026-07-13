import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeMilestoneLedgerHash,
  computeParentLedgerRollupHash,
  computeSlicePlanHash,
} from './proofstory.js';
import type {
  MilestoneLedgerData,
  ProofStoryParentLedgerRollupData,
  ProofStorySlicePlanData,
  ScopeContractAcknowledgement,
  ScopeContractData,
} from './types.js';
import type { StoryStore } from './store.js';
import { currentMaterialHash, currentStoryFilesHash } from './evidence-freshness.js';

export type CloseoutArtifactClass = 'scope-defining' | 'closeout-evidence';

export interface CloseoutArtifactPolicy {
  path: string;
  artifactClass: CloseoutArtifactClass;
  canonicalWriters: readonly string[];
}

/**
 * Gate-trusted lifecycle metadata is deliberately smaller than the lifecycle
 * path registry. Recognition as Lattice-owned metadata never grants trust.
 * `milestone-closeout.json` is intentionally absent: B-9188 owns that artifact.
 */
export const CLOSEOUT_ARTIFACT_POLICIES = [
  { path: 'scope-contract.json', artifactClass: 'scope-defining', canonicalWriters: ['scope_contract_set', 'scope_contract_acknowledge'] },
  { path: 'milestone-ledger.json', artifactClass: 'scope-defining', canonicalWriters: ['milestone_ledger_set', 'milestone_ledger_add', 'intent_collision_set'] },
  { path: 'slice-plan.json', artifactClass: 'scope-defining', canonicalWriters: ['slice_plan_set'] },
  { path: 'parent-ledger-rollup.json', artifactClass: 'closeout-evidence', canonicalWriters: ['parent_ledger_rollup_set'] },
  { path: 'evidence/delivery-context-pack.json', artifactClass: 'closeout-evidence', canonicalWriters: ['delivery_context_pack'] },
  { path: 'test-evidence.json', artifactClass: 'closeout-evidence', canonicalWriters: ['validate', 'test_add', 'test_story'] },
  { path: 'done-required-evidence.json', artifactClass: 'closeout-evidence', canonicalWriters: ['done_required_validate'] },
  { path: 'delivery-check.json', artifactClass: 'closeout-evidence', canonicalWriters: ['delivery_check_set', 'delivery_waiver_add'] },
  { path: 'eval-evidence.json', artifactClass: 'closeout-evidence', canonicalWriters: ['evaluate_save'] },
  { path: 'summary.json', artifactClass: 'closeout-evidence', canonicalWriters: ['summary_set'] },
  { path: 'evidence/transcript-diff.md', artifactClass: 'closeout-evidence', canonicalWriters: ['live_smoke_transcript'] },
  { path: 'evidence/live-smoke-transcript.json', artifactClass: 'closeout-evidence', canonicalWriters: ['live_smoke_transcript'] },
] as const satisfies readonly CloseoutArtifactPolicy[];

export function closeoutArtifactPolicyFor(path: string): CloseoutArtifactPolicy | null {
  return CLOSEOUT_ARTIFACT_POLICIES.find((entry) => entry.path === path) ?? null;
}

export function assertCanonicalCloseoutWrite(path: string, writer: string): CloseoutArtifactPolicy {
  const policy = closeoutArtifactPolicyFor(path);
  if (!policy) throw new Error(`untrusted closeout artifact path: ${path}`);
  if (!policy.canonicalWriters.includes(writer)) {
    throw new Error(`non-canonical writer for ${path}: ${writer}`);
  }
  return policy;
}

export function isCanonicalCloseoutEvidenceWrite(path: string, writer: string): boolean {
  try {
    return assertCanonicalCloseoutWrite(path, writer).artifactClass === 'closeout-evidence';
  } catch {
    return false;
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function object(value: unknown, artifact: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${artifact}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, artifact: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${artifact}: ${field} must be a non-empty string`);
  return value;
}

function array(value: unknown, artifact: string, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${artifact}: ${field} must be an array`);
  return value;
}

function stringArray(value: unknown, artifact: string, field: string): string[] {
  return array(value, artifact, field).map((item, index) => text(item, artifact, `${field}[${index}]`));
}

function exactKeys(value: Record<string, unknown>, artifact: string, allowed: readonly string[]): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new Error(`${artifact}: unknown field(s): ${extras.join(', ')}`);
}

export function validateTrustedMilestoneLedger(raw: unknown, expectedStoryId?: string): MilestoneLedgerData {
  const artifact = 'milestone-ledger.json';
  const value = object(raw, artifact);
  exactKeys(value, artifact, ['schemaVersion', 'storyId', 'state', 'ledgerHash', 'milestones', 'createdAt', 'updatedAt', 'acceptedIntentBinding']);
  if (value.schemaVersion !== 'proofstory.milestone_ledger.v1') throw new Error(`${artifact}: invalid schemaVersion`);
  const storyId = text(value.storyId, artifact, 'storyId');
  if (expectedStoryId && storyId !== expectedStoryId) throw new Error(`${artifact}: storyId mismatch`);
  if (value.state !== 'candidate' && value.state !== 'confirmed') throw new Error(`${artifact}: invalid state`);
  if (value.acceptedIntentBinding !== undefined) {
    const binding = object(value.acceptedIntentBinding, artifact);
    exactKeys(binding, artifact, ['intentCollisionId', 'acceptedInterpretationHash', 'acceptedAt']);
    text(binding.intentCollisionId, artifact, 'acceptedIntentBinding.intentCollisionId');
    text(binding.acceptedInterpretationHash, artifact, 'acceptedIntentBinding.acceptedInterpretationHash');
    const acceptedAt = text(binding.acceptedAt, artifact, 'acceptedIntentBinding.acceptedAt');
    if (Number.isNaN(Date.parse(acceptedAt))) throw new Error(`${artifact}: acceptedIntentBinding.acceptedAt must be ISO time`);
  }
  const milestones = array(value.milestones, artifact, 'milestones');
  const ids = new Set<string>();
  for (const [index, rawMilestone] of milestones.entries()) {
    const milestone = object(rawMilestone, artifact);
    exactKeys(milestone, artifact, ['id', 'sourceRequirementId', 'claim', 'doneMeans', 'requiredEvidence', 'checklistRefs', 'verificationIntentRefs', 'parentLedgerId', 'assignedStory', 'status', 'notApplicableDecision']);
    const id = text(milestone.id, artifact, `milestones[${index}].id`);
    if (ids.has(id)) throw new Error(`${artifact}: duplicate milestone id ${id}`);
    ids.add(id);
    for (const field of ['sourceRequirementId', 'claim', 'doneMeans'] as const) text(milestone[field], artifact, `milestones[${index}].${field}`);
    for (const field of ['requiredEvidence', 'checklistRefs', 'verificationIntentRefs'] as const) stringArray(milestone[field], artifact, `milestones[${index}].${field}`);
    if (!['planned', 'covered', 'done', 'not_applicable'].includes(String(milestone.status))) throw new Error(`${artifact}: invalid milestone status`);
  }
  const expected = computeMilestoneLedgerHash(milestones as MilestoneLedgerData['milestones']);
  if (value.ledgerHash !== expected) throw new Error(`${artifact}: ledgerHash mismatch`);
  return raw as MilestoneLedgerData;
}

export function validateTrustedSlicePlan(
  raw: unknown,
  ledger: MilestoneLedgerData,
  expectedStoryId?: string,
): ProofStorySlicePlanData {
  const artifact = 'slice-plan.json';
  const value = object(raw, artifact);
  exactKeys(value, artifact, ['schemaVersion', 'storyId', 'ledgerHash', 'slices', 'planHash', 'createdAt', 'updatedAt']);
  if (value.schemaVersion !== 'proofstory.slice_plan.v1') throw new Error(`${artifact}: invalid schemaVersion`);
  const storyId = text(value.storyId, artifact, 'storyId');
  if (expectedStoryId && storyId !== expectedStoryId) throw new Error(`${artifact}: storyId mismatch`);
  if (value.ledgerHash !== ledger.ledgerHash) throw new Error(`${artifact}: ledgerHash does not bind milestone-ledger.json`);
  const slices = array(value.slices, artifact, 'slices');
  const ledgerIds = new Set(ledger.milestones.map((milestone) => milestone.id));
  const covered = new Set<string>();
  const sliceIds = new Set<string>();
  for (const [index, rawSlice] of slices.entries()) {
    const slice = object(rawSlice, artifact);
    exactKeys(slice, artifact, ['id', 'milestoneIds', 'reason', 'assignedStory']);
    const id = text(slice.id, artifact, `slices[${index}].id`);
    if (sliceIds.has(id)) throw new Error(`${artifact}: duplicate slice id ${id}`);
    sliceIds.add(id);
    text(slice.reason, artifact, `slices[${index}].reason`);
    const milestoneIds = stringArray(slice.milestoneIds, artifact, `slices[${index}].milestoneIds`);
    if (!milestoneIds.length) throw new Error(`${artifact}: slices[${index}].milestoneIds must not be empty`);
    for (const milestoneId of milestoneIds) {
      if (!ledgerIds.has(milestoneId)) throw new Error(`${artifact}: unknown milestone ${milestoneId}`);
      if (covered.has(milestoneId)) throw new Error(`${artifact}: duplicate milestone coverage ${milestoneId}`);
      covered.add(milestoneId);
    }
  }
  if (covered.size !== ledgerIds.size) throw new Error(`${artifact}: slices must cover every ledger milestone`);
  const ledgerHash = text(ledger.ledgerHash, artifact, 'ledgerHash');
  const expected = computeSlicePlanHash(ledgerHash, slices as ProofStorySlicePlanData['slices']);
  if (value.planHash !== expected) throw new Error(`${artifact}: planHash mismatch`);
  return raw as ProofStorySlicePlanData;
}

export function validateTrustedParentLedgerRollup(
  raw: unknown,
  ledger: MilestoneLedgerData,
  slicePlan: ProofStorySlicePlanData | null,
  expectedStoryId?: string,
): ProofStoryParentLedgerRollupData {
  const artifact = 'parent-ledger-rollup.json';
  const value = object(raw, artifact);
  exactKeys(value, artifact, ['schemaVersion', 'storyId', 'ledgerHash', 'slicePlanHash', 'children', 'rollupHash', 'createdAt', 'updatedAt']);
  if (value.schemaVersion !== 'proofstory.parent_ledger_rollup.v1') throw new Error(`${artifact}: invalid schemaVersion`);
  const storyId = text(value.storyId, artifact, 'storyId');
  if (expectedStoryId && storyId !== expectedStoryId) throw new Error(`${artifact}: storyId mismatch`);
  if (value.ledgerHash !== ledger.ledgerHash) throw new Error(`${artifact}: ledgerHash does not bind milestone-ledger.json`);
  if ((value.slicePlanHash ?? undefined) !== slicePlan?.planHash) throw new Error(`${artifact}: slicePlanHash mismatch`);
  const children = array(value.children, artifact, 'children');
  const childIds = new Set<string>();
  for (const [index, rawChild] of children.entries()) {
    const child = object(rawChild, artifact);
    exactKeys(child, artifact, ['storyId', 'milestoneIds', 'status', 'evidenceRefs']);
    const childStoryId = text(child.storyId, artifact, `children[${index}].storyId`);
    if (childIds.has(childStoryId)) throw new Error(`${artifact}: duplicate child storyId ${childStoryId}`);
    childIds.add(childStoryId);
    stringArray(child.milestoneIds, artifact, `children[${index}].milestoneIds`);
    stringArray(child.evidenceRefs, artifact, `children[${index}].evidenceRefs`);
    if (!['planned', 'covered', 'done'].includes(String(child.status))) throw new Error(`${artifact}: invalid child status`);
  }
  const ledgerHash = text(ledger.ledgerHash, artifact, 'ledgerHash');
  const expected = computeParentLedgerRollupHash(ledgerHash, slicePlan?.planHash, children as ProofStoryParentLedgerRollupData['children']);
  if (value.rollupHash !== expected) throw new Error(`${artifact}: rollupHash mismatch`);
  return raw as ProofStoryParentLedgerRollupData;
}

export function readTrustedProofStoryScopeArtifacts(store: StoryStore, storyId: string): {
  ledger: MilestoneLedgerData | null;
  slicePlan: ProofStorySlicePlanData | null;
  parentRollup: ProofStoryParentLedgerRollupData | null;
} {
  const rawLedger = store.readMilestoneLedger(storyId);
  if (!rawLedger) {
    if (store.readProofStorySlicePlan(storyId) || store.readProofStoryParentLedgerRollup(storyId)) {
      throw new Error('milestone-ledger.json: required by trusted slice/rollup artifact');
    }
    return { ledger: null, slicePlan: null, parentRollup: null };
  }
  const ledger = validateTrustedMilestoneLedger(rawLedger, storyId);
  const rawPlan = store.readProofStorySlicePlan(storyId);
  const slicePlan = rawPlan ? validateTrustedSlicePlan(rawPlan, ledger, storyId) : null;
  const rawRollup = store.readProofStoryParentLedgerRollup(storyId);
  const parentRollup = rawRollup ? validateTrustedParentLedgerRollup(rawRollup, ledger, slicePlan, storyId) : null;
  return { ledger, slicePlan, parentRollup };
}

export interface PersistedDeliveryContextPack {
  storyId: string;
  generatedFor: 'delivery-review';
  diff: { changedFiles: string[]; summary: string };
  docsPromises: Array<{ source: 'plan.md' | 'userSees'; promise: string }>;
  realMachineTests: { transcriptDiff: boolean; testFiles: string[]; evidenceCommands: string[] };
  candidateRouting: unknown;
  validation: unknown;
  reviewRound: string | null;
  deliveryCheck: { status: string; ref: Record<string, unknown> | null };
  waiver: { status: 'surfaced' | 'none' };
  isSigner: false;
  claims: { authorityDone: false; fullAuthorityDone: false; productionDone: false };
}

export function validatePersistedDeliveryContextPack(raw: unknown, expectedStoryId?: string): PersistedDeliveryContextPack {
  const artifact = 'evidence/delivery-context-pack.json';
  const value = object(raw, artifact);
  exactKeys(value, artifact, ['storyId', 'generatedFor', 'diff', 'docsPromises', 'realMachineTests', 'candidateRouting', 'validation', 'reviewRound', 'deliveryCheck', 'waiver', 'isSigner', 'claims']);
  const storyId = text(value.storyId, artifact, 'storyId');
  if (expectedStoryId && storyId !== expectedStoryId) throw new Error(`${artifact}: storyId mismatch`);
  if (value.generatedFor !== 'delivery-review' || value.isSigner !== false) throw new Error(`${artifact}: invalid producer authority shape`);
  const claims = object(value.claims, artifact);
  if (claims.authorityDone !== false || claims.fullAuthorityDone !== false || claims.productionDone !== false) {
    throw new Error(`${artifact}: authority claims must all be false`);
  }
  const diff = object(value.diff, artifact);
  exactKeys(diff, artifact, ['changedFiles', 'summary']);
  array(diff.changedFiles, artifact, 'diff.changedFiles');
  if (typeof diff.summary !== 'string') throw new Error(`${artifact}: diff.summary must be a string`);
  for (const [index, rawPromise] of array(value.docsPromises, artifact, 'docsPromises').entries()) {
    const promise = object(rawPromise, artifact);
    exactKeys(promise, artifact, ['source', 'promise']);
    if (promise.source !== 'plan.md' && promise.source !== 'userSees') throw new Error(`${artifact}: docsPromises[${index}].source is invalid`);
    text(promise.promise, artifact, `docsPromises[${index}].promise`);
  }
  const tests = object(value.realMachineTests, artifact);
  exactKeys(tests, artifact, ['transcriptDiff', 'testFiles', 'evidenceCommands']);
  if (typeof tests.transcriptDiff !== 'boolean') throw new Error(`${artifact}: realMachineTests.transcriptDiff must be boolean`);
  array(tests.testFiles, artifact, 'realMachineTests.testFiles');
  array(tests.evidenceCommands, artifact, 'realMachineTests.evidenceCommands');
  if (value.reviewRound !== null && typeof value.reviewRound !== 'string') throw new Error(`${artifact}: reviewRound must be string or null`);
  const deliveryCheck = object(value.deliveryCheck, artifact);
  exactKeys(deliveryCheck, artifact, ['status', 'ref']);
  if (!['present', 'missing', 'stale', 'blocking', 'unknown'].includes(String(deliveryCheck.status))) throw new Error(`${artifact}: deliveryCheck.status is invalid`);
  const waiver = object(value.waiver, artifact);
  exactKeys(waiver, artifact, ['status']);
  if (waiver.status !== 'surfaced' && waiver.status !== 'none') throw new Error(`${artifact}: waiver.status is invalid`);
  return raw as PersistedDeliveryContextPack;
}

function normalizedAcknowledgements(acks: readonly ScopeContractAcknowledgement[]): unknown[] {
  return acks.map((ack) => ({
    actor: ack.actor,
    reason: ack.reason,
    timestamp: ack.timestamp,
    paths: [...ack.paths].sort(),
    hunkDigest: ack.hunkDigest ?? null,
    hunkDigests: [...(ack.hunkDigests ?? [])].sort(),
    anchors: [...(ack.anchors ?? [])].sort(),
    assuranceLabel: (ack as ScopeContractAcknowledgement & { assuranceLabel?: string }).assuranceLabel ?? null,
    phase: (ack as ScopeContractAcknowledgement & { phase?: string }).phase ?? null,
    headHash: (ack as ScopeContractAcknowledgement & { headHash?: string }).headHash ?? null,
    materialHash: (ack as ScopeContractAcknowledgement & { materialHash?: string }).materialHash ?? null,
  }));
}

export function computeCompositeScopeDigest(args: {
  contract: ScopeContractData;
  ledger: MilestoneLedgerData;
  slicePlan?: ProofStorySlicePlanData | null;
}): string {
  const ledger = validateTrustedMilestoneLedger(args.ledger, args.contract.storyId);
  const slicePlan = args.slicePlan ? validateTrustedSlicePlan(args.slicePlan, ledger, args.contract.storyId) : null;
  return digest({
    scope: {
      mode: args.contract.mode,
      allowedModify: [...args.contract.allowedModify].sort(),
      allowedCreate: [...args.contract.allowedCreate].sort(),
      allowedTest: [...args.contract.allowedTest].sort(),
      protectedFiles: [...args.contract.protectedFiles].sort(),
      explicitExcludes: [...args.contract.explicitExcludes].sort(),
      fileRules: args.contract.fileRules ?? [],
      protectedAnchors: args.contract.protectedAnchors ?? [],
      acknowledgements: normalizedAcknowledgements(args.contract.acknowledgements),
    },
    milestoneLedger: {
      ledgerHash: ledger.ledgerHash,
      state: ledger.state,
      acceptedIntentBinding: ledger.acceptedIntentBinding ?? null,
    },
    slicePlanHash: slicePlan?.planHash ?? null,
  });
}

export interface MetadataOnlyReviewRetentionInput {
  materialUnchanged: boolean;
  storedCompositeScopeDigest?: string;
  currentCompositeScopeDigest?: string;
  changedArtifacts: Array<{ path: string; writer: string; valid: boolean }>;
  storedReviewRound: string;
  currentReviewRound: string;
}

export function evaluateMetadataOnlyReviewRetention(input: MetadataOnlyReviewRetentionInput): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!input.materialUnchanged) reasons.push('product/material diff changed');
  if (!input.storedCompositeScopeDigest || !input.currentCompositeScopeDigest) reasons.push('composite scope digest missing');
  else if (input.storedCompositeScopeDigest !== input.currentCompositeScopeDigest) reasons.push('composite scope digest changed');
  if (input.storedReviewRound !== input.currentReviewRound) reasons.push('review round changed');
  for (const artifact of input.changedArtifacts) {
    const policy = closeoutArtifactPolicyFor(artifact.path);
    if (!policy) reasons.push(`untrusted closeout artifact path: ${artifact.path}`);
    else if (policy.artifactClass !== 'closeout-evidence') reasons.push(`scope-defining artifact changed: ${artifact.path}`);
    else if (!policy.canonicalWriters.includes(artifact.writer)) reasons.push(`non-canonical writer for ${artifact.path}: ${artifact.writer}`);
    if (!artifact.valid) reasons.push(`invalid closeout artifact: ${artifact.path}`);
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export const CLOSEOUT_WRITE_RECEIPTS_PATH = 'closeout-write-receipts.jsonl';
export const CLOSEOUT_WRITE_RECEIPT_SCHEMA = 'lattice.closeout_write_receipt.v1' as const;
const CLOSEOUT_WRITE_RECEIPT_SALT = 'lattice-closeout-write-receipt-v1';

export interface CloseoutWriteReceipt {
  schemaVersion: typeof CLOSEOUT_WRITE_RECEIPT_SCHEMA;
  storyId: string;
  artifactPath: string;
  writerCommand: string;
  artifactDigest: string;
  timestamp: string;
  phase: string;
  headHash: string;
  materialHash: string;
  storyFilesHash: string;
  receiptHash: string;
}

function receiptPayload(receipt: Omit<CloseoutWriteReceipt, 'receiptHash'>): unknown {
  return { ...receipt, salt: CLOSEOUT_WRITE_RECEIPT_SALT };
}

export function signCloseoutWriteReceipt(receipt: Omit<CloseoutWriteReceipt, 'receiptHash'>): string {
  return digest(receiptPayload(receipt));
}

export function rawArtifactDigest(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function buildCloseoutWriteReceipt(input: Omit<CloseoutWriteReceipt, 'schemaVersion' | 'timestamp' | 'receiptHash'> & { timestamp?: string }): CloseoutWriteReceipt {
  assertCanonicalCloseoutWrite(input.artifactPath, input.writerCommand);
  const unsigned = {
    schemaVersion: CLOSEOUT_WRITE_RECEIPT_SCHEMA,
    storyId: input.storyId,
    artifactPath: input.artifactPath,
    writerCommand: input.writerCommand,
    artifactDigest: input.artifactDigest,
    timestamp: input.timestamp ?? new Date().toISOString(),
    phase: input.phase,
    headHash: input.headHash,
    materialHash: input.materialHash,
    storyFilesHash: input.storyFilesHash,
  };
  for (const [field, value] of Object.entries(unsigned)) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`closeout-write-receipts.jsonl: ${field} must be non-empty`);
  }
  return { ...unsigned, receiptHash: signCloseoutWriteReceipt(unsigned) };
}

export function appendCloseoutWriteReceipt(storyDir: string, receipt: CloseoutWriteReceipt): void {
  appendFileSync(join(storyDir, CLOSEOUT_WRITE_RECEIPTS_PATH), `${JSON.stringify(receipt)}\n`, 'utf8');
}

export function readCloseoutWriteReceipts(storyDir: string): CloseoutWriteReceipt[] {
  const path = join(storyDir, CLOSEOUT_WRITE_RECEIPTS_PATH);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as CloseoutWriteReceipt; }
    catch { throw new Error(`closeout-write-receipts.jsonl: malformed line ${index + 1}`); }
  });
}

export function verifyCloseoutWriteReceipt(receipt: CloseoutWriteReceipt, expected: {
  storyId: string;
  artifactPath: string;
  artifactBytes: string | Buffer;
  projectRoot?: string;
  metadataRoot?: string;
}): { ok: boolean; reason?: string } {
  if (!receipt || receipt.schemaVersion !== CLOSEOUT_WRITE_RECEIPT_SCHEMA) return { ok: false, reason: 'invalid receipt schema' };
  if (receipt.storyId !== expected.storyId || receipt.artifactPath !== expected.artifactPath) return { ok: false, reason: 'receipt story/path mismatch' };
  try { assertCanonicalCloseoutWrite(receipt.artifactPath, receipt.writerCommand); }
  catch (error) { return { ok: false, reason: String((error as Error).message) }; }
  const { receiptHash, ...unsigned } = receipt;
  if (!receiptHash || receiptHash !== signCloseoutWriteReceipt(unsigned)) return { ok: false, reason: 'receipt integrity hash mismatch' };
  if (receipt.artifactDigest !== rawArtifactDigest(expected.artifactBytes)) return { ok: false, reason: 'receipt artifact digest mismatch' };
  for (const field of ['timestamp', 'phase', 'headHash', 'materialHash', 'storyFilesHash'] as const) {
    if (!receipt[field]?.trim()) return { ok: false, reason: `receipt ${field} missing` };
  }
  if (Number.isNaN(Date.parse(receipt.timestamp))) return { ok: false, reason: 'receipt timestamp is invalid' };
  if (expected.projectRoot) {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', receipt.headHash, 'HEAD'], {
        cwd: expected.projectRoot,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      return { ok: false, reason: 'receipt headHash is not an ancestor of current HEAD' };
    }
    const metadataRoot = expected.metadataRoot ?? expected.projectRoot;
    if (currentMaterialHash(expected.projectRoot, receipt.headHash, metadataRoot) !== receipt.materialHash) {
      return { ok: false, reason: 'receipt materialHash is incoherent with headHash' };
    }
    if (currentStoryFilesHash(expected.projectRoot, receipt.headHash, metadataRoot) !== receipt.storyFilesHash) {
      return { ok: false, reason: 'receipt storyFilesHash is incoherent with headHash' };
    }
  }
  return { ok: true };
}

export function latestValidCloseoutReceipt(
  storyDir: string,
  storyId: string,
  artifactPath: string,
  provenance?: { projectRoot: string; metadataRoot?: string },
): CloseoutWriteReceipt | null {
  const bytesPath = join(storyDir, artifactPath);
  if (!existsSync(bytesPath)) return null;
  const bytes = readFileSync(bytesPath);
  const receipts = readCloseoutWriteReceipts(storyDir).filter((receipt) => receipt.artifactPath === artifactPath).reverse();
  return receipts.find((receipt) => verifyCloseoutWriteReceipt(receipt, {
    storyId,
    artifactPath,
    artifactBytes: bytes,
    ...provenance,
  }).ok) ?? null;
}

export function validateCurrentCloseoutArtifact(
  store: StoryStore,
  storyId: string,
  artifactPath: string,
  projectRoot?: string,
  metadataRoot?: string,
): { valid: boolean; reason?: string } {
  const policy = closeoutArtifactPolicyFor(artifactPath);
  if (!policy || policy.artifactClass !== 'closeout-evidence') return { valid: false, reason: `untrusted closeout artifact path: ${artifactPath}` };
  const storyDir = store.storyDirPath(storyId);
  const absolute = join(storyDir, artifactPath);
  if (!existsSync(absolute)) return { valid: false, reason: `closeout artifact missing: ${artifactPath}` };
  try {
    if (artifactPath === 'parent-ledger-rollup.json') readTrustedProofStoryScopeArtifacts(store, storyId);
    else if (artifactPath === 'evidence/delivery-context-pack.json') validatePersistedDeliveryContextPack(JSON.parse(readFileSync(absolute, 'utf8')), storyId);
    else if (artifactPath.endsWith('.json')) object(JSON.parse(readFileSync(absolute, 'utf8')), artifactPath);
    else if (!readFileSync(absolute).length) throw new Error(`${artifactPath}: empty artifact`);
    const receipt = latestValidCloseoutReceipt(
      storyDir,
      storyId,
      artifactPath,
      projectRoot ? { projectRoot, metadataRoot: metadataRoot ?? projectRoot } : undefined,
    );
    if (!receipt) return { valid: false, reason: `missing or stale canonical receipt: ${artifactPath}` };
    return { valid: true };
  } catch (error) {
    return { valid: false, reason: String((error as Error).message) };
  }
}
