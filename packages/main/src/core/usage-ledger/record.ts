/**
 * B-253e CHK-001 / CHK-004: LLM usage ledger record types + schema validator.
 *
 * Implements the JSONL record shape and the "Required record constraints" from
 * docs/requirements/decisions/lattice-llm-usage-ledger-execution-plan.md
 * ("JSON Ledger Record Shape", "Required record constraints", "Per-dimension
 * absence rule", "Privacy Constraints").
 *
 * This is the FOUNDATION slice (Slice 1). It defines the record contract and a
 * strict validator. It does NOT implement provider adapters, live dispatch,
 * count_tokens / estimate computation, budget enforcement, or the Authority
 * receipt path. The ledger stays opt-in / inert.
 *
 * Two load-bearing invariants the validator enforces:
 *   1. NO stored totalTokens (or any pre-summed total) at ANY nesting depth.
 *      Totals are derived in the summary layer only.
 *   2. NO raw prompt / completion / transcript / tool arguments / provider
 *      secrets / customer API keys / actor keys / authorization headers at ANY
 *      nesting depth. One forbidden field poisons the whole record.
 */

export const SCHEMA_VERSION = 1 as const;

/** Closed enum of usage sources. */
export type UsageSource = 'provider-reported' | 'prompt-size-estimate' | 'unavailable';

export const USAGE_SOURCES: readonly UsageSource[] = [
  'provider-reported',
  'prompt-size-estimate',
  'unavailable',
];

/** Local Authority boundary mode. Local records are NEVER receipt-backed here. */
export type AuthorityMode = 'local' | 'shadow';

export type EstimatorConfidence = 'high' | 'medium' | 'low';

/**
 * Per-dimension cache absence is encoded as `null` (never `0`, never omitted).
 * A numeric `0` is a genuine provider-reported zero; `null` means "the provider
 * did not report this dimension".
 */
export type TokenDimension = number | null;

export interface UsageEstimator {
  name: string;
  version: string;
  unit: string;
  confidence?: EstimatorConfidence;
}

export interface UsageCanonical {
  input: TokenDimension;
  output: TokenDimension;
  cacheCreation: TokenDimension;
  cacheRead: TokenDimension;
}

export interface UsageRaw {
  providerUnits: string;
  payloadDigest: string;
}

export interface UsageBillableUnit {
  kind: string;
  name: string;
  quantity: number | null;
}

export interface LedgerUsage {
  source: UsageSource;
  /** Uncached input remainder (NOT total input). */
  inputTokens: TokenDimension;
  outputTokens: TokenDimension;
  cacheCreationInputTokens: TokenDimension;
  cacheReadInputTokens: TokenDimension;
  canonical?: UsageCanonical;
  raw?: UsageRaw;
  billableUnits?: UsageBillableUnit[];
  estimator?: UsageEstimator | null;
  unavailableReason?: string | null;
  pricingRef?: string | null;
  pricingVersion?: string | null;
}

export interface LedgerHost {
  kind: string;
  sessionIdHash?: string | null;
  runnerIdHash?: string | null;
}

export interface LedgerProvider {
  name: string;
  model: string;
  /** Optional provider correlation metadata only — never the primary key. */
  requestIdHash?: string | null;
}

export interface LedgerDecision {
  kind: 'allowed' | 'blocked' | 'failed';
  budgetPolicyId?: string | null;
  budgetScope?: string | null;
  reasonCode?: string | null;
}

export interface LedgerPrivacy {
  promptStored: false;
  transcriptStored: false;
  redactionProfile: string;
}

/**
 * Authority block on a LOCAL ledger record.
 *
 * `receiptVerified` is the load-bearing anti-overclaim field: for a local record
 * it is ALWAYS the literal `false`. A record can only carry a VERIFIED receipt
 * through the verification gate (authority-evidence.ts `verifyUsageReceipt`),
 * which is a separate, gate-only authority block — it is never constructed by the
 * local append path and never set here.
 *
 * The receipt-REFERENCE fields (`receiptId`, `receiptSubjectKind`,
 * `receiptSubjectId`) are nullable. They may be set as a MERE REFERENCE to a
 * receipt the record points at, but a reference is NOT verification: having a
 * receiptId set does not (and must not) flip `receiptVerified`. The validator
 * enforces that they are all-or-nothing (a partial reference is incoherent) and
 * that `receiptVerified` stays `false` regardless of any reference.
 */
export interface LedgerAuthority {
  mode: AuthorityMode;
  /** Nullable reference to a receipt this record points at (NOT verification). */
  receiptId: string | null;
  /** Always literal false for a local record — verification is gate-only. */
  receiptVerified: false;
  /** Subject kind of the referenced receipt; non-null only WITH receiptId. */
  receiptSubjectKind?: string | null;
  /** Subject id of the referenced receipt; non-null only WITH receiptId. */
  receiptSubjectId?: string | null;
}

export interface LedgerIntegrity {
  previousRecordHash: string | null;
  recordHash: string;
}

export interface UsageLedgerRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  recordId: string;
  ledgerCallId: string;
  attemptId: string;
  sequence: number;
  supersedesRecordIds: string[];
  recordedAt: string;
  projectRootHash: string;
  /** May be null for non-story calls; the field is never omitted. */
  storyId: string | null;
  phase: string;
  agentType: string;
  subagentId?: string | null;
  threadId?: string | null;
  command?: string;
  host?: LedgerHost;
  provider?: LedgerProvider;
  decision: LedgerDecision;
  usage: LedgerUsage;
  privacy: LedgerPrivacy;
  authority: LedgerAuthority;
  integrity: LedgerIntegrity;
}

/**
 * The record shape EXCLUDING the integrity block. The writer fills
 * `integrity` (`previousRecordHash`, `recordHash`). Callers construct this and
 * hand it to the writer, which is the only code that may set integrity hashes.
 */
export type UsageLedgerRecordInput = Omit<UsageLedgerRecord, 'integrity'> & {
  integrity?: Partial<LedgerIntegrity>;
};

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Forbidden field NAMES (lower-cased). A record carrying any of these at ANY
 * nesting depth is refused outright — one forbidden field poisons the whole
 * record. This is the Privacy Constraints denylist plus the stored-total ban.
 */
const FORBIDDEN_FIELD_NAMES: ReadonlySet<string> = new Set([
  // Pre-summed totals (must be summary-derived, never stored).
  'totaltokens',
  'totaltoken',
  'tokentotal',
  'totalusage',
  // Raw content.
  'rawprompt',
  'prompt',
  'rawcompletion',
  'completion',
  'rawtranscript',
  'transcript',
  'messages',
  'rawmessages',
  'rawresponse',
  'responsebody',
  'rawrequest',
  'requestbody',
  'toolarguments',
  'toolargs',
  'rawtoolarguments',
  'rawtoolargs',
  'rawtoolresult',
  'toolresult',
  'rawcontent',
  'content',
  // Secrets / keys / headers.
  'apikey',
  'apikeys',
  'apisecret',
  'providersecret',
  'providerapikey',
  'providerkey',
  'customerapikey',
  'actorkey',
  'actorsecret',
  'privatekey',
  'secret',
  'secrets',
  'secretkey',
  'authorization',
  'authorizationheader',
  'authheader',
  'bearertoken',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'password',
  'passphrase',
  'credentials',
  'credential',
  'env',
  'environmentvariables',
  'envvars',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Walk the record at arbitrary depth and collect every forbidden field name it
 * carries. Returns dotted JSON paths so the error names the exact location
 * (e.g. `metadata.debug.rawPrompt`).
 *
 * NOTE: this scans by FIELD NAME, not by value, so it cannot be evaded by a
 * benign-looking value. A field literally named `totalTokens` is rejected even
 * if its value is null/0.
 */
export function scanForbiddenFields(record: unknown, basePath = ''): string[] {
  const hits: string[] = [];
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (FORBIDDEN_FIELD_NAMES.has(key.toLowerCase())) {
        hits.push(childPath);
      }
      visit(child, childPath);
    }
  };
  visit(record, basePath);
  return hits;
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value);
}

/**
 * A token dimension is either a JSON `null` (absence) or a finite non-negative
 * integer. `undefined`, strings, floats, and negatives are all rejected — the
 * undefined-vs-null confusion attack and the string-coercion attack both fail
 * here.
 */
function validateTokenDimension(value: unknown, label: string, errors: string[]): void {
  if (value === null) return;
  if (value === undefined) {
    errors.push(`${label} must be a non-negative integer or JSON null, not undefined/omitted`);
    return;
  }
  if (!isInteger(value)) {
    errors.push(`${label} must be a non-negative integer or null (got ${describe(value)})`);
    return;
  }
  if (value < 0) {
    errors.push(`${label} must be >= 0`);
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return `${typeof value} ${JSON.stringify(value)}`;
}

function requireString(value: unknown, label: string, errors: string[]): void {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${label} must be a non-empty string (got ${describe(value)})`);
  }
}

/**
 * Validate a candidate ledger record against the spec.
 *
 * `expectIntegrity` controls whether the `integrity` block is required:
 *   - the writer validates BEFORE chaining with `expectIntegrity=false`;
 *   - a written line is validated with `expectIntegrity=true`.
 *
 * The validator NEVER throws; it returns a structured result. Every rejection
 * carries a clear, specific message.
 */
export function validateUsageLedgerRecord(
  candidate: unknown,
  options: { expectIntegrity?: boolean } = {},
): ValidationResult {
  const expectIntegrity = options.expectIntegrity ?? false;
  const errors: string[] = [];

  if (!isPlainObject(candidate)) {
    return { ok: false, errors: ['record must be a JSON object'] };
  }
  const record = candidate as Record<string, unknown>;

  // --- Privacy + stored-total denylist (deep scan, any nesting depth). ---
  const forbidden = scanForbiddenFields(record);
  for (const path of forbidden) {
    const lower = path.split(/[.[]/).pop()?.replace(/\]$/, '').toLowerCase() ?? path;
    if (
      lower.includes('total') &&
      (lower.includes('token') || lower.includes('usage'))
    ) {
      errors.push(`forbidden stored total field "${path}" (totals are summary-derived, never stored)`);
    } else {
      errors.push(`forbidden privacy/secret field "${path}" (raw content, secrets, keys, and headers are not allowed in the ledger)`);
    }
  }

  // --- Top-level required scalars. ---
  if (record.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION} (got ${describe(record.schemaVersion)})`);
  }
  requireString(record.recordId, 'recordId', errors);
  requireString(record.ledgerCallId, 'ledgerCallId', errors);
  requireString(record.attemptId, 'attemptId', errors);
  requireString(record.recordedAt, 'recordedAt', errors);
  requireString(record.projectRootHash, 'projectRootHash', errors);
  requireString(record.phase, 'phase', errors);
  requireString(record.agentType, 'agentType', errors);

  // storyId is nullable but MUST be present (null allowed, undefined not).
  if (!('storyId' in record)) {
    errors.push('storyId is required (use null for non-story calls, never omit it)');
  } else if (record.storyId !== null && typeof record.storyId !== 'string') {
    errors.push(`storyId must be a string or null (got ${describe(record.storyId)})`);
  }

  // sequence: positive integer.
  if (!isInteger(record.sequence) || (record.sequence as number) < 1) {
    errors.push(`sequence must be a positive integer >= 1 (got ${describe(record.sequence)})`);
  }

  // supersedesRecordIds: required string[] (may be empty), undefined rejected.
  if (!('supersedesRecordIds' in record)) {
    errors.push('supersedesRecordIds is required (use [] when nothing is superseded)');
  } else if (!Array.isArray(record.supersedesRecordIds)) {
    errors.push(`supersedesRecordIds must be an array (got ${describe(record.supersedesRecordIds)})`);
  } else if (!record.supersedesRecordIds.every((id) => typeof id === 'string' && id.length > 0)) {
    errors.push('supersedesRecordIds must contain only non-empty strings');
  }

  // Optional attribution identifiers, when present, must be string|null.
  for (const key of ['subagentId', 'threadId'] as const) {
    if (key in record && record[key] !== null && typeof record[key] !== 'string') {
      errors.push(`${key} must be a string or null when present (got ${describe(record[key])})`);
    }
  }

  // --- decision ---
  if (!isPlainObject(record.decision)) {
    errors.push('decision must be an object');
  } else {
    const kind = record.decision.kind;
    if (kind !== 'allowed' && kind !== 'blocked' && kind !== 'failed') {
      errors.push(`decision.kind must be one of allowed|blocked|failed (got ${describe(kind)})`);
    }
  }

  // --- usage ---
  validateUsage(record.usage, errors);

  // --- privacy ---
  if (!isPlainObject(record.privacy)) {
    errors.push('privacy must be an object');
  } else {
    if (record.privacy.promptStored !== false) errors.push('privacy.promptStored must be false');
    if (record.privacy.transcriptStored !== false) errors.push('privacy.transcriptStored must be false');
    requireString(record.privacy.redactionProfile, 'privacy.redactionProfile', errors);
  }

  // --- authority (local records only) ---
  if (!isPlainObject(record.authority)) {
    errors.push('authority must be an object');
  } else {
    const authority = record.authority;
    if (authority.mode !== 'local' && authority.mode !== 'shadow') {
      errors.push(`authority.mode must be "local" or "shadow" (got ${describe(authority.mode)})`);
    }

    // receiptVerified is the anti-overclaim field. For a LOCAL record it must be
    // the strict literal `false`. `!== false` rejects true, the string "true",
    // truthy numbers, and undefined alike — a record cannot self-declare verified
    // by hand-setting this field; verification is gate-only (authority-evidence).
    if (authority.receiptVerified !== false) {
      errors.push('authority.receiptVerified must be false for local records (verification is gate-only)');
    }

    // Receipt-reference fields are nullable but ALL-OR-NOTHING: a referenced
    // receipt names a receiptId + subject kind + subject id together, or all
    // three are null. A partial reference is incoherent and rejected. Note: a
    // valid reference is NOT verification — receiptVerified still must be false.
    const refFields: Array<[string, unknown]> = [
      ['receiptId', authority.receiptId],
      ['receiptSubjectKind', authority.receiptSubjectKind ?? null],
      ['receiptSubjectId', authority.receiptSubjectId ?? null],
    ];
    for (const [label, value] of refFields) {
      if (value !== null && (typeof value !== 'string' || value.length === 0)) {
        errors.push(`authority.${label} must be a non-empty string or null (got ${describe(value)})`);
      }
    }
    const presentCount = refFields.filter(([, value]) => value !== null && typeof value === 'string' && value.length > 0).length;
    if (presentCount !== 0 && presentCount !== 3) {
      errors.push(
        'authority receipt-reference fields are all-or-nothing: receiptId + receiptSubjectKind + receiptSubjectId must be set together (a partial reference is incoherent)',
      );
    }
  }

  // --- integrity ---
  if (expectIntegrity) {
    if (!isPlainObject(record.integrity)) {
      errors.push('integrity must be an object');
    } else {
      if (
        record.integrity.previousRecordHash !== null &&
        (typeof record.integrity.previousRecordHash !== 'string' || record.integrity.previousRecordHash.length === 0)
      ) {
        errors.push('integrity.previousRecordHash must be a non-empty string or null');
      }
      requireString(record.integrity.recordHash, 'integrity.recordHash', errors);
    }
  }

  return { ok: errors.length === 0, errors };
}

function validateUsage(usage: unknown, errors: string[]): void {
  if (!isPlainObject(usage)) {
    errors.push('usage must be an object');
    return;
  }

  const source = usage.source;
  if (typeof source !== 'string' || !USAGE_SOURCES.includes(source as UsageSource)) {
    errors.push(`usage.source must be one of ${USAGE_SOURCES.join('|')} (got ${describe(source)})`);
  }

  // The four cache-aware token fields must be present on every record.
  for (const field of [
    'inputTokens',
    'outputTokens',
    'cacheCreationInputTokens',
    'cacheReadInputTokens',
  ] as const) {
    if (!(field in usage)) {
      errors.push(`usage.${field} is required (use null for an unavailable dimension, never omit it)`);
    } else {
      validateTokenDimension(usage[field], `usage.${field}`, errors);
    }
  }

  if (source === 'provider-reported') {
    // Provider-reported records must carry both the raw digest and canonical view.
    validateCanonical(usage.canonical, errors);
    validateRaw(usage.raw, errors);
    // input/output must be present (non-null) — a provider-reported record with
    // null primary input/output makes no sense (use unavailable instead).
    if (usage.inputTokens === null) {
      errors.push('usage.inputTokens must not be null for a provider-reported record');
    }
    if (usage.outputTokens === null) {
      errors.push('usage.outputTokens must not be null for a provider-reported record');
    }
  }

  if (source === 'prompt-size-estimate') {
    const estimator = usage.estimator;
    if (!isPlainObject(estimator)) {
      errors.push('usage.estimator is required for source=prompt-size-estimate with {name,version,unit}');
    } else {
      requireString(estimator.name, 'usage.estimator.name', errors);
      requireString(estimator.version, 'usage.estimator.version', errors);
      requireString(estimator.unit, 'usage.estimator.unit', errors);
      if (
        'confidence' in estimator &&
        estimator.confidence !== 'high' &&
        estimator.confidence !== 'medium' &&
        estimator.confidence !== 'low'
      ) {
        errors.push('usage.estimator.confidence must be high|medium|low when present');
      }
    }
  }

  if (source === 'unavailable') {
    if (typeof usage.unavailableReason !== 'string' || usage.unavailableReason.length === 0) {
      errors.push('usage.unavailableReason is required (non-empty) for source=unavailable');
    }
  }
}

function validateCanonical(canonical: unknown, errors: string[]): void {
  if (!isPlainObject(canonical)) {
    errors.push('usage.canonical is required for provider-reported records');
    return;
  }
  for (const field of ['input', 'output', 'cacheCreation', 'cacheRead'] as const) {
    if (!(field in canonical)) {
      errors.push(`usage.canonical.${field} is required (use null for an unavailable dimension)`);
    } else {
      validateTokenDimension(canonical[field], `usage.canonical.${field}`, errors);
    }
  }
}

function validateRaw(raw: unknown, errors: string[]): void {
  if (!isPlainObject(raw)) {
    errors.push('usage.raw is required for provider-reported records (providerUnits + payloadDigest)');
    return;
  }
  requireString(raw.providerUnits, 'usage.raw.providerUnits', errors);
  requireString(raw.payloadDigest, 'usage.raw.payloadDigest', errors);
}
