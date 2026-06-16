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

export const OPENAI_PROVIDER_UNITS = 'openai-usage-v1';

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

  const usage = rawUsage as OpenAiUsage;
  const input = readPrimaryDimension(usage.prompt_tokens);
  const output = readPrimaryDimension(usage.completion_tokens);

  if (!hasBothPrimaries(input, output)) {
    return buildUnavailableUsage('openai: usage object did not report both prompt and completion token counts');
  }

  // OpenAI never reports a cache-write count: cacheCreation is null, never 0.
  const cacheCreation: TokenDimension = null;
  // cacheRead comes ONLY from prompt_tokens_details.cached_tokens. Absent
  // details object OR missing cached_tokens key -> null (per-dimension absence).
  const cacheRead = readOpenAiCacheRead(usage.prompt_tokens_details);

  return buildProviderReportedUsage(
    { input, output, cacheCreation, cacheRead },
    OPENAI_PROVIDER_UNITS,
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
  if (!('cached_tokens' in details)) return null;
  return readReportedDimension(details.cached_tokens);
}
