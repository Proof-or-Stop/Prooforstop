import type { AdmissibilityReasonCode } from './proof-admissibility.js';

export const RESERVED_PROOF_METADATA_KEYS = [
  'hostDeclarationDigest',
  'providerAuthorization',
  'receiptVerified',
  'authorityDone',
  'fullAuthorityDone',
  'productionDone',
  'createdVia',
  'source',
  'serverDelegated',
  'server_delegated',
  'serverDelegation',
  'legacyReceipt',
  'legacyReceiptRef',
  'authorityGateDecision',
] as const;

export type ReservedProofMetadataKey = typeof RESERVED_PROOF_METADATA_KEYS[number];
export type MetadataSanitizationMode = 'strip' | 'reject';

export interface MetadataSanitizationIssue {
  path: string;
  key: ReservedProofMetadataKey;
  reason: AdmissibilityReasonCode;
}

export interface MetadataSanitizationResult<T = unknown> {
  ok: boolean;
  sanitized: T;
  issues: MetadataSanitizationIssue[];
}

const RESERVED_KEY_SET = new Set<string>(RESERVED_PROOF_METADATA_KEYS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function joinPath(parent: string, key: string | number): string {
  return parent ? `${parent}.${key}` : String(key);
}

function sanitizeValue(
  value: unknown,
  mode: MetadataSanitizationMode,
  path: string,
  issues: MetadataSanitizationIssue[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeValue(item, mode, joinPath(path, index), issues));
  }
  if (!isPlainObject(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (RESERVED_KEY_SET.has(key)) {
      issues.push({
        path: joinPath(path, key),
        key: key as ReservedProofMetadataKey,
        reason: 'reserved_key_detected',
      });
      if (mode === 'strip') continue;
    }
    out[key] = sanitizeValue(item, mode, joinPath(path, key), issues);
  }
  return out;
}

export function isReservedProofMetadataKey(value: string): value is ReservedProofMetadataKey {
  return RESERVED_KEY_SET.has(value);
}

export function findReservedProofMetadataKeys(value: unknown): MetadataSanitizationIssue[] {
  const issues: MetadataSanitizationIssue[] = [];
  sanitizeValue(value, 'strip', '', issues);
  return issues;
}

export function sanitizeCallerProofMetadata<T>(
  metadata: T,
  options: { mode?: MetadataSanitizationMode } = {},
): MetadataSanitizationResult<T> {
  const issues: MetadataSanitizationIssue[] = [];
  const sanitized = sanitizeValue(metadata, options.mode ?? 'strip', '', issues) as T;
  return {
    ok: issues.length === 0 || (options.mode ?? 'strip') === 'strip',
    sanitized,
    issues,
  };
}

export function assertNoReservedProofMetadata(metadata: unknown, label = 'metadata'): void {
  const issues = findReservedProofMetadataKeys(metadata);
  if (issues.length === 0) return;
  const paths = issues.map(issue => issue.path).join(', ');
  throw new Error(`${label} contains caller-writable reserved proof key(s): ${paths}`);
}
