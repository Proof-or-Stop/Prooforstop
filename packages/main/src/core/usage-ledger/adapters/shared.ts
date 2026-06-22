/**
 * B-08a1 (Slice 2): shared primitives for the provider usage adapters.
 *
 * Implements the cross-provider parts of "Multi-Provider Normalization" and the
 * "Required record constraints" (per-dimension absence rule, unavailable rule)
 * from docs/requirements/decisions/lattice-llm-usage-ledger-execution-plan.md.
 *
 * These helpers are PURE: no fs, no dispatch, no Date.now(). They turn a raw
 * provider usage payload into a B-253e `LedgerUsage` and never infer a value the
 * provider did not report.
 *
 * Two load-bearing rules every adapter shares:
 *   1. NO usage at all  -> usage.source='unavailable' + unavailableReason
 *      (never zeros, never a silent provider-reported record).
 *   2. A dimension the provider DID NOT report -> that canonical field is `null`
 *      (never `0`). A numeric `0` is only ever a genuine provider-reported zero.
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from '../canonical-json.js';
import type { LedgerUsage, TokenDimension, UsageCanonical } from '../record.js';

/** Stable, provider-agnostic sha256 digest of a raw usage payload. */
export function payloadDigest(rawUsage: unknown): string {
  // Deterministic key ordering so the digest is reproducible regardless of the
  // provider's key insertion order. Mirrors the writer's canonicalization.
  const digest = createHash('sha256').update(canonicalJson(rawUsage), 'utf8').digest('hex');
  return `sha256:${digest}`;
}

/**
 * Read a token dimension the provider EITHER reports as a finite non-negative
 * integer OR does not report at all.
 *
 *   - field present + valid non-negative integer -> that number (incl. genuine 0);
 *   - field absent / null / undefined            -> null (per-dimension absence);
 *   - field present but malformed (string, float, NaN, negative, Infinity)
 *     -> the value is passed through UNCHANGED as `unknown` so the B-253e
 *        validator rejects the assembled record. The adapter never coerces a
 *        malformed value into a number (no string-coercion / NaN laundering) and
 *        never silently drops it to null (which would hide a rogue payload).
 *
 * The return type is intentionally `TokenDimension | unknown`-ish: a present-but-
 * malformed value is returned verbatim so downstream validation catches it.
 */
export function readReportedDimension(value: unknown): TokenDimension {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) && value >= 0) {
    return value;
  }
  // Present but malformed (string / float / NaN / negative / Infinity): return
  // it verbatim so the assembler's validateUsageLedgerRecord rejects the
  // assembled record instead of laundering the value to null/NaN. The
  // double-cast (`unknown` first) makes the unsoundness EXPLICIT: we KNOWINGLY
  // hand back a value whose runtime type may not be `number | null`, because the
  // B-253e validator — not this reader — is the rejection point for rogue
  // payloads. Never coerce and never silently drop to null.
  return value as unknown as TokenDimension;
}

/**
 * Read a REQUIRED primary dimension (input / output). Same rules as
 * readReportedDimension, but the caller treats a `null` result (absent) as
 * "this primary dimension is missing". A provider-reported record requires BOTH
 * primaries present (the B-253e validator rejects a provider-reported record
 * whose inputTokens/outputTokens is null), so a missing primary downgrades the
 * whole record to unavailable rather than emitting an invalid provider-reported
 * record.
 */
export function readPrimaryDimension(value: unknown): TokenDimension {
  return readReportedDimension(value);
}

/**
 * Returns true when BOTH primary dimensions are present (non-null). A
 * provider-reported record is only valid when input AND output are reported; if
 * either is missing the adapter must downgrade to unavailable, never emit a
 * provider-reported record with a null primary (which the validator rejects),
 * and never infer the missing primary as 0.
 */
export function hasBothPrimaries(input: TokenDimension, output: TokenDimension): boolean {
  return input !== null && output !== null;
}

/** A canonical mapping plus the four flattened record-level token fields. */
export interface NormalizedDimensions {
  input: TokenDimension;
  output: TokenDimension;
  cacheCreation: TokenDimension;
  cacheRead: TokenDimension;
}

/**
 * Build a `provider-reported` LedgerUsage from already-mapped canonical
 * dimensions plus the raw payload for provenance. The four record-level token
 * fields mirror the canonical view 1:1 (canonical is additive, never a
 * replacement — see "Multi-Provider Normalization").
 */
export function buildProviderReportedUsage(
  dims: NormalizedDimensions,
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

/**
 * Build the single canonical `unavailable` LedgerUsage. All four token fields
 * are `null` (NEVER 0) and a non-empty reason is required. This is the ONE place
 * every adapter funnels "no usage at all" through, so the unavailable shape is
 * identical across providers.
 */
export function buildUnavailableUsage(reason: string): LedgerUsage {
  return {
    source: 'unavailable',
    inputTokens: null,
    outputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    estimator: null,
    unavailableReason: reason,
  };
}

/** True when a value is a usable usage object (non-null plain object). */
export function isUsableUsageObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
