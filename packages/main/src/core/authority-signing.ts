// Authority signing primitives (B-1123 milestones 1-2).
//
// Pure helpers for deterministic canonical JSON digests + Ed25519 sign/verify
// over those canonical bytes. Used by the runner contracts module
// (authority-runner-contracts.ts) and the smoke harness.
//
// Scope: byte-stable serialization + Ed25519 only. No network, no fs.
//
// Trust boundary (authority-client-role.md §PD-2):
//   - Adding these primitives does NOT promote ordinary local/shadow workflow
//     submissions to receipt-backed L2+. Signature-presence is necessary but
//     not sufficient for L2+ classification (see authority-boundary.ts).
//   - The classifier in authority-boundary.ts is the single mechanical truth
//     source for "is this submission L2+?"; signing helpers here only make the
//     envelopeSignature requirement *expressible*, not satisfied.
//
// Determinism contract:
//   - canonicalJsonBytes() must produce identical bytes for two inputs that are
//     "the same" by JSON value (insertion-order independent for object keys).
//   - We reuse authority-contracts.canonicalJson() (proven, already used as
//     digestVerificationContextPack basis).
//   - signCanonical(value, key) ≡ ed25519.sign(privateKey, canonicalJsonBytes(value))
//   - Verification must reject any tamper to value, signature, or key.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { canonicalJson, digestCanonical } from './authority-contracts.js';

/** Base64-encoded Ed25519 raw public key (32 bytes -> 44-char base64 with padding). */
export type PublicKeyBase64 = string;
/** Base64-encoded Ed25519 raw private key seed (32 bytes -> 44-char base64 with padding). */
export type PrivateKeyBase64 = string;
/** Base64-encoded Ed25519 signature (64 bytes -> 88-char base64 with padding). */
export type SignatureBase64 = string;

export interface Ed25519KeyPair {
  publicKey: PublicKeyBase64;
  privateKey: PrivateKeyBase64;
}

/**
 * Return the canonical JSON bytes for `value`.
 *
 * Determinism guarantees (proven by authority-runner-contracts-smoke):
 *  - Two objects with the same key/value pairs in any insertion order produce
 *    byte-identical output.
 *  - undefined fields are omitted (consistent with canonicalJson()).
 *  - Nested objects are recursively sorted by key.
 */
export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}

/** sha256 hex digest over canonical JSON bytes. Re-export for convenience. */
export function canonicalDigest(value: unknown): string {
  return digestCanonical(value);
}

/**
 * Generate a fresh Ed25519 keypair encoded as raw 32-byte base64 seeds.
 *
 * The raw form (not PEM/JWK) is chosen so the wire shape matches the Python
 * authority's actor-key registration payload. Importers reconstruct the Node
 * KeyObject via createPrivateKey({key, format:'der', type:'pkcs8'}) using the
 * standard PKCS#8 envelope assembled in {@link signCanonical}.
 */
export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: exportPublicKeyRaw(publicKey),
    privateKey: exportPrivateKeyRaw(privateKey),
  };
}

const PRIVATE_KEY_DER_PREFIX = Buffer.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
]);

const PUBLIC_KEY_DER_PREFIX = Buffer.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/** Export a Node KeyObject (Ed25519 private) to base64 of its 32-byte raw seed. */
export function exportPrivateKeyRaw(key: ReturnType<typeof generateKeyPairSync>['privateKey']): PrivateKeyBase64 {
  const der = key.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  // PKCS#8 Ed25519 always ends with the 32-byte seed; strip the 16-byte ASN.1 prefix.
  const raw = der.subarray(der.length - 32);
  return raw.toString('base64');
}

/** Export a Node KeyObject (Ed25519 public) to base64 of its 32-byte raw key. */
export function exportPublicKeyRaw(key: ReturnType<typeof generateKeyPairSync>['publicKey']): PublicKeyBase64 {
  const der = key.export({ format: 'der', type: 'spki' }) as Buffer;
  const raw = der.subarray(der.length - 32);
  return raw.toString('base64');
}

function decodeBase64Bytes(input: string, expectedLen: number, label: string): Buffer {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`${label}: expected non-empty base64 string`);
  }
  // Buffer.from(_, 'base64') silently tolerates malformed base64 (skips invalid
  // chars, never throws); the length check below is the actual validity gate.
  const buf = Buffer.from(input, 'base64');
  if (buf.length !== expectedLen) {
    throw new Error(`${label}: expected ${expectedLen} raw bytes, got ${buf.length}`);
  }
  return buf;
}

/** Reconstruct a Node KeyObject from a 32-byte raw Ed25519 private seed. */
export function importPrivateKeyRaw(raw: PrivateKeyBase64) {
  const seed = decodeBase64Bytes(raw, 32, 'importPrivateKeyRaw');
  const der = Buffer.concat([PRIVATE_KEY_DER_PREFIX, seed]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/** Reconstruct a Node KeyObject from a 32-byte raw Ed25519 public key. */
export function importPublicKeyRaw(raw: PublicKeyBase64) {
  const pub = decodeBase64Bytes(raw, 32, 'importPublicKeyRaw');
  const der = Buffer.concat([PUBLIC_KEY_DER_PREFIX, pub]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/**
 * Sign canonical JSON bytes of `value` with the supplied Ed25519 private key
 * (raw base64). The returned signature is base64-encoded.
 *
 * Determinism: identical value+key → identical signature (Ed25519 is
 * deterministic by RFC 8032 §5.1.6).
 */
export function signCanonical(value: unknown, privateKey: PrivateKeyBase64): SignatureBase64 {
  const key = importPrivateKeyRaw(privateKey);
  const signature = sign(null, canonicalJsonBytes(value), key);
  return signature.toString('base64');
}

/**
 * Verify a base64 Ed25519 signature over canonical JSON bytes of `value`.
 *
 * Returns false (does NOT throw) on any tamper / wrong-key / malformed
 * signature path so callers can map verification failure to a controlled
 * outcome instead of an exception.
 */
export function verifyCanonical(
  value: unknown,
  signature: SignatureBase64,
  publicKey: PublicKeyBase64,
): boolean {
  if (typeof signature !== 'string' || signature.length === 0) return false;
  // Buffer.from(_, 'base64') silently tolerates malformed base64; the 64-byte
  // length check below is the actual validity gate for an Ed25519 signature.
  const sigBuf = Buffer.from(signature, 'base64');
  if (sigBuf.length !== 64) return false;
  let key: ReturnType<typeof importPublicKeyRaw>;
  try {
    key = importPublicKeyRaw(publicKey);
  } catch {
    return false;
  }
  try {
    return verify(null, canonicalJsonBytes(value), key, sigBuf);
  } catch {
    return false;
  }
}

/**
 * Strip a `signature` field from any envelope shape so the caller can sign the
 * remaining canonical bytes. The unsigned view is what gets canonicalized for
 * sign/verify; this matches the Python authority's envelope convention.
 */
export function stripSignature<T extends { signature?: unknown }>(envelope: T): Omit<T, 'signature'> {
  const { signature: _signature, ...rest } = envelope;
  return rest;
}

/**
 * Wrap an envelope: compute the signature over the signature-less canonical
 * form and return `{ ...envelope, signature }`. The envelope's own canonical
 * digest (for audit / dedupe) is also returned.
 */
export function signEnvelope<T extends Record<string, unknown>>(
  envelope: T,
  privateKey: PrivateKeyBase64,
): { signed: T & { signature: SignatureBase64 }; digest: string } {
  const unsigned = stripSignature(envelope);
  const signature = signCanonical(unsigned, privateKey);
  const digest = canonicalDigest(unsigned);
  return { signed: { ...envelope, signature } as T & { signature: SignatureBase64 }, digest };
}

/**
 * Verify a signed envelope: check that the signature in `envelope.signature`
 * verifies against `publicKey` over the canonical bytes of the signature-less
 * envelope view. Returns false for any tamper / mismatch / malformed input.
 */
export function verifySignedEnvelope<T extends { signature?: SignatureBase64 | string }>(
  envelope: T,
  publicKey: PublicKeyBase64,
): boolean {
  const sig = envelope.signature;
  if (typeof sig !== 'string' || sig.length === 0) return false;
  const unsigned = stripSignature(envelope);
  return verifyCanonical(unsigned, sig, publicKey);
}
