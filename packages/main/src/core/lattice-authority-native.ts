import { createPublicKey } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalDigest,
  signCanonical,
  stripSignature,
  verifyCanonical,
  importPrivateKeyRaw,
  exportPublicKeyRaw,
  type PrivateKeyBase64,
  type PublicKeyBase64,
} from './authority-signing.js';

export type LatticeAuthorityKeyEncoding = 'hex' | 'base64' | 'auto';

export interface LatticeAuthoritySignedEnvelopeHeader {
  actorId: string;
  role: string;
  nonce: string;
  timestamp: string;
  signature?: string;
}

export interface LatticeAuthorityReceipt {
  receiptId: string;
  kind: string;
  projectId: string;
  storyId?: string;
  actorId: string;
  role: string;
  commandId?: string;
  stateVersion: number;
  policyVersion: string;
  inputDigest: string;
  decisionDigest?: string;
  issuedAt: string;
  serverKeyId: string;
  signature?: string;
}

export interface LatticeAuthorityReceiptVerificationOptions {
  serverPublicKey: string;
  serverPublicKeyEncoding?: LatticeAuthorityKeyEncoding;
  expectedKind?: string;
  expectedProjectId?: string;
  expectedStoryId?: string;
  expectedServerKeyId?: string;
  expectedDecisionDigest?: string;
  maxAgeMs?: number;
  clockSkewMs?: number;
  now?: Date;
}

export interface LatticeAuthorityReceiptVerification {
  provided: true;
  verified: boolean;
  receipt: LatticeAuthorityReceipt;
  reason: string;
}

export const LatticeAuthorityReceiptSchema = z.object({
  receiptId: z.string().min(1),
  kind: z.string().min(1),
  projectId: z.string().min(1),
  storyId: z.string().min(1).optional(),
  actorId: z.string().min(1),
  role: z.string().min(1),
  commandId: z.string().min(1).optional(),
  stateVersion: z.number().int(),
  policyVersion: z.string().min(1),
  inputDigest: z.string().min(1),
  decisionDigest: z.string().min(1).optional(),
  issuedAt: z.string().min(1),
  serverKeyId: z.string().min(1),
  signature: z.string().min(1).optional(),
}).passthrough();

function isHexBytes(value: string, bytes: number): boolean {
  return new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(value);
}

function decodeRawKey(
  value: string,
  expectedBytes: number,
  label: string,
  encoding: LatticeAuthorityKeyEncoding = 'auto',
): Buffer {
  const trimmed = value.trim();
  const useHex = encoding === 'hex' || (encoding === 'auto' && isHexBytes(trimmed, expectedBytes));
  const decoded = useHex ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64');
  if (decoded.length !== expectedBytes) {
    throw new Error(`${label}: expected ${expectedBytes} raw bytes, got ${decoded.length}`);
  }
  return decoded;
}

export function normalizePrivateKeyToBase64(
  privateKey: string,
  encoding: LatticeAuthorityKeyEncoding = 'auto',
): PrivateKeyBase64 {
  return decodeRawKey(privateKey, 32, 'Lattice Authority actor private key', encoding).toString('base64');
}

export function normalizePublicKeyToBase64(
  publicKey: string,
  encoding: LatticeAuthorityKeyEncoding = 'auto',
): PublicKeyBase64 {
  return decodeRawKey(publicKey, 32, 'Lattice Authority server public key', encoding).toString('base64');
}

export function derivePublicKeyHexFromPrivateKey(
  privateKey: string,
  encoding: LatticeAuthorityKeyEncoding = 'auto',
): string {
  const privateKeyBase64 = normalizePrivateKeyToBase64(privateKey, encoding);
  const publicKey = createPublicKey(importPrivateKeyRaw(privateKeyBase64));
  return Buffer.from(exportPublicKeyRaw(publicKey), 'base64').toString('hex');
}

export function signLatticeAuthorityEnvelope<T extends LatticeAuthoritySignedEnvelopeHeader>(
  envelope: T,
  privateKey: string,
  encoding: LatticeAuthorityKeyEncoding = 'auto',
): { signed: T & { signature: string }; digest: string } {
  if (!envelope.actorId || !envelope.role || !envelope.nonce || !envelope.timestamp) {
    throw new Error('Lattice Authority envelope requires actorId, role, nonce, and timestamp');
  }
  const unsigned = stripSignature(envelope);
  const privateKeyBase64 = normalizePrivateKeyToBase64(privateKey, encoding);
  const signatureBase64 = signCanonical(unsigned, privateKeyBase64);
  const signature = Buffer.from(signatureBase64, 'base64').toString('hex');
  return {
    signed: { ...envelope, signature },
    digest: canonicalDigest(unsigned),
  };
}

export function parseLatticeAuthorityReceipt(value: unknown): LatticeAuthorityReceipt {
  const parsed = LatticeAuthorityReceiptSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Lattice Authority receipt is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function verifyLatticeAuthorityReceipt(
  value: unknown,
  options: LatticeAuthorityReceiptVerificationOptions,
): LatticeAuthorityReceiptVerification {
  const receipt = parseLatticeAuthorityReceipt(value);
  const signature = receipt.signature;
  if (!signature || !isHexBytes(signature, 64)) {
    return { provided: true, verified: false, receipt, reason: 'Lattice Authority receipt signature is missing or not 64-byte hex' };
  }
  let serverPublicKey: PublicKeyBase64;
  try {
    serverPublicKey = normalizePublicKeyToBase64(
      options.serverPublicKey,
      options.serverPublicKeyEncoding ?? 'auto',
    );
  } catch (error: any) {
    return { provided: true, verified: false, receipt, reason: error?.message || String(error) };
  }
  const signatureBase64 = Buffer.from(signature, 'hex').toString('base64');
  const signatureVerified = verifyCanonical(stripSignature(receipt), signatureBase64, serverPublicKey);
  if (!signatureVerified) {
    return { provided: true, verified: false, receipt, reason: 'Lattice Authority receipt signature verification failed' };
  }
  const mismatches: string[] = [];
  if (options.expectedKind && receipt.kind !== options.expectedKind) {
    mismatches.push(`kind expected ${options.expectedKind}, got ${receipt.kind}`);
  }
  if (options.expectedProjectId && receipt.projectId !== options.expectedProjectId) {
    mismatches.push(`projectId expected ${options.expectedProjectId}, got ${receipt.projectId}`);
  }
  if (options.expectedStoryId && receipt.storyId !== options.expectedStoryId) {
    mismatches.push(`storyId expected ${options.expectedStoryId}, got ${receipt.storyId ?? '<missing>'}`);
  }
  if (options.expectedServerKeyId && receipt.serverKeyId !== options.expectedServerKeyId) {
    mismatches.push(`serverKeyId expected ${options.expectedServerKeyId}, got ${receipt.serverKeyId}`);
  }
  if (options.expectedDecisionDigest && receipt.decisionDigest !== options.expectedDecisionDigest) {
    mismatches.push(`decisionDigest expected ${options.expectedDecisionDigest}, got ${receipt.decisionDigest ?? '<missing>'}`);
  }
  if ((options.expectedKind === 'gate_decision' || receipt.kind === 'gate_decision') && !receipt.decisionDigest) {
    mismatches.push('gate_decision receipt must include decisionDigest');
  }
  if (mismatches.length > 0) {
    return { provided: true, verified: false, receipt, reason: `Lattice Authority receipt binding mismatch: ${mismatches.join('; ')}` };
  }
  // Freshness is enforced whenever maxAge is configured. A configured-but-invalid
  // maxAge/clockSkew or an unparseable client clock must fail closed with an
  // explicit reason — never silently skip the check (a NaN comparison would
  // otherwise evaluate to false and let a stale/future receipt through).
  const maxAgeMs = options.maxAgeMs;
  const clockSkewMs = options.clockSkewMs ?? 300_000;
  if (maxAgeMs !== undefined) {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      return { provided: true, verified: false, receipt, reason: `Lattice Authority receipt freshness check cannot run: maxAgeMs is invalid (maxAgeMs=${maxAgeMs})` };
    }
    if (!Number.isFinite(clockSkewMs) || clockSkewMs < 0) {
      return { provided: true, verified: false, receipt, reason: `Lattice Authority receipt freshness check cannot run: clockSkewMs is invalid (clockSkewMs=${clockSkewMs})` };
    }
    const now = options.now ?? new Date();
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) {
      return { provided: true, verified: false, receipt, reason: `Lattice Authority receipt freshness check cannot run: client clock is invalid (clientClock=${String(now)})` };
    }
    const clientClock = now.toISOString();
    const issuedMs = Date.parse(receipt.issuedAt);
    if (!Number.isFinite(issuedMs)) {
      return { provided: true, verified: false, receipt, reason: `Lattice Authority receipt issuedAt is not parseable; clientClock=${clientClock} serverIssuedAt=${receipt.issuedAt}` };
    }
    if (issuedMs > nowMs + clockSkewMs) {
      return { provided: true, verified: false, receipt, reason: `Lattice Authority receipt is future-dated; clientClock=${clientClock} serverIssuedAt=${receipt.issuedAt} clockSkewMs=${clockSkewMs}` };
    }
    if (nowMs - issuedMs > maxAgeMs + clockSkewMs) {
      return { provided: true, verified: false, receipt, reason: `Lattice Authority receipt is stale; clientClock=${clientClock} serverIssuedAt=${receipt.issuedAt} maxAgeMs=${maxAgeMs} clockSkewMs=${clockSkewMs}` };
    }
  }
  return {
    provided: true,
    verified: true,
    receipt,
    reason: 'Lattice Authority receipt signature and native bindings verified',
  };
}
