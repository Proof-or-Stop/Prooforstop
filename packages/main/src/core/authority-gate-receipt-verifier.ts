import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AuthorityReceiptSchema,
  verifyAuthorityReceipt,
  type AuthorityReceipt,
} from './authority-runner-contracts.js';
import {
  type PublicKeyBase64,
  type SignatureBase64,
} from './authority-signing.js';

export const AUTHORITY_GATE_RECEIPT_PROOF_SCHEMA_VERSION =
  'lattice.authority_gate_receipt_proof.v1' as const;
export const AUTHORITY_GATE_DECISION_SUBJECT_KIND = 'gate_decision' as const;

export type AuthorityGatePhase = 'REVIEW' | 'TEST' | 'DONE';
export type AuthorityGateReceiptClassification =
  | 'production-gate-decision'
  | 'server-receipt-local-test'
  | 'invalid';
export type AuthorityGateReceiptFailureReason =
  | 'malformed_proof'
  | 'missing_authority_public_key'
  | 'authority_public_key_invalid'
  | 'receipt_signature_invalid'
  | 'receipt_kind_mismatch'
  | 'subject_kind_mismatch'
  | 'subject_id_mismatch'
  | 'subject_digest_missing'
  | 'subject_digest_mismatch'
  | 'input_digest_mismatch'
  | 'decision_digest_mismatch'
  | 'decision_verdict_not_pass'
  | 'state_version_missing'
  | 'state_version_mismatch'
  | 'server_key_id_mismatch'
  | 'requested_actor_mismatch'
  | 'untrusted_authority_key'
  | 'story_mismatch'
  | 'phase_mismatch'
  | 'head_mismatch'
  | 'material_mismatch'
  | 'receipt_issued_at_missing'
  | 'receipt_issued_in_future'
  | 'receipt_freshness_expired';

const HEX_32_BYTES = /^[a-f0-9]{64}$/i;
const HEX_64_BYTES = /^[a-f0-9]{128}$/i;
const PHASE_BY_WIRE_VALUE: Record<string, AuthorityGatePhase> = {
  review: 'REVIEW',
  REVIEW: 'REVIEW',
  test: 'TEST',
  TEST: 'TEST',
  done: 'DONE',
  DONE: 'DONE',
};

const RepoSnapshotSchema = z.object({
  headHash: z.string().min(1),
  materialHash: z.string().min(1),
  baseHash: z.string().nullable().optional(),
  treeHash: z.string().nullable().optional(),
  diffHash: z.string().nullable().optional(),
  manifestHash: z.string().nullable().optional(),
  dirty: z.boolean().optional(),
  branchName: z.string().optional(),
}).strict();

export const AuthorityGateDecisionInputSchema = z.object({
  decisionId: z.string().min(1).optional(),
  projectId: z.string().min(1),
  storyId: z.string().min(1),
  targetPhase: z.string().min(1),
  repo: RepoSnapshotSchema,
  policyMode: z.string().min(1).optional(),
  authorityMode: z.string().min(1).optional(),
  evidenceHashes: z.array(z.string()).optional(),
  requestedByActorId: z.string().min(1),
  requestedAt: z.string().min(1).optional(),
}).strict();

export const AuthorityGateDecisionSchema = z.object({
  decisionId: z.string().min(1),
  projectId: z.string().min(1).optional(),
  storyId: z.string().min(1),
  verdict: z.string().min(1),
  targetPhase: z.string().min(1),
  stateVersion: z.number().int().nonnegative().optional(),
  repo: RepoSnapshotSchema.optional(),
  policyMode: z.string().min(1).optional(),
  authorityMode: z.string().min(1).optional(),
  evidenceDigests: z.array(z.string()).optional(),
  producerRunIds: z.array(z.string()).optional(),
  verifierRunIds: z.array(z.string()).optional(),
  runnerSessionIds: z.array(z.string()).optional(),
}).strict();

export const AuthorityGateDecisionDigestPayloadSchema = z.object({
  decision: AuthorityGateDecisionSchema,
  requestedByActorId: z.string().min(1),
}).strict();

export const AuthorityGateReceiptProofSchema = z.object({
  schemaVersion: z.literal(AUTHORITY_GATE_RECEIPT_PROOF_SCHEMA_VERSION),
  proofKind: z.literal(AUTHORITY_GATE_DECISION_SUBJECT_KIND),
  receipt: AuthorityReceiptSchema,
  recordId: z.string().min(1),
  inputPayload: AuthorityGateDecisionInputSchema,
  decisionPayload: AuthorityGateDecisionSchema,
  decisionDigestPayload: AuthorityGateDecisionDigestPayloadSchema,
  requestedByActorId: z.string().min(1),
  serverKeyId: z.string().min(1),
  serverPublicKeyHex: z.string().min(1),
  serverKeyProfile: z.string().min(1),
  serverKeyProductionInert: z.boolean(),
}).strict();

export type AuthorityGateDecisionInput = z.infer<typeof AuthorityGateDecisionInputSchema>;
export type AuthorityGateDecision = z.infer<typeof AuthorityGateDecisionSchema>;
export type AuthorityGateReceiptProof = z.infer<typeof AuthorityGateReceiptProofSchema>;

export interface AuthorityGateReceiptExpectedContext {
  storyId?: string;
  phase?: AuthorityGatePhase | string;
  headHash?: string;
  materialHash?: string;
  stateVersion?: number;
}

export interface AuthorityGateReceiptTrustContext {
  productionAuthorityKeyDigests?: string[];
  localTestAuthorityKeyDigests?: string[];
}

export interface AuthorityGateReceiptVerifierOptions {
  expected?: AuthorityGateReceiptExpectedContext;
  trust?: AuthorityGateReceiptTrustContext;
  now?: string;
  maxReceiptAgeMs?: number;
  allowedClockSkewMs?: number;
}

export interface AuthorityGateReceiptVerificationResult {
  ok: boolean;
  receiptVerified: boolean;
  productionReady: boolean;
  classification: AuthorityGateReceiptClassification;
  failureReason?: AuthorityGateReceiptFailureReason;
  details?: string[];
  receiptId?: string;
  decisionId?: string;
  inputDigest?: string;
  decisionDigest?: string;
  authorityPublicKeyDigest?: string;
  authorityKeyId?: string;
  authorityKeyTrust?: string;
  targetPhase?: AuthorityGatePhase;
  headHash?: string;
  materialHash?: string;
  stateVersion?: number;
  decisionVerdict?: string;
}

type ReceiptWithGateFields = AuthorityReceipt & {
  kind?: string;
  inputDigest?: string;
  decisionDigest?: string;
  stateVersion?: number;
  serverKeyId?: string;
  storyId?: string;
};

function normalizeBase64OrHex(
  value: string | undefined,
  expectedBytes: number,
  label: string,
): { ok: true; value: string; bytes: Buffer } | { ok: false; reason: AuthorityGateReceiptFailureReason; detail: string } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return {
      ok: false,
      reason: label === 'authority public key'
        ? 'missing_authority_public_key'
        : 'receipt_signature_invalid',
      detail: `${label} is missing`,
    };
  }
  const trimmed = value.trim();
  const isExpectedHex =
    (expectedBytes === 32 && HEX_32_BYTES.test(trimmed))
    || (expectedBytes === 64 && HEX_64_BYTES.test(trimmed));
  const bytes = isExpectedHex
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (bytes.length !== expectedBytes) {
    return {
      ok: false,
      reason: label === 'authority public key'
        ? 'authority_public_key_invalid'
        : 'receipt_signature_invalid',
      detail: `${label} must decode to ${expectedBytes} bytes`,
    };
  }
  return { ok: true, value: bytes.toString('base64'), bytes };
}

function sha256Digest(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function digestAllowed(digest: string, allowed: string[] | undefined): boolean {
  if (!allowed || allowed.length === 0) return false;
  const bare = digest.replace(/^sha256:/, '');
  return allowed.some((entry) => {
    const normalized = entry.trim();
    return normalized === digest || normalized === bare;
  });
}

function digestMatches(claimed: string | undefined, digest: string): boolean {
  return claimed === digest || claimed === `sha256:${digest}`;
}

function compareJsonKeyByCodePoint(a: string, b: string): number {
  const aPoints = Array.from(a);
  const bPoints = Array.from(b);
  const max = Math.min(aPoints.length, bPoints.length);
  for (let index = 0; index < max; index += 1) {
    const diff = (aPoints[index]?.codePointAt(0) ?? 0) - (bPoints[index]?.codePointAt(0) ?? 0);
    if (diff !== 0) return diff;
  }
  return aPoints.length - bPoints.length;
}

function normalizePythonDigestJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(normalizePythonDigestJson).filter(item => item !== undefined);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => compareJsonKeyByCodePoint(a, b))) {
      const normalized = normalizePythonDigestJson(item);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }
  return String(value);
}

function pythonModelDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizePythonDigestJson(value)), 'utf8')
    .digest('hex');
}

function normalizeGateRepoDigestInput(repo: AuthorityGateDecisionInput['repo'] | undefined): AuthorityGateDecisionInput['repo'] | undefined {
  if (!repo) return undefined;
  const raw = repo as Record<string, unknown>;
  return {
    ...raw,
    headHash: repo.headHash,
    materialHash: repo.materialHash,
    baseHash: typeof raw.baseHash === 'string' || raw.baseHash === null ? raw.baseHash : null,
    treeHash: typeof raw.treeHash === 'string' || raw.treeHash === null ? raw.treeHash : null,
    diffHash: typeof raw.diffHash === 'string' || raw.diffHash === null ? raw.diffHash : null,
    manifestHash: typeof raw.manifestHash === 'string' || raw.manifestHash === null ? raw.manifestHash : null,
    dirty: typeof raw.dirty === 'boolean' ? raw.dirty : false,
    ...(typeof raw.branchName === 'string' ? { branchName: raw.branchName } : {}),
  };
}

function normalizeGateDecisionForDigest<T extends Record<string, unknown>>(decision: T): T {
  const repo = decision.repo;
  if (!repo || typeof repo !== 'object' || Array.isArray(repo)) return decision;
  return {
    ...decision,
    repo: normalizeGateRepoDigestInput(repo as AuthorityGateDecisionInput['repo']),
  };
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  const normalizedLeft = left && typeof left === 'object' && !Array.isArray(left)
    ? normalizeGateDecisionForDigest(left as Record<string, unknown>)
    : left;
  const normalizedRight = right && typeof right === 'object' && !Array.isArray(right)
    ? normalizeGateDecisionForDigest(right as Record<string, unknown>)
    : right;
  return pythonModelDigest(normalizedLeft) === pythonModelDigest(normalizedRight);
}

function isLocalTestAuthorityMarker(value: string | undefined): boolean {
  return typeof value === 'string' && /\b(local|test|fake|default|contract)\b/i.test(value);
}

export function normalizeAuthorityGatePhase(value: string | undefined): AuthorityGatePhase | undefined {
  return value ? PHASE_BY_WIRE_VALUE[value] : undefined;
}

function fail(
  reason: AuthorityGateReceiptFailureReason,
  partial: Partial<AuthorityGateReceiptVerificationResult> = {},
  detail?: string,
): AuthorityGateReceiptVerificationResult {
  return {
    ok: false,
    receiptVerified: false,
    productionReady: false,
    classification: 'invalid',
    failureReason: reason,
    ...(detail ? { details: [detail] } : {}),
    ...partial,
  };
}

function assertFreshEnough(
  receipt: AuthorityReceipt,
  options: AuthorityGateReceiptVerifierOptions,
): AuthorityGateReceiptFailureReason | undefined {
  if (typeof options.maxReceiptAgeMs !== 'number') return undefined;
  const issuedAtMs = Date.parse(receipt.issuedAt);
  const nowMs = Date.parse(options.now ?? new Date().toISOString());
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(nowMs)) {
    return 'receipt_issued_at_missing';
  }
  const allowedClockSkewMs = options.allowedClockSkewMs ?? 0;
  if (issuedAtMs - nowMs > allowedClockSkewMs) return 'receipt_issued_in_future';
  if (nowMs - issuedAtMs > options.maxReceiptAgeMs + allowedClockSkewMs) {
    return 'receipt_freshness_expired';
  }
  return undefined;
}

function verifiedClassification(
  proof: AuthorityGateReceiptProof,
  authorityPublicKeyDigest: string,
  trustContext: AuthorityGateReceiptTrustContext | undefined,
): {
  ok: true;
  classification: Exclude<AuthorityGateReceiptClassification, 'invalid'>;
  productionReady: boolean;
} | {
  ok: false;
  reason: AuthorityGateReceiptFailureReason;
} {
  const localMarker =
    proof.serverKeyProductionInert
    || proof.serverKeyProfile !== 'configured'
    || digestAllowed(authorityPublicKeyDigest, trustContext?.localTestAuthorityKeyDigests)
    || isLocalTestAuthorityMarker(proof.serverKeyId)
    || isLocalTestAuthorityMarker(proof.receipt.authorityActorId);
  if (localMarker) {
    return { ok: true, classification: 'server-receipt-local-test', productionReady: false };
  }
  if (digestAllowed(authorityPublicKeyDigest, trustContext?.productionAuthorityKeyDigests)) {
    return { ok: true, classification: 'production-gate-decision', productionReady: true };
  }
  return { ok: false, reason: 'untrusted_authority_key' };
}

export function gateDecisionInputDigest(input: AuthorityGateDecisionInput): string {
  return pythonModelDigest({
    ...input,
    repo: normalizeGateRepoDigestInput(input.repo),
  });
}

export function gateDecisionDigest(decisionDigestPayload: z.infer<typeof AuthorityGateDecisionDigestPayloadSchema>): string {
  return pythonModelDigest({
    ...decisionDigestPayload,
    decision: normalizeGateDecisionForDigest(decisionDigestPayload.decision),
  });
}

export function verifyAuthorityGateReceiptProof(
  value: unknown,
  options: AuthorityGateReceiptVerifierOptions = {},
): AuthorityGateReceiptVerificationResult {
  const expected = options.expected ?? {};
  const parsed = AuthorityGateReceiptProofSchema.safeParse(value);
  if (!parsed.success) {
    return fail('malformed_proof', {}, parsed.error.message);
  }
  const proof = parsed.data;
  const targetPhase = normalizeAuthorityGatePhase(proof.inputPayload.targetPhase);
  const decisionPhase = normalizeAuthorityGatePhase(proof.decisionPayload.targetPhase);
  const expectedPhase = normalizeAuthorityGatePhase(expected.phase);
  const inputDigest = gateDecisionInputDigest(proof.inputPayload);
  const decisionDigest = gateDecisionDigest(proof.decisionDigestPayload);
  const receipt = proof.receipt as ReceiptWithGateFields;
  const partial = {
    receiptId: proof.receipt.receiptId,
    decisionId: proof.decisionPayload.decisionId,
    inputDigest,
    decisionDigest,
    authorityKeyId: proof.serverKeyId,
    authorityKeyTrust: proof.serverKeyProfile,
    targetPhase,
    headHash: proof.inputPayload.repo.headHash,
    materialHash: proof.inputPayload.repo.materialHash,
    stateVersion: proof.decisionPayload.stateVersion,
    decisionVerdict: proof.decisionPayload.verdict,
  } satisfies Partial<AuthorityGateReceiptVerificationResult>;

  if (!targetPhase || !decisionPhase || targetPhase !== decisionPhase || (expectedPhase !== undefined && expectedPhase !== targetPhase)) {
    return fail('phase_mismatch', partial);
  }
  if (proof.decisionPayload.storyId !== proof.inputPayload.storyId || expected.storyId !== undefined && expected.storyId !== proof.inputPayload.storyId) {
    return fail('story_mismatch', partial);
  }
  const decisionRepo = proof.decisionPayload.repo;
  if (decisionRepo && decisionRepo.headHash !== proof.inputPayload.repo.headHash || expected.headHash !== undefined && expected.headHash !== proof.inputPayload.repo.headHash) {
    return fail('head_mismatch', partial);
  }
  if (decisionRepo && decisionRepo.materialHash !== proof.inputPayload.repo.materialHash || expected.materialHash !== undefined && expected.materialHash !== proof.inputPayload.repo.materialHash) {
    return fail('material_mismatch', partial);
  }
  if (
    proof.requestedByActorId !== proof.inputPayload.requestedByActorId
    || proof.decisionDigestPayload.requestedByActorId !== proof.requestedByActorId
  ) {
    return fail('requested_actor_mismatch', partial);
  }
  if (!sameCanonicalValue(proof.decisionDigestPayload.decision, proof.decisionPayload)) {
    return fail('decision_digest_mismatch', partial);
  }
  if (proof.decisionPayload.verdict !== 'pass') {
    return fail('decision_verdict_not_pass', partial);
  }
  if (typeof proof.decisionPayload.stateVersion !== 'number' || typeof receipt.stateVersion !== 'number') {
    return fail('state_version_missing', partial);
  }
  if (proof.decisionPayload.stateVersion !== receipt.stateVersion || expected.stateVersion !== undefined && expected.stateVersion !== receipt.stateVersion) {
    return fail('state_version_mismatch', partial);
  }
  if (receipt.kind !== AUTHORITY_GATE_DECISION_SUBJECT_KIND) {
    return fail('receipt_kind_mismatch', partial);
  }
  if (receipt.subjectKind !== AUTHORITY_GATE_DECISION_SUBJECT_KIND) {
    return fail('subject_kind_mismatch', partial);
  }
  if (receipt.subjectId !== proof.decisionPayload.decisionId) {
    return fail('subject_id_mismatch', partial);
  }
  if (receipt.serverKeyId !== proof.serverKeyId) {
    return fail('server_key_id_mismatch', partial);
  }
  if (!digestMatches(receipt.inputDigest, inputDigest)) {
    return fail('input_digest_mismatch', partial);
  }
  if (typeof receipt.subjectDigest !== 'string' || receipt.subjectDigest.trim().length === 0) {
    return fail('subject_digest_missing', partial);
  }
  if (!digestMatches(receipt.subjectDigest, decisionDigest)) {
    return fail('subject_digest_mismatch', partial);
  }
  if (!digestMatches(receipt.decisionDigest, decisionDigest)) {
    return fail('decision_digest_mismatch', partial);
  }
  const freshnessFailure = assertFreshEnough(proof.receipt, options);
  if (freshnessFailure) {
    return fail(freshnessFailure, partial);
  }

  const normalizedPublicKey = normalizeBase64OrHex(
    proof.serverPublicKeyHex,
    32,
    'authority public key',
  );
  if (!normalizedPublicKey.ok) {
    return fail(normalizedPublicKey.reason, partial, normalizedPublicKey.detail);
  }
  const authorityPublicKeyDigest = sha256Digest(normalizedPublicKey.bytes);
  const digestPartial = { ...partial, authorityPublicKeyDigest };
  const normalizedSignature = normalizeBase64OrHex(
    proof.receipt.signature,
    64,
    'receipt signature',
  );
  if (!normalizedSignature.ok) {
    return fail(normalizedSignature.reason, digestPartial, normalizedSignature.detail);
  }
  const receiptForVerification: AuthorityReceipt = {
    ...proof.receipt,
    signature: normalizedSignature.value as SignatureBase64,
  };
  if (!verifyAuthorityReceipt(receiptForVerification, normalizedPublicKey.value as PublicKeyBase64)) {
    return fail('receipt_signature_invalid', digestPartial);
  }

  const classification = verifiedClassification(proof, authorityPublicKeyDigest, options.trust);
  if (!classification.ok) {
    return fail(classification.reason, digestPartial);
  }
  const { ok: _classificationOk, ...classificationFacts } = classification;
  return {
    ok: true,
    receiptVerified: true,
    ...classificationFacts,
    ...digestPartial,
  };
}
