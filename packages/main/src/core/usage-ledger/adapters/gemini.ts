/**
 * B-08a1 CHK-003 (Slice 2): Gemini usage adapter.
 *
 * Maps a Gemini generateContent usageMetadata object into a B-253e `LedgerUsage`,
 * implementing the Gemini row of "Multi-Provider Normalization" in
 * docs/requirements/decisions/proof-or-stop-llm-usage-ledger-execution-plan.md.
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
import { toOwnPropsNullProto } from '../sanitize.js';

export const GEMINI_PROVIDER_UNITS = 'gemini-usage-v1';

/**
 * B-6878: the ONLY token keys this adapter reads off a Gemini usageMetadata
 * object. The reads below go through a null-proto, whitelist-only PROJECTION so a
 * prototype-polluted token key can never be resolved via inheritance. The
 * ORIGINAL raw usageMetadata is fed to the digest, so raw.payloadDigest stays
 * byte-identical to pre-B-6878 for any un-polluted payload, including one carrying
 * legitimate extra non-read fields (e.g. totalTokenCount, which is also excluded
 * from the record by design).
 */
export const GEMINI_USAGE_WHITELIST = [
  'promptTokenCount',
  'candidatesTokenCount',
  'cachedContentTokenCount',
] as const;

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

  // B-6878: read token fields through a null-proto, whitelist-only projection so
  // an inherited (prototype-polluted) token key can never be resolved. The
  // ORIGINAL rawUsageMetadata is passed to the digest below (extra fields kept).
  const projected = toOwnPropsNullProto(rawUsageMetadata, GEMINI_USAGE_WHITELIST);
  const input = readPrimaryDimension(projected.promptTokenCount);
  const output = readPrimaryDimension(projected.candidatesTokenCount);

  if (!hasBothPrimaries(input, output)) {
    return buildUnavailableUsage('gemini: usageMetadata did not report both prompt and candidates token counts');
  }

  // Gemini never reports a cache-write count: cacheCreation is null, never 0.
  const cacheCreation: TokenDimension = null;
  // cacheRead from cachedContentTokenCount; absent -> null (genuine 0 preserved).
  const cacheRead = readReportedDimension(projected.cachedContentTokenCount);

  return buildProviderReportedUsage(
    { input, output, cacheCreation, cacheRead },
    GEMINI_PROVIDER_UNITS,
    // Digest the ORIGINAL raw usageMetadata, NOT the projection: byte-identical to
    // pre-B-6878 (canonicalJson uses own-enumerable keys, already pollution-safe).
    rawUsageMetadata,
  );
}
