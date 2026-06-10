import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AuthorityReceiptSchema,
  verifyAuthorityReceipt,
  type AuthorityReceipt,
} from './authority-runner-contracts.js';
import {
  canonicalDigest,
  type PublicKeyBase64,
  type SignatureBase64,
} from './authority-signing.js';

export const AUTHORITY_GATE_RECEIPT_PROOF_SCHEMA_VERSION =
  'lattice.authority_gate_receipt_proof.v1' as const;
export const AUTHORITY_GATE_DECISION_SCHEMA_VERSION =
  'lattice.authority_gate_decision.v1' as const;
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
  | 'subject_kind_mismatch'
  | 'subject_id_mismatch'
  | 'subject_digest_missing'
  | 'subject_digest_mismatch'
  | 'input_digest_mismatch'
  | 'decision_digest_mismatch'
  | 'untrusted_authority_key'
  | 'story_mismatch'
  | 'phase_mismatch'
  | 'head_mismatch'
  | 'material_mismatch';

const HEX_32_BYTES = /^[a-f0-9]{64}$/i;
const HEX_64_BYTES = /^[a-f0-9]{128}$/i;

const AuthorityGatePhaseSchema = z.enum(['REVIEW', 'TEST', 'DONE']);
const AuthorityKeyTrustSchema = z.enum(['production', 'local-test', 'contract-test']);

export const AuthorityGateDecisionInputSchema = z.object({
  storyId: z.string().min(1),
  phase: AuthorityGatePhaseSchema,
  headHash: z.string().min(1),
  materialHash: z.string().min(1),
}).passthrough();

export const AuthorityGateDecisionSchema = z.object({
  schemaVersion: z.literal(AUTHORITY_GATE_DECISION_SCHEMA_VERSION),
  decisionId: z.string().min(1),
  storyId: z.string().min(1),
  phase: AuthorityGatePhaseSchema,
  headHash: z.string().min(1),
  materialHash: z.string().min(1),
  inputDigest: z.string().min(1),
  result: z.string().min(1),
  generatedAt: z.string().min(1),
}).passthrough();

export const AuthorityGateReceiptProofSchema = z.object({
  schemaVersion: z.literal(AUTHORITY_GATE_RECEIPT_PROOF_SCHEMA_VERSION),
  proofKind: z.literal(AUTHORITY_GATE_DECISION_SUBJECT_KIND),
  authorityKey: z.object({
    publicKey: z.string().min(1),
    keyId: z.string().min(1).optional(),
    trust: AuthorityKeyTrustSchema.optional(),
  }).passthrough(),
  input: AuthorityGateDecisionInputSchema,
  decision: AuthorityGateDecisionSchema,
  receipt: AuthorityReceiptSchema,
}).passthrough();

export type AuthorityGateDecisionInput = z.infer<typeof AuthorityGateDecisionInputSchema>;
export type AuthorityGateDecision = z.infer<typeof AuthorityGateDecisionSchema>;
export type AuthorityGateReceiptProof = z.infer<typeof AuthorityGateReceiptProofSchema>;

export interface AuthorityGateReceiptExpectedContext {
  storyId?: string;
  phase?: AuthorityGatePhase;
  headHash?: string;
  materialHash?: string;
}

export interface AuthorityGateReceiptTrustContext {
  productionAuthorityKeyDigests?: string[];
  localTestAuthorityKeyDigests?: string[];
}

export interface AuthorityGateReceiptVerifierOptions {
  expected?: AuthorityGateReceiptExpectedContext;
  trust?: AuthorityGateReceiptTrustContext;
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
  authorityKeyTrust?: z.infer<typeof AuthorityKeyTrustSchema> | 'missing';
}

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

function isLocalTestAuthorityMarker(value: string | undefined): boolean {
  return typeof value === 'string' && /\b(local|test|fake|default|contract)\b/i.test(value);
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
  const declaredTrust = proof.authorityKey.trust;
  const localMarker =
    declaredTrust === 'local-test'
    || declaredTrust === 'contract-test'
    || digestAllowed(authorityPublicKeyDigest, trustContext?.localTestAuthorityKeyDigests)
    || isLocalTestAuthorityMarker(proof.authorityKey.keyId)
    || isLocalTestAuthorityMarker(proof.receipt.authorityActorId);
  if (localMarker) {
    return { ok: true, classification: 'server-receipt-local-test', productionReady: false };
  }
  if (
    proof.authorityKey.trust === 'production'
    && digestAllowed(authorityPublicKeyDigest, trustContext?.productionAuthorityKeyDigests)
  ) {
    return { ok: true, classification: 'production-gate-decision', productionReady: true };
  }
  return { ok: false, reason: 'untrusted_authority_key' };
}

export function gateDecisionInputDigest(input: AuthorityGateDecisionInput): string {
  return canonicalDigest(input);
}

export function gateDecisionDigest(decision: AuthorityGateDecision): string {
  return canonicalDigest(decision);
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
  const inputDigest = gateDecisionInputDigest(proof.input);
  const decisionDigest = gateDecisionDigest(proof.decision);
  const partial = {
    receiptId: proof.receipt.receiptId,
    decisionId: proof.decision.decisionId,
    inputDigest,
    decisionDigest,
    authorityKeyId: proof.authorityKey.keyId,
    authorityKeyTrust: proof.authorityKey.trust ?? 'missing',
  } satisfies Partial<AuthorityGateReceiptVerificationResult>;

  if (proof.decision.storyId !== proof.input.storyId || expected.storyId !== undefined && expected.storyId !== proof.input.storyId) {
    return fail('story_mismatch', partial);
  }
  if (proof.decision.phase !== proof.input.phase || expected.phase !== undefined && expected.phase !== proof.input.phase) {
    return fail('phase_mismatch', partial);
  }
  if (proof.decision.headHash !== proof.input.headHash || expected.headHash !== undefined && expected.headHash !== proof.input.headHash) {
    return fail('head_mismatch', partial);
  }
  if (proof.decision.materialHash !== proof.input.materialHash || expected.materialHash !== undefined && expected.materialHash !== proof.input.materialHash) {
    return fail('material_mismatch', partial);
  }
  if (!digestMatches(proof.decision.inputDigest, inputDigest)) {
    return fail('input_digest_mismatch', partial);
  }

  const normalizedPublicKey = normalizeBase64OrHex(
    proof.authorityKey.publicKey,
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
  const receipt: AuthorityReceipt = {
    ...proof.receipt,
    signature: normalizedSignature.value as SignatureBase64,
  };
  if (!verifyAuthorityReceipt(receipt, normalizedPublicKey.value as PublicKeyBase64)) {
    return fail('receipt_signature_invalid', digestPartial);
  }
  if (receipt.subjectKind !== AUTHORITY_GATE_DECISION_SUBJECT_KIND) {
    return fail('subject_kind_mismatch', digestPartial);
  }
  if (receipt.subjectId !== proof.decision.decisionId) {
    return fail('subject_id_mismatch', digestPartial);
  }
  if (typeof receipt.subjectDigest !== 'string' || receipt.subjectDigest.trim().length === 0) {
    return fail('subject_digest_missing', digestPartial);
  }
  if (!digestMatches(receipt.subjectDigest, decisionDigest)) {
    return fail('decision_digest_mismatch', digestPartial);
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
