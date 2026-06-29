// Local signed/offline receipt-bundle primitives (B-1123 milestones 1-2).
//
// Pure helpers for deterministic canonical JSON digests + Ed25519 sign/verify
// over those canonical bytes. The retired server runner/client path is
// quarantined; active callers use these helpers for local receipt bundles,
// local quorum digests, and other offline signatures.
//
// Scope: byte-stable serialization + Ed25519 only. No network, no fs.
//
// Trust boundary:
//   - Adding these primitives does NOT promote ordinary local/shadow workflow
//     submissions to receipt-backed L2+. Signature-presence is necessary but
//     not sufficient for L2+ classification (see authority-boundary.ts).
//   - The proof-admissibility classifier is the single mechanical truth
//     source for "is this submission L2+?"; signing helpers here only make the
//     envelopeSignature requirement *expressible*, not satisfied.
//
// Determinism contract:
//   - canonicalJsonBytes() must produce identical bytes for two inputs that are
//     "the same" by JSON value (insertion-order independent for object keys).
//   - Authority wire signing uses Unicode code point key ordering so Node
//     signs the same bytes Python verifies with json.dumps(sort_keys=True).
//   - signCanonical(value, key) ≡ ed25519.sign(privateKey, canonicalJsonBytes(value))
//   - Verification must reject any tamper to value, signature, or key.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

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
 * Determinism guarantees (covered by local receipt-bundle/quorum smokes):
 *  - Two objects with the same key/value pairs in any insertion order produce
 *    byte-identical output.
 *  - undefined fields are omitted (consistent with canonicalJson()).
 *  - Nested objects are recursively sorted by key.
 */
type SigningJsonValue = null | boolean | number | string | SigningJsonValue[] | { [key: string]: SigningJsonValue };

function compareByCodePoint(a: string, b: string): number {
  const aPoints = Array.from(a);
  const bPoints = Array.from(b);
  const max = Math.min(aPoints.length, bPoints.length);
  for (let index = 0; index < max; index += 1) {
    const aPoint = aPoints[index]?.codePointAt(0) ?? 0;
    const bPoint = bPoints[index]?.codePointAt(0) ?? 0;
    if (aPoint !== bPoint) return aPoint - bPoint;
  }
  return aPoints.length - bPoints.length;
}

function normalizeSigningJson(value: unknown): SigningJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.map(item => normalizeSigningJson(item)).filter(item => item !== undefined) as SigningJsonValue[];
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, normalizeSigningJson(item)] as const)
      .filter((entry): entry is readonly [string, SigningJsonValue] => entry[1] !== undefined)
      .sort(([a], [b]) => compareByCodePoint(a, b));
    return Object.fromEntries(entries) as SigningJsonValue;
  }
  return String(value);
}

export function canonicalJsonForSigning(value: unknown): string {
  return JSON.stringify(normalizeSigningJson(value));
}

export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJsonForSigning(value), 'utf8');
}

/** sha256 hex digest over Authority signing canonical JSON bytes. */
export function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJsonForSigning(value)).digest('hex');
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

function isHexBytes(input: string, expectedLen: number): boolean {
  return input.length === expectedLen * 2 && /^[0-9a-fA-F]+$/.test(input);
}

function decodeRawBytes(input: string, expectedLen: number, label: string): Buffer {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`${label}: expected non-empty raw-key string`);
  }
  if (isHexBytes(input, expectedLen)) {
    return Buffer.from(input, 'hex');
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
  const seed = decodeRawBytes(raw, 32, 'importPrivateKeyRaw');
  const der = Buffer.concat([PRIVATE_KEY_DER_PREFIX, seed]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/** Reconstruct a Node KeyObject from a 32-byte raw Ed25519 public key. */
export function importPublicKeyRaw(raw: PublicKeyBase64) {
  const pub = decodeRawBytes(raw, 32, 'importPublicKeyRaw');
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
  const sigBuf = isHexBytes(signature, 64)
    ? Buffer.from(signature, 'hex')
    : Buffer.from(signature, 'base64');
  // Buffer.from(_, 'base64') silently tolerates malformed base64; the 64-byte
  // length check below is the actual validity gate for an Ed25519 signature.
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
