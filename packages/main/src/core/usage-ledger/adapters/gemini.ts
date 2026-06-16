/**
 * B-08a1 CHK-003 (Slice 2): Gemini usage adapter.
 *
 * Maps a Gemini generateContent usageMetadata object into a B-253e `LedgerUsage`,
 * implementing the Gemini row of "Multi-Provider Normalization" in
 * docs/requirements/decisions/lattice-llm-usage-ledger-execution-plan.md.
 *
 * Mapping:
 *   usageMetadata.promptTokenCount        -> canonical.input
 *   usageMetadata.candidatesTokenCount    -> canonical.output
 *   usageMetadata.cachedContentTokenCount -> canonical.cacheRead
 *   canonical.cacheCreation               -> null ALWAYS
 *
 * Gemini reports cache READS via cachedContentTokenCount but never a cache WRITE
 * count, so cacheCreation is `null` (never 0). cacheRead is `null` when
 * cachedContentTokenCount is absent; a genuine `0` is preserved.
 *
 * usageMetadata.totalTokenCount is IGNORED: a stored total is forbidden by the
 * record schema (totals are summary-derived). It never reaches the record.
 *
 * raw.providerUnits = 'gemini-usage-v1'; raw.payloadDigest = sha256(usageMetadata).
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

export const GEMINI_PROVIDER_UNITS = 'gemini-usage-v1';

/** The Gemini usageMetadata shape (only the fields we read). */
export interface GeminiUsageMetadata {
  promptTokenCount?: unknown;
  candidatesTokenCount?: unknown;
  cachedContentTokenCount?: unknown;
  // totalTokenCount is intentionally NOT read — a stored total is forbidden.
}

/**
 * Map a Gemini usageMetadata object to LedgerUsage.
 *
 * No usageMetadata object -> unavailable. cacheCreation is ALWAYS null (Gemini
 * reports no cache-write count). cacheRead is null when cachedContentTokenCount
 * is absent, else the reported value (genuine 0 preserved). A missing primary
 * (e.g. candidatesTokenCount absent) -> unavailable, never inferred as 0.
 */
export function adaptGeminiUsage(rawUsageMetadata: unknown): LedgerUsage {
  if (!isUsableUsageObject(rawUsageMetadata)) {
    return buildUnavailableUsage('gemini: response carried no usageMetadata object');
  }

  const usage = rawUsageMetadata as GeminiUsageMetadata;
  const input = readPrimaryDimension(usage.promptTokenCount);
  const output = readPrimaryDimension(usage.candidatesTokenCount);

  if (!hasBothPrimaries(input, output)) {
    return buildUnavailableUsage('gemini: usageMetadata did not report both prompt and candidates token counts');
  }

  // Gemini never reports a cache-write count: cacheCreation is null, never 0.
  const cacheCreation: TokenDimension = null;
  // cacheRead from cachedContentTokenCount; absent -> null (genuine 0 preserved).
  const cacheRead = readReportedDimension(usage.cachedContentTokenCount);

  return buildProviderReportedUsage(
    { input, output, cacheCreation, cacheRead },
    GEMINI_PROVIDER_UNITS,
    rawUsageMetadata,
  );
}
