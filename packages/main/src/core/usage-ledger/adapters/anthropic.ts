/**
 * B-08a1 CHK-001 (Slice 2): Anthropic usage adapter.
 *
 * Maps an Anthropic Messages API usage object into a B-253e `LedgerUsage`,
 * implementing the Anthropic row of "Multi-Provider Normalization" in
 * docs/requirements/decisions/lattice-llm-usage-ledger-execution-plan.md.
 *
 * Native four-field mapping (Anthropic reports all four natively):
 *   input_tokens               -> canonical.input        (uncached remainder)
 *   output_tokens              -> canonical.output
 *   cache_creation_input_tokens-> canonical.cacheCreation
 *   cache_read_input_tokens    -> canonical.cacheRead
 *
 * raw.providerUnits = 'anthropic-usage-v1'; raw.payloadDigest = sha256(usage).
 *
 * PURE: no fs, no dispatch, no Date.now(). It never infers a value Anthropic did
 * not report and never coerces "no usage" into zeros.
 */

import type { LedgerUsage } from '../record.js';
import {
  buildProviderReportedUsage,
  buildUnavailableUsage,
  hasBothPrimaries,
  isUsableUsageObject,
  readPrimaryDimension,
  readReportedDimension,
} from './shared.js';

export const ANTHROPIC_PROVIDER_UNITS = 'anthropic-usage-v1';

/** The Anthropic Messages API usage shape (only the fields we read). */
export interface AnthropicUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
}

/**
 * Map an Anthropic usage object to LedgerUsage.
 *
 * No usage object (null/undefined/non-object) -> source='unavailable' with a
 * reason. When either primary (input or output) is absent the record is also
 * unavailable — a provider-reported record with a null primary input/output is
 * invalid per B-253e, and a missing primary must never be inferred as 0.
 */
export function adaptAnthropicUsage(rawUsage: unknown): LedgerUsage {
  if (!isUsableUsageObject(rawUsage)) {
    return buildUnavailableUsage('anthropic: response carried no usage object');
  }

  const usage = rawUsage as AnthropicUsage;
  const input = readPrimaryDimension(usage.input_tokens);
  const output = readPrimaryDimension(usage.output_tokens);

  // A missing primary count -> unavailable, never zeros, never a null primary on
  // a provider-reported record.
  if (!hasBothPrimaries(input, output)) {
    return buildUnavailableUsage('anthropic: usage object did not report both input and output token counts');
  }

  // Anthropic reports both cache dimensions natively; absent -> null (never 0).
  const cacheCreation = readReportedDimension(usage.cache_creation_input_tokens);
  const cacheRead = readReportedDimension(usage.cache_read_input_tokens);

  return buildProviderReportedUsage(
    { input, output, cacheCreation, cacheRead },
    ANTHROPIC_PROVIDER_UNITS,
    rawUsage,
  );
}
