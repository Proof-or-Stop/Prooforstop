/**
 * B-fd64 (Touchpoint 6): LOCAL Authority usage-evidence slice.
 *
 * This module is the ANTI-OVERCLAIM gate for the usage ledger. It does two
 * things and nothing else:
 *
 *   1. buildUsageEvidenceEnvelope(record): turn a ledger record into a
 *      PRIVACY-PRESERVING envelope = a stable digest of the canonical record
 *      plus an explicit ALLOWLIST of non-secret fields. No raw prompt /
 *      transcript / secret / api-key / auth-header may ever appear; the privacy
 *      denylist deep-scan (reused from record.ts) rejects any forbidden material.
 *
 *   2. verifyUsageReceipt(envelope, signedReceipt, verify): the verification
 *      gate. The receipt verifier is INJECTED (exactly like estimate.ts injects
 *      countTokens) so this module imports ZERO other Lattice modules — it must
 *      NOT import authority-signing.ts. A local record's authority.receiptVerified
 *      becomes true ONLY when the injected verifier returns verified===true AND
 *      the verifier's subject binding matches the envelope's subject. Every other
 *      path (no verifier, verifier throws, verified!==true, subject mismatch or
 *      missing) yields receiptVerified=false, fail-safe.
 *
 * INVARIANTS (load-bearing):
 *   - INV-1: this file imports only ./ siblings + node. The receipt verifier is
 *     injected, never imported.
 *   - INV-2: receiptVerified=true ONLY through verifyUsageReceipt with an injected
 *     verifier returning verified===true AND a matching subject binding. A
 *     transport ack, real token counts, a local hash chain, or a copied receiptId
 *     can NEVER produce verified=true.
 *   - INV-4: the envelope carries a digest + a non-secret allowlist only. The
 *     privacy denylist deep-scan rejects any forbidden material at any depth.
 *
 * PURE: no fs, no dispatch, no Date.now().
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical-json.js';
import {
  SCHEMA_VERSION,
  scanForbiddenFields,
  type AuthorityMode,
  type UsageLedgerRecord,
  type UsageSource,
} from './record.js';

/**
 * The non-secret token-count view carried in the envelope. Each dimension is a
 * finite non-negative integer or JSON null (absence) — exactly the ledger's
 * TokenDimension contract. Token counts are NOT secrets and NOT proof of
 * verification (see negative control 2).
 */
export interface EvidenceUsageCounts {
  source: UsageSource;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
}

/**
 * A privacy-preserving evidence envelope: a stable digest of the whole canonical
 * record plus an explicit ALLOWLIST of non-secret fields needed for a future
 * Authority submission. This is the ONLY thing that leaves the local boundary —
 * it contains no raw content and no secrets by construction.
 */
export interface PrivacyPreservingUsageEvidenceEnvelope {
  /** sha256 (hex) of canonicalJson(record). Deterministic + stable. */
  recordDigest: string;
  schemaVersion: typeof SCHEMA_VERSION;
  recordId: string;
  ledgerCallId: string;
  attemptId: string;
  sequence: number;
  /** Subject binding the receipt gate checks against. */
  storyId: string | null;
  model: string | null;
  provider: { name: string | null };
  usage: EvidenceUsageCounts;
  decision: { kind: 'allowed' | 'blocked' | 'failed' };
}

/** Error thrown when the source record carries forbidden privacy/secret material. */
export class ForbiddenEvidenceMaterialError extends Error {
  constructor(public readonly hits: readonly string[]) {
    super(
      `usage-ledger evidence: record carries forbidden privacy/secret material at: ${hits.join(', ')}`,
    );
    this.name = 'ForbiddenEvidenceMaterialError';
  }
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Separator-free forms of forbidden field NAMES. The record.ts denylist matches
 * exact lowercased keys, which `ApiKey`/`RawPrompt`/`AUTHORIZATION` already hit
 * (and it intentionally ALLOWS metadata flags like `promptStored`, which are not
 * raw content). The one gap is a separator variant like `API_KEY`, which
 * lowercases to `api_key` and so misses the exact set. The builder runs THIS
 * supplementary scan: it strips every non-alphanumeric char from each key (so
 * `API_KEY` -> `apikey`, `raw-prompt` -> `rawprompt`) and rejects only when the
 * normalized form EXACTLY equals a forbidden name. Exact (not substring) match
 * preserves the denylist's allowance of `promptStored`/`transcriptStored`. This
 * is a local hardening of the builder only; it does not change the validator.
 */
const FORBIDDEN_NORMALIZED_NAMES: ReadonlySet<string> = new Set([
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
  'password',
  'passphrase',
  'credential',
  'credentials',
  'authorization',
  'authorizationheader',
  'authheader',
  'bearertoken',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
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
  'rawcontent',
  'content',
  'totaltokens',
  'totaltoken',
  'tokentotal',
  'totalusage',
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Deep-scan for separator-variant forbidden field names (e.g. API_KEY). Uses an
 * EXACT match on the separator-stripped key so legitimate flags whose name merely
 * CONTAINS a forbidden word (e.g. `promptStored`) are not falsely flagged.
 */
function scanSeparatorVariants(value: unknown, path = ''): string[] {
  const hits: string[] = [];
  const visit = (node: unknown, nodePath: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${nodePath}[${index}]`));
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    for (const [key, child] of Object.entries(node)) {
      const childPath = nodePath ? `${nodePath}.${key}` : key;
      if (FORBIDDEN_NORMALIZED_NAMES.has(normalizeKey(key))) {
        hits.push(childPath);
      }
      visit(child, childPath);
    }
  };
  visit(value, path);
  return hits;
}

/**
 * Build a privacy-preserving evidence envelope from a ledger record.
 *
 * INV-4: before extracting anything, deep-scan the SOURCE record for forbidden
 * field names (the same denylist the validator uses) and THROW if any are
 * present, so forbidden material can never leak — not even by being read into a
 * digest input that a later change might expose. The digest itself is computed
 * over the canonical record only AFTER the scan passes, and only the explicit
 * allowlist of non-secret fields is copied into the envelope. We never read a
 * raw prompt / transcript / secret / api-key / auth-header value, at any depth.
 */
export function buildUsageEvidenceEnvelope(
  record: UsageLedgerRecord,
): PrivacyPreservingUsageEvidenceEnvelope {
  // Deep-scan the whole record (any nesting depth). One forbidden field name
  // poisons the build: we refuse rather than risk leaking it. The canonical
  // record.ts denylist runs first; the supplementary separator-insensitive scan
  // catches variants like API_KEY that the exact denylist would miss.
  const hits = [...new Set([...scanForbiddenFields(record), ...scanSeparatorVariants(record)])];
  if (hits.length > 0) {
    throw new ForbiddenEvidenceMaterialError(hits);
  }

  const recordDigest = sha256Hex(canonicalJson(record));

  const usage = record.usage;
  const provider = record.provider;

  return {
    recordDigest,
    schemaVersion: record.schemaVersion,
    recordId: record.recordId,
    ledgerCallId: record.ledgerCallId,
    attemptId: record.attemptId,
    sequence: record.sequence,
    storyId: record.storyId,
    model: provider?.model ?? null,
    provider: { name: provider?.name ?? null },
    usage: {
      source: usage.source,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
    },
    decision: { kind: record.decision.kind },
  };
}

/**
 * The shape an injected receipt verifier returns. `verified` MUST be a strict
 * boolean; `subjectKind`/`subjectId` are the subject the verifier confirmed the
 * receipt was issued for. A verifier that says verified but omits the subject is
 * incomplete and the gate will NOT trust it (cannot confirm the binding).
 */
export interface ReceiptVerifyResult {
  verified: boolean;
  subjectKind?: string;
  subjectId?: string;
}

/**
 * The injected verifier. It is given the signed receipt and the envelope and
 * returns (sync or async) a ReceiptVerifyResult. It is the ONLY thing that can
 * cause receiptVerified=true. This module never imports a concrete verifier —
 * authority-signing.ts (or any other module) is injected by the caller.
 */
export type ReceiptVerifier = (
  signedReceipt: unknown,
  envelope: PrivacyPreservingUsageEvidenceEnvelope,
) => ReceiptVerifyResult | Promise<ReceiptVerifyResult>;

/**
 * The authority block produced by the gate. Mirrors record.ts's LedgerAuthority
 * receipt-reference fields. A VERIFIED block (receiptVerified=true) is produced
 * ONLY by the gate's golden path; the local append path never constructs this.
 */
export interface VerifiedAuthorityBlock {
  mode: AuthorityMode;
  receiptVerified: boolean;
  receiptId: string | null;
  receiptSubjectKind: string | null;
  receiptSubjectId: string | null;
}

/** The fail-safe unverified block: every non-golden path returns this shape. */
function unverifiedBlock(mode: AuthorityMode): VerifiedAuthorityBlock {
  return {
    mode,
    receiptVerified: false,
    receiptId: null,
    receiptSubjectKind: null,
    receiptSubjectId: null,
  };
}

function extractReceiptId(signedReceipt: unknown): string | null {
  if (typeof signedReceipt !== 'object' || signedReceipt === null) return null;
  const id = (signedReceipt as Record<string, unknown>).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * The verification gate. receiptVerified becomes true ONLY when ALL hold:
 *
 *   - a verifier is injected (no verifier -> unverified);
 *   - the verifier does not throw (throw -> unverified, fail-safe);
 *   - verify.verified === true (strict boolean; truthy non-true -> unverified);
 *   - the verifier reported a subject (subjectKind AND subjectId present);
 *   - that subject MATCHES the envelope's subject binding
 *     (envelope.storyId, with subjectKind 'story').
 *
 * The single load-bearing condition (quoted verbatim from the implementation):
 *
 *     result.verified === true &&
 *     subjectKind === EXPECTED_SUBJECT_KIND &&
 *     subjectId !== undefined && subjectId === envelope.storyId
 *
 * When it holds we return receiptVerified=true with the receiptId + subject;
 * otherwise we return the fail-safe unverified block. A copied receiptId, a
 * transport ack, real token counts, or a local hash chain can NEVER satisfy this
 * condition because none of them run the injected verifier to verified===true
 * with a matching subject.
 */
export const EXPECTED_SUBJECT_KIND = 'story' as const;

export async function verifyUsageReceipt(
  envelope: PrivacyPreservingUsageEvidenceEnvelope,
  signedReceipt: unknown,
  verify: ReceiptVerifier | null | undefined,
  options: { mode?: AuthorityMode } = {},
): Promise<VerifiedAuthorityBlock> {
  const mode: AuthorityMode = options.mode ?? 'local';

  // No verifier injected -> nothing can be verified. Default to unverified.
  if (typeof verify !== 'function') {
    return unverifiedBlock(mode);
  }

  let result: ReceiptVerifyResult;
  try {
    // Support both sync and async verifiers; await normalizes a plain value too.
    result = await verify(signedReceipt, envelope);
  } catch {
    // A throwing/malicious/buggy verifier can NEVER produce a verified result.
    return unverifiedBlock(mode);
  }

  if (typeof result !== 'object' || result === null) {
    return unverifiedBlock(mode);
  }

  const verified = result.verified;
  const subjectKind = result.subjectKind;
  const subjectId = result.subjectId;

  // The single gate condition. Strict === true rejects truthy non-boolean
  // values (1, "true", {}). The subject binding must be a 'story' whose id
  // equals the envelope's storyId — this defeats receipt replay across records.
  const passes =
    verified === true &&
    subjectKind === EXPECTED_SUBJECT_KIND &&
    subjectId !== undefined &&
    subjectId === envelope.storyId;

  if (!passes) {
    return unverifiedBlock(mode);
  }

  const receiptId = extractReceiptId(signedReceipt);
  if (receiptId === null) {
    // Verified but no receipt id to bind: cannot record a verified reference.
    return unverifiedBlock(mode);
  }

  return {
    mode,
    receiptVerified: true,
    receiptId,
    receiptSubjectKind: subjectKind,
    receiptSubjectId: subjectId,
  };
}
