import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  signCanonical,
  verifyCanonical,
  type PrivateKeyBase64,
  type PublicKeyBase64,
  type SignatureBase64,
} from './authority-signing.js';
import { digestCanonicalJson } from './digest.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';

export const NATIVE_REVIEW_INVOCATION_ATTESTATION_SCHEMA =
  'lattice.native_review_invocation_attestation.v1' as const;

export interface NativeReviewBrokerRegistration {
  brokerId: string;
  adapterId: string;
  host: 'codex' | 'claude';
  publicKey: PublicKeyBase64;
}

export interface NativeReviewInvocationClaims {
  schemaVersion: typeof NATIVE_REVIEW_INVOCATION_ATTESTATION_SCHEMA;
  brokerId: string;
  adapterId: string;
  host: 'codex' | 'claude';
  storyId: string;
  agent: string;
  lane: string;
  reviewRunId: string;
  writerSessionId: string;
  dispatchPromptDigest: string;
  dispatchBindingDigest: string;
  hostRenderIdentityDigest: string;
  invocationNonce: string;
  issuedAt: string;
  expiresAt: string;
}

export interface SignedNativeReviewInvocationAttestation extends NativeReviewInvocationClaims {
  signature: SignatureBase64;
}

export type NativeReviewInvocationExpected = Omit<
  NativeReviewInvocationClaims,
  'schemaVersion' | 'brokerId' | 'adapterId' | 'invocationNonce' | 'issuedAt' | 'expiresAt'
>;

export type NativeReviewInvocationVerification =
  | { ok: true; broker: NativeReviewBrokerRegistration; attestationDigest: string }
  | { ok: false; reason: string };

/** Read-only proof that the exact signed invocation was durably burned once. */
export type NativeReviewInvocationConsumptionVerification =
  | { ok: true }
  | { ok: false; reason: string };

function unsignedAttestation(
  attestation: SignedNativeReviewInvocationAttestation,
): NativeReviewInvocationClaims {
  const { signature: _signature, ...claims } = attestation;
  return claims;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/.test(value);
}

function validClaims(claims: NativeReviewInvocationClaims): boolean {
  return claims.schemaVersion === NATIVE_REVIEW_INVOCATION_ATTESTATION_SCHEMA
    && /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(claims.brokerId)
    && /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(claims.adapterId)
    && (claims.host === 'codex' || claims.host === 'claude')
    && nonEmpty(claims.storyId)
    && nonEmpty(claims.agent)
    && nonEmpty(claims.lane)
    && nonEmpty(claims.reviewRunId)
    && nonEmpty(claims.writerSessionId)
    && validDigest(claims.dispatchPromptDigest)
    && validDigest(claims.dispatchBindingDigest)
    && validDigest(claims.hostRenderIdentityDigest)
    && /^[A-Za-z0-9][A-Za-z0-9._-]{15,127}$/.test(claims.invocationNonce)
    && Number.isFinite(Date.parse(claims.issuedAt))
    && Number.isFinite(Date.parse(claims.expiresAt));
}

/**
 * Host-adapter SDK helper. Lattice exposes no CLI issuer and stores no broker
 * private key; only a separately registered host broker can produce a trusted
 * signature. Calling this helper with a self-generated key remains untrusted.
 */
export function signNativeReviewInvocationAttestation(
  claims: NativeReviewInvocationClaims,
  privateKey: PrivateKeyBase64,
): SignedNativeReviewInvocationAttestation {
  return { ...claims, signature: signCanonical(claims, privateKey) };
}

export function verifyNativeReviewInvocationAttestation(args: {
  attestation: SignedNativeReviewInvocationAttestation;
  trustedBrokers: readonly NativeReviewBrokerRegistration[];
  expected: NativeReviewInvocationExpected;
  now?: number;
  requireFresh?: boolean;
}): NativeReviewInvocationVerification {
  const claims = unsignedAttestation(args.attestation);
  if (!validClaims(claims)) return { ok: false, reason: 'native invocation attestation claims are malformed' };
  const matchingBrokers = args.trustedBrokers.filter(candidate =>
    candidate.brokerId === claims.brokerId
    && candidate.adapterId === claims.adapterId
    && candidate.host === claims.host);
  if (matchingBrokers.length !== 1) {
    return { ok: false, reason: 'native invocation attestation issuer is not one uniquely registered host broker' };
  }
  const broker = matchingBrokers[0]!;
  if (!verifyCanonical(claims, args.attestation.signature, broker.publicKey)) {
    return { ok: false, reason: 'native invocation attestation signature is invalid' };
  }
  const now = args.now ?? Date.now();
  const issuedAt = Date.parse(claims.issuedAt);
  const expiresAt = Date.parse(claims.expiresAt);
  if (issuedAt > now + 5_000 || expiresAt <= issuedAt || expiresAt - issuedAt > 120_000
    || ((args.requireFresh ?? true) && expiresAt < now)) {
    return { ok: false, reason: 'native invocation attestation is expired or outside the bounded issuance window' };
  }
  for (const field of [
    'host',
    'storyId',
    'agent',
    'lane',
    'reviewRunId',
    'writerSessionId',
    'dispatchPromptDigest',
    'dispatchBindingDigest',
    'hostRenderIdentityDigest',
  ] as const) {
    if (claims[field] !== args.expected[field]) {
      return { ok: false, reason: `native invocation attestation ${field} does not match the exact review invocation` };
    }
  }
  return {
    ok: true,
    broker,
    attestationDigest: `sha256:${digestCanonicalJson(args.attestation)}`,
  };
}

function consumptionPath(projectRoot: string, attestation: SignedNativeReviewInvocationAttestation): string {
  const canonicalRoot = resolveCanonicalRuntimeProjectRoot(projectRoot);
  return join(
    canonicalRoot,
    PROOF_OR_STOP_DIR,
    'runtime',
    'native-review-invocations',
    attestation.brokerId,
    `${attestation.invocationNonce}.json`,
  );
}

/**
 * Revalidate the durable half of a one-shot broker invocation without changing
 * it. A signature alone is replayable after the one-time consume write is
 * deleted or replaced, so review gates must require this exact broker/nonce/
 * attestation-digest record as well.
 */
export function verifyNativeReviewInvocationAttestationConsumption(args: {
  projectRoot: string;
  attestation: SignedNativeReviewInvocationAttestation;
  attestationDigest: string;
}): NativeReviewInvocationConsumptionVerification {
  let raw: string;
  try {
    raw = readFileSync(consumptionPath(args.projectRoot, args.attestation), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    return { ok: false, reason: `native invocation consumption record is unavailable (${code})` };
  }
  let consumed: unknown;
  try {
    consumed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'native invocation consumption record is malformed' };
  }
  if (!consumed || typeof consumed !== 'object' || Array.isArray(consumed)) {
    return { ok: false, reason: 'native invocation consumption record is malformed' };
  }
  const record = consumed as Record<string, unknown>;
  if (record.schemaVersion !== 'lattice.native_review_invocation_consumption.v1'
    || record.brokerId !== args.attestation.brokerId
    || record.invocationNonce !== args.attestation.invocationNonce
    || record.attestationDigest !== args.attestationDigest
    || typeof record.consumedAt !== 'string'
    || !Number.isFinite(Date.parse(record.consumedAt))) {
    return { ok: false, reason: 'native invocation consumption record does not bind the signed invocation' };
  }
  return { ok: true };
}

/** Verify and atomically burn the broker nonce exactly once. */
export function consumeNativeReviewInvocationAttestation(args: {
  projectRoot: string;
  attestation: SignedNativeReviewInvocationAttestation;
  trustedBrokers: readonly NativeReviewBrokerRegistration[];
  expected: NativeReviewInvocationExpected;
  now?: number;
}): NativeReviewInvocationVerification {
  const verified = verifyNativeReviewInvocationAttestation(args);
  if (!verified.ok) return verified;
  const path = consumptionPath(args.projectRoot, args.attestation);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 'lattice.native_review_invocation_consumption.v1',
      brokerId: args.attestation.brokerId,
      invocationNonce: args.attestation.invocationNonce,
      attestationDigest: verified.attestationDigest,
      consumedAt: new Date(args.now ?? Date.now()).toISOString(),
    })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { ok: false, reason: 'native invocation attestation nonce was already consumed' };
    }
    throw error;
  }
  return verified;
}

/**
 * Read the capability only from a broker-supplied inherited descriptor. Inline
 * environment tokens are deliberately unsupported because they are forgeable
 * and commonly inherited by raw provider children.
 */
export function readNativeReviewInvocationAttestationFromFd(
  env: NodeJS.ProcessEnv = process.env,
): SignedNativeReviewInvocationAttestation | null {
  const rawFd = env.LATTICE_NATIVE_REVIEW_ATTESTATION_FD?.trim();
  if (!rawFd) return null;
  const fd = Number(rawFd);
  if (!Number.isInteger(fd) || fd < 3 || fd > 255) {
    throw new Error('native invocation attestation fd must be an inherited descriptor between 3 and 255');
  }
  const raw = readFileSync(fd, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) {
    throw new Error('native invocation attestation exceeds 64 KiB');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('native invocation attestation fd does not contain JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('native invocation attestation fd does not contain an object');
  }
  return parsed as SignedNativeReviewInvocationAttestation;
}
