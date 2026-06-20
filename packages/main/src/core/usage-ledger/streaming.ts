/**
 * B-08a1 CHK-005 (Slice 2): streaming / failure usage extraction.
 *
 * Implements "Streaming and failure usage capture" from
 * docs/requirements/decisions/lattice-llm-usage-ledger-execution-plan.md.
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
import { adaptOpenAiUsage, OPENAI_PROVIDER_UNITS } from './adapters/openai.js';
import { adaptGeminiUsage, GEMINI_PROVIDER_UNITS } from './adapters/gemini.js';
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
 * usage object is projected through toOwnPropsNullProto here before any dot-read,
 * making every downstream read (primaries, cacheRead, the adapter call) operate on
 * a null-proto, whitelist-only object — safe by construction, mirroring assemble.
 * Enumerated directly from the adapters.
 */
const OPENAI_STREAM_WHITELIST = ['prompt_tokens', 'completion_tokens', 'prompt_tokens_details'] as const;
const OPENAI_STREAM_NESTED_DETAIL_WHITELIST = ['cached_tokens'] as const;
const GEMINI_STREAM_WHITELIST = ['promptTokenCount', 'candidatesTokenCount', 'cachedContentTokenCount'] as const;

/** Project an openai stream usage object (incl. nested details) to null-proto. */
function sanitizeOpenAiStreamUsage(raw: unknown): Record<string, unknown> {
  const projected = toOwnPropsNullProto(raw, OPENAI_STREAM_WHITELIST);
  const nested = projected.prompt_tokens_details;
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    projected.prompt_tokens_details = toOwnPropsNullProto(nested, OPENAI_STREAM_NESTED_DETAIL_WHITELIST);
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
    const startUsage = event.message && isUsableUsageObject(event.message.usage)
      ? (event.message.usage as Record<string, unknown>)
      : undefined;
    // B-6878 (belt): own-property checks, not prototype-chain `in`, on the
    // stream-parsed usage objects. A polluted Object.prototype token key never
    // makes a usage block look like it carried that field.
    if (startUsage && (ownProp(startUsage, 'input_tokens') || ownProp(startUsage, 'cache_read_input_tokens') || ownProp(startUsage, 'cache_creation_input_tokens'))) {
      inputUsage = startUsage;
    }
    // message_delta (or any event) with a usage block carrying output_tokens.
    const deltaUsage = isUsableUsageObject(event.usage) ? (event.usage as Record<string, unknown>) : undefined;
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
    if (isUsableUsageObject(chunk.usage)) lastUsage = chunk.usage; // terminal wins.
  }

  if (!isUsableUsageObject(lastUsage)) {
    return buildUnavailableUsage(noUsageReason('openai', errorReason));
  }

  // B-6878: project to a null-proto, whitelist-only object before any read.
  const usage = sanitizeOpenAiStreamUsage(lastUsage);
  const input = readReportedDimension(usage.prompt_tokens);
  const output = readReportedDimension(usage.completion_tokens);

  if (hasBothPrimaries(input, output)) {
    return adaptOpenAiUsage(usage);
  }

  // B-6878 (belt): own-property checks, not prototype-chain `in`, on the
  // (already null-proto) details object.
  const cacheRead = isUsableUsageObject(usage.prompt_tokens_details) && ownProp(usage.prompt_tokens_details, 'cached_tokens')
    ? readReportedDimension((usage.prompt_tokens_details as Record<string, unknown>).cached_tokens)
    : null;
  const dims = { input, output, cacheCreation: null as TokenDimension, cacheRead };
  if (anyCount(dims)) {
    return buildPartialProviderUsage(dims, OPENAI_PROVIDER_UNITS, usage);
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
    if (isUsableUsageObject(chunk.usageMetadata)) lastMeta = chunk.usageMetadata; // terminal wins.
  }

  if (!isUsableUsageObject(lastMeta)) {
    return buildUnavailableUsage(noUsageReason('gemini', errorReason));
  }

  // B-6878: project to a null-proto, whitelist-only object before any read.
  const meta = toOwnPropsNullProto(lastMeta, GEMINI_STREAM_WHITELIST);
  const input = readReportedDimension(meta.promptTokenCount);
  const output = readReportedDimension(meta.candidatesTokenCount);

  if (hasBothPrimaries(input, output)) {
    return adaptGeminiUsage(meta);
  }

  // B-6878 (belt): own-property check, not a prototype-chain `in`, on the
  // stream-parsed usageMetadata object.
  const cacheRead = ownProp(meta, 'cachedContentTokenCount') ? readReportedDimension(meta.cachedContentTokenCount) : null;
  const dims = { input, output, cacheCreation: null as TokenDimension, cacheRead };
  if (anyCount(dims)) {
    return buildPartialProviderUsage(dims, GEMINI_PROVIDER_UNITS, meta);
  }
  return buildUnavailableUsage(noUsageReason('gemini', errorReason));
}
