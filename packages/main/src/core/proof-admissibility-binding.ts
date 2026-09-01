import { createHash } from 'node:crypto';
import type { AdmissibilityReasonCode } from './proof-admissibility.js';
import { PROOF_BINDING_SCHEMA, PROOF_BINDING_SCHEMA_LEGACY } from './artifact-schema.js';

export const PROOF_BINDING_SCHEMA_VERSION = PROOF_BINDING_SCHEMA;

export interface StrictShapeResult {
  ok: boolean;
  reasons: AdmissibilityReasonCode[];
  details: string[];
}

export interface ProofBindingDigestResult {
  schemaVersion: typeof PROOF_BINDING_SCHEMA_VERSION;
  digest: string;
  payload: Record<string, unknown>;
}

const PROOF_BINDING_READ_SCHEMA_VERSIONS = [
  PROOF_BINDING_SCHEMA_VERSION,
  PROOF_BINDING_SCHEMA_LEGACY,
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function containsNull(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.some(containsNull);
  if (isPlainObject(value)) return Object.values(value).some(containsNull);
  return false;
}

export function strictProofShape(
  value: unknown,
  requiredFields: readonly string[],
  allowedFields: readonly string[],
): StrictShapeResult {
  const reasons: AdmissibilityReasonCode[] = [];
  const details: string[] = [];
  if (!isPlainObject(value)) {
    return { ok: false, reasons: ['bad_shape'], details: ['payload must be an object'] };
  }
  const allowed = new Set(allowedFields);
  for (const field of requiredFields) {
    if (!Object.prototype.hasOwnProperty.call(value, field) || value[field] === undefined || value[field] === null) {
      if (!reasons.includes('missing_required_field')) reasons.push('missing_required_field');
      details.push(`missing required field: ${field}`);
    }
  }
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      if (!reasons.includes('unexpected_field')) reasons.push('unexpected_field');
      details.push(`unexpected field: ${field}`);
    }
  }
  if (containsNull(value)) {
    if (!reasons.includes('bad_shape')) reasons.push('bad_shape');
    details.push('null values are not accepted in strict proof payloads');
  }
  return { ok: reasons.length === 0, reasons, details };
}

export function buildProofBindingDigestPayload(
  payload: Record<string, unknown>,
): ProofBindingDigestResult {
  const digest = digestProofBindingPayload(payload, [PROOF_BINDING_SCHEMA_VERSION]);
  return {
    schemaVersion: PROOF_BINDING_SCHEMA_VERSION,
    digest: `sha256:${digest}`,
    payload,
  };
}

function digestProofBindingPayload(
  payload: Record<string, unknown>,
  acceptedSchemaVersions: readonly string[],
): string {
  const strict = strictProofShape(payload, [
    'schemaVersion',
    'artifactKind',
    'claim',
    'storyId',
    'headHash',
    'materialHash',
    'verdict',
    'reason',
  ], [
    'schemaVersion',
    'verifierVersion',
    'artifactKind',
    'claim',
    'storyId',
    'headHash',
    'materialHash',
    'storyFilesHash',
    'targetPhase',
    'verdict',
    'reason',
    'producerId',
    'signatureDigest',
  ]);
  if (!strict.ok) {
    throw new Error(`proof binding payload shape invalid: ${strict.details.join('; ')}`);
  }
  if (!acceptedSchemaVersions.includes(payload.schemaVersion as string)) {
    throw new Error(`unsupported proof binding schemaVersion: ${String(payload.schemaVersion)}`);
  }
  return createHash('sha256').update(stableJson(payload), 'utf8').digest('hex');
}

export function verifyProofBindingDigest(
  payload: Record<string, unknown>,
  expectedDigest: string,
): StrictShapeResult {
  try {
    const actual = `sha256:${digestProofBindingPayload(payload, PROOF_BINDING_READ_SCHEMA_VERSIONS)}`;
    if (actual !== expectedDigest) {
      return { ok: false, reasons: ['digest_mismatch'], details: [`expected ${expectedDigest}, got ${actual}`] };
    }
    return { ok: true, reasons: [], details: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason: AdmissibilityReasonCode = /schemaVersion/.test(message)
      ? 'unsupported_schema_version'
      : /unexpected field/.test(message)
        ? 'unexpected_field'
        : /missing required/.test(message)
          ? 'missing_required_field'
          : 'bad_shape';
    return { ok: false, reasons: [reason], details: [message] };
  }
}
