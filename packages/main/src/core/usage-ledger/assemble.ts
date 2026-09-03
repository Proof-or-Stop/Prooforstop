/**
 * B-08a1 CHK-004 (Slice 2): provider response -> validated ledger record.
 *
 * `buildProviderRecord` selects the right provider adapter, maps the provider
 * usage into a B-253e `LedgerUsage`, and assembles a FULL ledger record body
 * (everything except the `integrity` block, which the writer owns). It then runs
 * the B-253e validator and THROWS on failure, so a malformed provider payload
 * can never produce a record the writer would later reject.
 *
 * Implements "Multi-Provider Normalization", "Call and Attempt Correlation
 * Semantics", and "Privacy Constraints" from
 * docs/requirements/decisions/proof-or-stop-llm-usage-ledger-execution-plan.md.
 *
 * Boundary (Slice 2 scope):
 *   - PURE: no fs, no live dispatch, no Date.now(). `recordedAt` and
 *     `projectRootHash` are supplied by the caller (the foundation never calls
 *     Date.now() inside the record layer; the smoke uses a fixed timestamp).
 *   - Correlation ids (ledgerCallId / attemptId / recordId) come ONLY from the
 *     correlation argument (ids.ts-minted). They are NEVER derived from the
 *     provider response/request id — even if the response carries id/request_id.
 *   - authority is always {mode:'local', receiptId:null, receiptVerified:false}.
 *     A local record never claims receipt verification.
 *   - integrity is left to the writer (appendUsageRecord).
 */

import {
  SCHEMA_VERSION,
  type LedgerUsage,
  type UsageLedgerRecordInput,
  validateUsageLedgerRecord,
} from './record.js';
import { mintRecordId } from './ids.js';
import { adaptAnthropicUsage } from './adapters/anthropic.js';
import { adaptOpenAiUsage } from './adapters/openai.js';
import { adaptGeminiUsage } from './adapters/gemini.js';
import { ownProp } from './sanitize.js';

/** The providers this assembler knows how to normalize. */
export type ProviderName = 'anthropic' | 'openai' | 'gemini';

/** Default redaction profile id (the ledger stores no raw content). */
export const DEFAULT_REDACTION_PROFILE = 'no-raw-content-v1';

/**
 * Correlation handle minted locally BEFORE dispatch (ids.ts). These ids are the
 * primary keys of the record and must never be derived from a provider id.
 */
export interface RecordCorrelation {
  ledgerCallId: string;
  attemptId: string;
  sequence: number;
  supersedesRecordIds: string[];
}

/**
 * Attribution context for the call. `storyId` is nullable (non-story calls) but
 * is never omitted — it is always written, as null when absent.
 */
export interface RecordAttribution {
  storyId: string | null;
  phase: string;
  agentType: string;
  subagentId?: string | null;
  threadId?: string | null;
}

/**
 * Environment context the caller supplies. Kept out of correlation/attribution
 * so it is obvious these come from the local environment, not the provider.
 * `recordedAt` and `projectRootHash` are caller-supplied (no Date.now() here).
 */
export interface RecordContext {
  recordedAt: string;
  projectRootHash: string;
  /** Defaults to DEFAULT_REDACTION_PROFILE when omitted. */
  redactionProfile?: string;
  /** Optional decision metadata; defaults to a plain {kind:'allowed'}. */
  decision?: UsageLedgerRecordInput['decision'];
  /** Optional provider metadata (name/model/requestIdHash). */
  provider?: UsageLedgerRecordInput['provider'];
  /** Optional host metadata. */
  host?: UsageLedgerRecordInput['host'];
  /** Optional command label. */
  command?: string;
}

/**
 * When the caller already extracted (or stream-assembled) a `LedgerUsage`, it
 * can be passed directly instead of a raw provider response. This is how the
 * streaming helpers (CHK-005) feed assembled usage into a record without
 * re-running an adapter.
 */
export interface BuildProviderRecordOptions {
  /** Pre-mapped usage (e.g. from streaming extraction). Skips the adapter. */
  usage?: LedgerUsage;
}

/** Map a provider name to its raw-usage adapter. */
function adaptUsageFor(provider: ProviderName, providerResponse: unknown): LedgerUsage {
  // B-6878: each adapter receives the ORIGINAL raw usage sub-object and projects
  // it INTERNALLY (toOwnPropsNullProto with its own whitelist) for the token-field
  // reads — so a polluted Object.prototype token key can never be resolved — while
  // the digest is computed over the ORIGINAL payload (byte-identical to
  // pre-B-6878, extra non-read fields preserved). extractRawUsage only selects the
  // right sub-object via an OWN-property container guard (no projection here).
  switch (provider) {
    case 'anthropic':
      return adaptAnthropicUsage(extractRawUsage(providerResponse, 'usage'));
    case 'openai':
      return adaptOpenAiUsage(extractRawUsage(providerResponse, 'usage'));
    case 'gemini':
      return adaptGeminiUsage(extractRawUsage(providerResponse, 'usageMetadata'));
    default: {
      // Exhaustiveness guard: an unknown provider is a programmer error.
      const never: never = provider;
      throw new Error(`usage-ledger assemble: unknown provider "${String(never)}"`);
    }
  }
}

/**
 * Pull the ORIGINAL usage sub-object out of a provider response by key, using an
 * OWN-property container guard. No whitelist projection happens here — the adapter
 * projects internally for its reads while digesting the original payload (B-6878).
 *
 * Shape handling: a null/undefined/non-object response yields `undefined` so the
 * adapter funnels it into its unavailable path; a response carrying the usage
 * sub-object as its OWN `key` uses that sub-object; a response that IS already the
 * usage object (no own `key`) is used directly.
 *
 * The own-property `key` selection (not a prototype-chain `in`): a polluted
 * Object.prototype.usage on a response with no OWN usage key can never masquerade
 * as a usage sub-object — an inherited container is treated as absent.
 */
function extractRawUsage(providerResponse: unknown, key: string): unknown {
  if (typeof providerResponse !== 'object' || providerResponse === null) {
    return undefined;
  }
  // Own-property check (not `in`): an inherited `key` never selects a sub-object.
  return Object.prototype.hasOwnProperty.call(providerResponse, key)
    ? (providerResponse as Record<string, unknown>)[key]
    : // The caller may already have handed us the usage object directly.
      providerResponse;
}

/**
 * Assemble a full, validated ledger record body from a provider response.
 *
 * Throws when the assembled record fails the B-253e validator (e.g. a rogue
 * provider payload with a negative or string token count, or a forbidden field
 * leaking through). The returned value is a `UsageLedgerRecordInput` ready for
 * `appendUsageRecord`, which fills the integrity block.
 */
export function buildProviderRecord(
  provider: ProviderName,
  providerResponse: unknown,
  correlation: RecordCorrelation,
  attribution: RecordAttribution,
  context: RecordContext,
  options: BuildProviderRecordOptions = {},
): UsageLedgerRecordInput {
  // B-6878: read the pre-mapped `usage` override via an OWN-property guard. A bare
  // `options.usage` is a prototype-chain read, so a polluted
  // Object.prototype.usage would, for a caller passing `options = {}`, masquerade
  // as a supplied usage and bypass the adapter. Only an OWN `usage` key counts as
  // a real override; otherwise we run the adapter on the provider response (whose
  // own usage is projected through the chokepoint).
  const hasUsageOverride = ownProp(options, 'usage') && options.usage !== undefined;
  const usage = hasUsageOverride
    ? (options.usage as LedgerUsage)
    : adaptUsageFor(provider, providerResponse);

  const record: UsageLedgerRecordInput = {
    schemaVersion: SCHEMA_VERSION,
    // Correlation ids come ONLY from ids.ts / the correlation arg — never from
    // the provider response. recordId is freshly minted per record line.
    recordId: mintRecordId(),
    ledgerCallId: correlation.ledgerCallId,
    attemptId: correlation.attemptId,
    sequence: correlation.sequence,
    supersedesRecordIds: [...correlation.supersedesRecordIds],
    recordedAt: context.recordedAt,
    projectRootHash: context.projectRootHash,
    // storyId is always written (null for non-story calls, never omitted).
    storyId: attribution.storyId,
    phase: attribution.phase,
    agentType: attribution.agentType,
    subagentId: attribution.subagentId ?? null,
    threadId: attribution.threadId ?? null,
    decision: context.decision ?? { kind: 'allowed' },
    usage,
    privacy: {
      promptStored: false,
      transcriptStored: false,
      redactionProfile: context.redactionProfile ?? DEFAULT_REDACTION_PROFILE,
    },
    // Local records NEVER claim receipt verification.
    authority: { mode: 'local', receiptId: null, receiptVerified: false },
    // integrity is intentionally omitted: the writer owns it.
  };

  if (context.command !== undefined) record.command = context.command;
  if (context.host !== undefined) record.host = context.host;
  if (context.provider !== undefined) record.provider = context.provider;

  // Validate the assembled body (without integrity — the writer adds it). Throw
  // on failure so a bad provider payload never yields a record we'd later reject.
  const result = validateUsageLedgerRecord(record, { expectIntegrity: false });
  if (!result.ok) {
    throw new Error(
      `usage-ledger assemble: provider "${provider}" produced an invalid record:\n - ${result.errors.join('\n - ')}`,
    );
  }

  return record;
}
