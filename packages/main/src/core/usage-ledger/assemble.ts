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
 * docs/requirements/decisions/lattice-llm-usage-ledger-execution-plan.md.
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

/** The providers this assembler knows how to normalize. */
export type ProviderName = 'anthropic' | 'openai';

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
  switch (provider) {
    case 'anthropic':
      return adaptAnthropicUsage(extractRawUsage(providerResponse, 'usage'));
    case 'openai':
      return adaptOpenAiUsage(extractRawUsage(providerResponse, 'usage'));
    default: {
      // Exhaustiveness guard: an unknown provider is a programmer error.
      const never: never = provider;
      throw new Error(`usage-ledger assemble: unknown provider "${String(never)}"`);
    }
  }
}

/**
 * Pull the usage sub-object out of a provider response by key. A response that
 * IS already the usage object (no nested key) is passed through. A
 * null/undefined/non-object response yields undefined so the adapter funnels it
 * into its unavailable path.
 */
function extractRawUsage(providerResponse: unknown, key: string): unknown {
  if (typeof providerResponse !== 'object' || providerResponse === null) {
    return undefined;
  }
  const response = providerResponse as Record<string, unknown>;
  if (key in response) return response[key];
  // The caller may already have handed us the usage object directly.
  return providerResponse;
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
  const usage = options.usage ?? adaptUsageFor(provider, providerResponse);

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
