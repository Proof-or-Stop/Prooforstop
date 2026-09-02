/**
 * B-08a1 CHK-005 (Slice 2): streaming / failure usage extraction.
 *
 * Implements "Streaming and failure usage capture" from
 * docs/requirements/decisions/proof-or-stop-llm-usage-ledger-execution-plan.md.
 *
 * Rules implemented here:
 *   - Final usage is read from the TERMINAL stream event (the last event that
 *     carries usage counts), never from an earlier/intermediate delta and never
 *     assumed from a non-streaming shape.
 *   - A call that errors / times out mid-stream still records the PARTIAL counts
 *     it actually consumed. If ANY real count was received, the usage stays
 *     `provider-reported` (partial allowed) — an errored call that produced
 *     tokens cost budget and must not be recorded as zero or downgraded.
 *   - `unavailable` is used ONLY when there is truly no count at all (no terminal
 *     usage event and no partial counts). Missing usage is never defaulted to 0.
 *
 * Anthropic note: streaming usage is split across events. `message_start`
 * carries `input_tokens` and the cache fields; the cumulative `output_tokens`
 * arrives on `message_delta` events, with the FINAL `message_delta` carrying the
 * authoritative output count. The extractor merges the latest of each.
 *
 * PURE: no fs, no dispatch, no Date.now().
 */

import type { LedgerUsage, TokenDimension, UsageCanonical } from './record.js';
import { adaptAnthropicUsage, ANTHROPIC_PROVIDER_UNITS } from './adapters/anthropic.js';
import {
  adaptOpenAiUsage,
  OPENAI_PROVIDER_UNITS,
  OPENAI_USAGE_WHITELIST,
  OPENAI_NESTED_DETAIL_WHITELIST,
} from './adapters/openai.js';
import { adaptGeminiUsage, GEMINI_PROVIDER_UNITS, GEMINI_USAGE_WHITELIST } from './adapters/gemini.js';
import {
  buildUnavailableUsage,
  hasBothPrimaries,
  isUsableUsageObject,
  payloadDigest,
  readReportedDimension,
} from './adapters/shared.js';
import { ownProp, toOwnPropsNullProto } from './sanitize.js';

/**
 * B-6878: per-provider token-key whitelists for the streaming path. The streaming
 * extractors do NOT route through the assemble chokepoint, so each stream-parsed
 * usage object is projected through toOwnPropsNullProto here for the LOCAL
 * pollution-safe token READS (primaries + the partial cacheRead belt), making
 * those reads operate on a null-proto, whitelist-only object — safe by
 * construction, mirroring assemble. (The COMPLETE path defers to the adapter,
 * which is fed the ORIGINAL terminal usage and does its own internal
 * project-for-reads + digest-original; see the F-007 note at each call site.)
 *
 * F-010 (DRY): these whitelists are NOT re-declared here — they are the SAME
 * exported constants the adapters use (OPENAI_USAGE_WHITELIST /
 * OPENAI_NESTED_DETAIL_WHITELIST / GEMINI_USAGE_WHITELIST), imported above, so a
 * future adapter whitelist change can never silently diverge from streaming.
 */

/** Project an openai stream usage object (incl. nested details) to null-proto. */
function sanitizeOpenAiStreamUsage(raw: unknown): Record<string, unknown> {
  const projected = toOwnPropsNullProto(raw, OPENAI_USAGE_WHITELIST);
  const nested = projected.prompt_tokens_details;
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    projected.prompt_tokens_details = toOwnPropsNullProto(nested, OPENAI_NESTED_DETAIL_WHITELIST);
  }
  return projected;
}

/** Default reason used when a stream produced no usage at all. */
function noUsageReason(provider: string, errorReason?: string): string {
  const base = `${provider}: stream produced no usage counts`;
  return errorReason ? `${base} (${errorReason})` : base;
}

/**
 * Build a PARTIAL provider-reported usage from already-extracted dimensions.
 *
 * Used only on the mid-stream-failure path where at least one real count exists
 * but the primaries may be incomplete (e.g. output received before the input
 * count, or vice versa). The available dimensions are preserved as-is and any
 * dimension never seen is `null` (never 0). The record stays `provider-reported`
 * because real counts were consumed.
 *
 * NOTE: a partial usage with a null primary is intentionally NOT writable as a
 * full record via buildProviderRecord (the B-253e validator requires non-null
 * input AND output for provider-reported). This helper expresses the spec's
 * "partial counts are still provider-reported" rule at the usage level; the
 * caller decides how to persist a partial.
 */
function buildPartialProviderUsage(
  dims: { input: TokenDimension; output: TokenDimension; cacheCreation: TokenDimension; cacheRead: TokenDimension },
  providerUnits: string,
  rawUsage: unknown,
): LedgerUsage {
  const canonical: UsageCanonical = {
    input: dims.input,
    output: dims.output,
    cacheCreation: dims.cacheCreation,
    cacheRead: dims.cacheRead,
  };
  return {
    source: 'provider-reported',
    inputTokens: dims.input,
    outputTokens: dims.output,
    cacheCreationInputTokens: dims.cacheCreation,
    cacheReadInputTokens: dims.cacheRead,
    canonical,
    raw: { providerUnits, payloadDigest: payloadDigest(rawUsage) },
    estimator: null,
    unavailableReason: null,
  };
}

/** True when at least one dimension carries a real (non-null) count. */
function anyCount(dims: { input: TokenDimension; output: TokenDimension; cacheCreation: TokenDimension; cacheRead: TokenDimension }): boolean {
  return [dims.input, dims.output, dims.cacheCreation, dims.cacheRead].some((d) => d !== null);
}

// --------------------------------------------------------------------------
// Anthropic
// --------------------------------------------------------------------------

/** An Anthropic stream event (only the shapes we read). */
export interface AnthropicStreamEvent {
  type?: string;
  /** message_start carries message.usage (input + cache). */
  message?: { usage?: unknown };
  /** message_delta carries usage (cumulative output). */
  usage?: unknown;
}

/**
 * Extract final usage from an Anthropic stream.
 *
 * Merges the input/cache fields from the LAST event that carried them (normally
 * `message_start`) with the output count from the LAST event that carried it
 * (the final `message_delta`). A complete merge runs through the standard
 * adapter; a partial (error/timeout) merge with at least one real count is
 * preserved as a partial provider-reported usage; truly no counts -> unavailable.
 */
export function extractAnthropicStreamUsage(
  events: readonly AnthropicStreamEvent[],
  errorReason?: string,
): LedgerUsage {
  let inputUsage: Record<string, unknown> | undefined;
  let outputUsage: Record<string, unknown> | undefined;

  for (const event of events) {
    // message_start: message.usage carries input_tokens + cache fields.
    // B-6878: own-property guard EVERY container read (event.message, the nested
    // message.usage, event.usage). An inherited (prototype-polluted) container is
    // treated as ABSENT, so a polluted Object.prototype.message / .usage can never
    // supply a usage block.
    const message = ownProp(event, 'message') ? event.message : undefined;
    const messageUsage = message && ownProp(message, 'usage') ? (message as { usage?: unknown }).usage : undefined;
    const startUsage = isUsableUsageObject(messageUsage)
      ? (messageUsage as Record<string, unknown>)
      : undefined;
    // Own-property checks (not prototype-chain `in`) on the stream-parsed usage
    // objects. A polluted Object.prototype token key never makes a usage block
    // look like it carried that field.
    if (startUsage && (ownProp(startUsage, 'input_tokens') || ownProp(startUsage, 'cache_read_input_tokens') || ownProp(startUsage, 'cache_creation_input_tokens'))) {
      inputUsage = startUsage;
    }
    // message_delta (or any event) with a usage block carrying output_tokens.
    const eventUsage = ownProp(event, 'usage') ? event.usage : undefined;
    const deltaUsage = isUsableUsageObject(eventUsage) ? (eventUsage as Record<string, unknown>) : undefined;
    if (deltaUsage && ownProp(deltaUsage, 'output_tokens')) {
      outputUsage = deltaUsage; // keep the LAST one (terminal event wins).
    }
  }

  // Build the merged native-shaped usage object for the adapter / partial path.
  // B-6878: null-proto so a downstream adapter read of a dimension that was never
  // merged (e.g. the source carried no output_tokens) resolves to undefined, not
  // an inherited Object.prototype value. Own-property copies preserve legitimate
  // counts unchanged.
  const merged = Object.create(null) as Record<string, unknown>;
  if (inputUsage) {
    if (ownProp(inputUsage, 'input_tokens')) merged.input_tokens = inputUsage.input_tokens;
    if (ownProp(inputUsage, 'cache_creation_input_tokens')) merged.cache_creation_input_tokens = inputUsage.cache_creation_input_tokens;
    if (ownProp(inputUsage, 'cache_read_input_tokens')) merged.cache_read_input_tokens = inputUsage.cache_read_input_tokens;
  }
  if (outputUsage && ownProp(outputUsage, 'output_tokens')) {
    merged.output_tokens = outputUsage.output_tokens;
  }

  const dims = {
    input: readReportedDimension(merged.input_tokens),
    output: readReportedDimension(merged.output_tokens),
    cacheCreation: readReportedDimension(merged.cache_creation_input_tokens),
    cacheRead: readReportedDimension(merged.cache_read_input_tokens),
  };

  if (hasBothPrimaries(dims.input, dims.output)) {
    // Complete: defer to the standard adapter (full canonical mapping + digest).
    return adaptAnthropicUsage(merged);
  }
  if (anyCount(dims)) {
    // Partial (mid-stream failure): preserve what we got, never zero-fill.
    return buildPartialProviderUsage(dims, ANTHROPIC_PROVIDER_UNITS, merged);
  }
  return buildUnavailableUsage(noUsageReason('anthropic', errorReason));
}

// --------------------------------------------------------------------------
// OpenAI
// --------------------------------------------------------------------------

/** An OpenAI stream chunk (only the shapes we read). */
export interface OpenAiStreamChunk {
  usage?: unknown;
}

/**
 * Extract final usage from an OpenAI stream. OpenAI sends the usage block only
 * on the final chunk (with stream_options.include_usage). The extractor uses the
 * LAST chunk carrying a usage block. Complete -> standard adapter; partial with
 * any real count -> preserved partial; none -> unavailable.
 */
export function extractOpenAiStreamUsage(
  chunks: readonly OpenAiStreamChunk[],
  errorReason?: string,
): LedgerUsage {
  let lastUsage: unknown;
  for (const chunk of chunks) {
    // B-6878: own-property guard the CONTAINER read. An inherited (prototype-
    // polluted) Object.prototype.usage on a chunk with no OWN usage is treated as
    // ABSENT, so a polluted container never becomes the terminal usage block.
    const container = ownProp(chunk, 'usage') ? chunk.usage : undefined;
    if (isUsableUsageObject(container)) lastUsage = container; // terminal wins.
  }

  if (!isUsableUsageObject(lastUsage)) {
    return buildUnavailableUsage(noUsageReason('openai', errorReason));
  }

  // B-6878 (F-007 fix): keep a reference to the ORIGINAL terminal stream usage. The
  // whitelist PROJECTION is used ONLY for the local pollution-safe token READS
  // (primaries + the partial cacheRead belt). The COMPLETE path defers to
  // adaptOpenAiUsage, which itself project-for-reads + digests-the-ORIGINAL
  // internally (round-2 FIX A) — so we pass the ORIGINAL (not the projection) to
  // the adapter. This keeps raw.payloadDigest === payloadDigest(original terminal
  // usage): a pre-projection here would have dropped legitimate extra non-read
  // fields (total_tokens, nested audio_tokens) from the digest (a regression this
  // story introduced).
  const original = lastUsage;
  const projected = sanitizeOpenAiStreamUsage(original);
  const input = readReportedDimension(projected.prompt_tokens);
  const output = readReportedDimension(projected.completion_tokens);

  if (hasBothPrimaries(input, output)) {
    // Pass the ORIGINAL: the adapter does the internal project-for-reads +
    // digest-original, so the digest covers the original terminal usage.
    return adaptOpenAiUsage(original);
  }

  // B-6878 (belt): own-property checks, not prototype-chain `in`, on the
  // (already null-proto) projected details object.
  const cacheRead = isUsableUsageObject(projected.prompt_tokens_details) && ownProp(projected.prompt_tokens_details, 'cached_tokens')
    ? readReportedDimension((projected.prompt_tokens_details as Record<string, unknown>).cached_tokens)
    : null;
  const dims = { input, output, cacheCreation: null as TokenDimension, cacheRead };
  if (anyCount(dims)) {
    // Partial path also digests the ORIGINAL terminal usage (not the projection),
    // so a partial record's raw.payloadDigest matches the original payload too.
    return buildPartialProviderUsage(dims, OPENAI_PROVIDER_UNITS, original);
  }
  return buildUnavailableUsage(noUsageReason('openai', errorReason));
}

// --------------------------------------------------------------------------
// Gemini
// --------------------------------------------------------------------------

/** A Gemini stream chunk (only the shapes we read). */
export interface GeminiStreamChunk {
  usageMetadata?: unknown;
}

/**
 * Extract final usage from a Gemini stream. Gemini repeats usageMetadata on
 * chunks; the final chunk carries the authoritative counts. The extractor uses
 * the LAST chunk carrying usageMetadata. Complete -> standard adapter; partial
 * with any real count -> preserved partial; none -> unavailable.
 */
export function extractGeminiStreamUsage(
  chunks: readonly GeminiStreamChunk[],
  errorReason?: string,
): LedgerUsage {
  let lastMeta: unknown;
  for (const chunk of chunks) {
    // B-6878: own-property guard the CONTAINER read. An inherited (prototype-
    // polluted) Object.prototype.usageMetadata on a chunk with no OWN
    // usageMetadata is treated as ABSENT, so a polluted container never becomes
    // the terminal usageMetadata block.
    const container = ownProp(chunk, 'usageMetadata') ? chunk.usageMetadata : undefined;
    if (isUsableUsageObject(container)) lastMeta = container; // terminal wins.
  }

  if (!isUsableUsageObject(lastMeta)) {
    return buildUnavailableUsage(noUsageReason('gemini', errorReason));
  }

  // B-6878 (F-007 fix): keep a reference to the ORIGINAL terminal usageMetadata.
  // The whitelist PROJECTION is used ONLY for the local pollution-safe token READS
  // (primaries + the partial cacheRead belt). The COMPLETE path defers to
  // adaptGeminiUsage, which itself project-for-reads + digests-the-ORIGINAL
  // internally (round-2 FIX A) — so we pass the ORIGINAL (not the projection) to
  // the adapter. This keeps raw.payloadDigest === payloadDigest(original terminal
  // usageMetadata): a pre-projection here would have dropped a legitimate extra
  // non-read field (totalTokenCount) from the digest (a regression this story
  // introduced).
  const original = lastMeta;
  const meta = toOwnPropsNullProto(original, GEMINI_USAGE_WHITELIST);
  const input = readReportedDimension(meta.promptTokenCount);
  const output = readReportedDimension(meta.candidatesTokenCount);

  if (hasBothPrimaries(input, output)) {
    // Pass the ORIGINAL: the adapter does the internal project-for-reads +
    // digest-original, so the digest covers the original terminal usageMetadata.
    return adaptGeminiUsage(original);
  }

  // B-6878 (belt): own-property check, not a prototype-chain `in`, on the
  // (already null-proto) projected usageMetadata object.
  const cacheRead = ownProp(meta, 'cachedContentTokenCount') ? readReportedDimension(meta.cachedContentTokenCount) : null;
  const dims = { input, output, cacheCreation: null as TokenDimension, cacheRead };
  if (anyCount(dims)) {
    // Partial path also digests the ORIGINAL terminal usageMetadata (not the
    // projection), so a partial record's raw.payloadDigest matches the original.
    return buildPartialProviderUsage(dims, GEMINI_PROVIDER_UNITS, original);
  }
  return buildUnavailableUsage(noUsageReason('gemini', errorReason));
}
