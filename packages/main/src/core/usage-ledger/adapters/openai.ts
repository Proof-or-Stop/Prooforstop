/**
 * B-08a1 CHK-002 (Slice 2): OpenAI / codex usage adapter.
 *
 * Maps an OpenAI Chat/Responses API usage object into a B-253e `LedgerUsage`,
 * implementing the OpenAI row of "Multi-Provider Normalization" in
 * docs/requirements/decisions/lattice-llm-usage-ledger-execution-plan.md.
 *
 * Mapping:
 *   usage.prompt_tokens                          -> canonical.input
 *   usage.completion_tokens                      -> canonical.output
 *   usage.prompt_tokens_details.cached_tokens    -> canonical.cacheRead
 *   canonical.cacheCreation                      -> null ALWAYS
 *
 * OpenAI reports cache READS (cached_tokens) but never a cache WRITE count, so
 * cacheCreation is `null` (never 0) — the spec's "a value the provider does not
 * report must not be inferred". cacheRead is `null` when prompt_tokens_details is
 * absent or the cached_tokens key is missing; a genuine `0` is preserved.
 *
 * raw.providerUnits = 'openai-usage-v1'; raw.payloadDigest = sha256(usage).
 *
 * PURE: no fs, no dispatch, no Date.now().
 */

import type { LedgerUsage, TokenDimension } from '../record.js';
import {
  buildProviderReportedUsage,
  buildUnavailableUsage,
  hasBothPrimaries,
  isUsableUsageObject,
  readPrimaryDimension,
  readReportedDimension,
} from './shared.js';
import { toOwnPropsNullProto } from '../sanitize.js';

export const OPENAI_PROVIDER_UNITS = 'openai-usage-v1';

/**
 * B-6878: the ONLY token keys this adapter reads off an OpenAI usage object at the
 * top level. prompt_tokens_details is read for its nested cached_tokens (see
 * OPENAI_NESTED_DETAIL_WHITELIST). The reads below go through a null-proto,
 * whitelist-only PROJECTION; the ORIGINAL raw usage is fed to the digest so
 * raw.payloadDigest stays byte-identical to pre-B-6878 for any un-polluted
 * payload, including one carrying legitimate extra non-read fields (e.g.
 * total_tokens).
 */
export const OPENAI_USAGE_WHITELIST = [
  'prompt_tokens',
  'completion_tokens',
  'prompt_tokens_details',
] as const;

/** The ONLY nested key this adapter reads off prompt_tokens_details. */
export const OPENAI_NESTED_DETAIL_WHITELIST = ['cached_tokens'] as const;

/** The OpenAI usage shape (only the fields we read). */
export interface OpenAiUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  prompt_tokens_details?: unknown;
}

/**
 * Map an OpenAI usage object to LedgerUsage.
 *
 * No usage object -> unavailable. cacheCreation is ALWAYS null (OpenAI reports
 * no cache-write count). cacheRead is null when prompt_tokens_details / its
 * cached_tokens key is absent, else the reported value (genuine 0 preserved).
 */
export function adaptOpenAiUsage(rawUsage: unknown): LedgerUsage {
  if (!isUsableUsageObject(rawUsage)) {
    return buildUnavailableUsage('openai: response carried no usage object');
  }

  // B-6878: read token fields through a null-proto, whitelist-only projection so
  // an inherited (prototype-polluted) token key can never be resolved. The
  // ORIGINAL rawUsage is passed to the digest below (extra non-read fields kept).
  const projected = toOwnPropsNullProto(rawUsage, OPENAI_USAGE_WHITELIST);
  const input = readPrimaryDimension(projected.prompt_tokens);
  const output = readPrimaryDimension(projected.completion_tokens);

  if (!hasBothPrimaries(input, output)) {
    return buildUnavailableUsage('openai: usage object did not report both prompt and completion token counts');
  }

  // OpenAI never reports a cache-write count: cacheCreation is null, never 0.
  const cacheCreation: TokenDimension = null;
  // cacheRead comes ONLY from prompt_tokens_details.cached_tokens. Absent
  // details object OR missing cached_tokens key -> null (per-dimension absence).
  const cacheRead = readOpenAiCacheRead(projected.prompt_tokens_details);

  return buildProviderReportedUsage(
    { input, output, cacheCreation, cacheRead },
    OPENAI_PROVIDER_UNITS,
    // Digest the ORIGINAL raw usage, NOT the projection: byte-identical to
    // pre-B-6878 (canonicalJson uses own-enumerable keys, so already pollution-safe).
    rawUsage,
  );
}

/**
 * Extract cacheRead from prompt_tokens_details. Returns null when the details
 * object is absent/not-an-object or when it lacks a cached_tokens key — a
 * missing key is per-dimension absence (null), NOT an inferred 0. A genuine
 * numeric 0 from the provider is preserved.
 */
function readOpenAiCacheRead(details: unknown): TokenDimension {
  if (!isUsableUsageObject(details)) return null;
  // B-6878: project the nested details to a null-proto, cached_tokens-only object
  // so a prototype-polluted Object.prototype.cached_tokens can never be resolved
  // via inheritance on a details object that lacks its own cached_tokens. An
  // absent own cached_tokens projects to undefined -> readReportedDimension -> null
  // (per-dimension absence, never an inferred 0). A genuine own 0 is preserved.
  const nested = toOwnPropsNullProto(details, OPENAI_NESTED_DETAIL_WHITELIST);
  if (nested.cached_tokens === undefined) return null;
  return readReportedDimension(nested.cached_tokens);
}
