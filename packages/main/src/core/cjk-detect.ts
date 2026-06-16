/**
 * cjk-detect — pure CJK (Han ideograph) detector.
 *
 * Single source of truth for the CJK Unicode range used by the English-only
 * artifact policy (B-5f42). The same range bounds back the diff/story-scoped
 * validate gate (english-artifact-gate.ts) and the warn-only PreToolUse hook;
 * a keep-in-sync test asserts the hook copy equals these bounds.
 *
 * The ranges match packages/main/src/tasks/english-open-source-surface-smoke.ts:
 * CJK Unified Ideographs (U+4E00..U+9FFF) plus Extension A (U+3400..U+4DBF).
 * Full-width punctuation / kana are deliberately NOT included — only Han.
 *
 * CRITICAL: this file contains NO literal CJK characters. Detection compares
 * each code point against the numeric CJK_RANGES (see isCjkCodepoint), exactly
 * like english-open-source-surface-smoke.ts, so this file passes BOTH this gate
 * and the Phase 3 English-surface gate without a self-exemption.
 */

/** A single inclusive Unicode code-point range. */
export interface CjkRange {
  readonly start: number;
  readonly end: number;
}

/**
 * The CJK ranges treated as Chinese for the English-only policy.
 * Single source of truth — re-export rather than redefine elsewhere.
 */
export const CJK_RANGES: readonly CjkRange[] = [
  { start: 0x4e00, end: 0x9fff }, // CJK Unified Ideographs
  { start: 0x3400, end: 0x4dbf }, // CJK Unified Ideographs Extension A
];

/** True if a single code point falls inside any CJK range. */
export function isCjkCodepoint(codepoint: number): boolean {
  return CJK_RANGES.some((r) => codepoint >= r.start && codepoint <= r.end);
}

/** One CJK occurrence with its 1-based line / column and the matched code point. */
export interface CjkMatch {
  readonly line: number;
  readonly col: number;
  readonly codepoint: number;
}

export interface CjkDetectResult {
  readonly found: boolean;
  readonly matches: CjkMatch[];
}

/**
 * Pure detector: scan `text` for CJK characters and report every occurrence
 * with 1-based line and column. No I/O, no side effects.
 *
 * Columns are counted in code points (so a surrogate-pair CJK character counts
 * as one column), matching the per-character iteration used to build them.
 */
export function detectCjk(text: string): CjkDetectResult {
  const matches: CjkMatch[] = [];
  if (typeof text !== 'string' || text.length === 0) {
    return { found: false, matches };
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Iterate by code point so the reported column is a code-point index, not a
    // UTF-16 unit index (CJK Extension A characters are outside the BMP).
    let col = 0;
    for (const ch of line) {
      const codepoint = ch.codePointAt(0) ?? 0;
      if (isCjkCodepoint(codepoint)) {
        matches.push({ line: i + 1, col: col + 1, codepoint });
      }
      col++;
    }
  }
  return { found: matches.length > 0, matches };
}
