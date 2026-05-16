/**
 * B-6812 CHK-002: story duplicate-detection helpers.
 *
 * Pure module — no I/O, no side effects. Hardens story_create's idempotency
 * (G2 in B-6812 background.md): exact-name match misses normalization
 * differences ("Fix Login" vs "fix-login") and keyword-level overlap entirely.
 *
 * Two responsibilities:
 *  - `normalizeName`  — canonicalize a story `name` so casing / separator noise
 *    does not let a semantically identical story slip past idempotency.
 *  - `keywordOverlap` — measure how much a new story's keyword set overlaps an
 *    existing story's keyword set, used to escalate full overlap into a hard
 *    block on active non-terminal stories.
 *
 * Both functions accept untrusted input (raw JSON args, possibly legacy data
 * with `name: ""` or duplicated keywords) and never throw — callers decide how
 * to act on the normalized result. The empty-normalized-name case is explicitly
 * NOT collapsed into a match by callers (see story-create.ts), so legacy
 * `name: ""` rows cannot be misjudged as the same story.
 */

/**
 * Canonicalize a story name for normalized-name idempotency comparison.
 *
 * Steps:
 *  1. lowercase
 *  2. trim outer whitespace
 *  3. collapse runs of underscores / whitespace / hyphens into a single hyphen
 *  4. strip leading and trailing hyphens
 *
 * Examples:
 *  - "Fix Login"        → "fix-login"
 *  - "  fix_login  "    → "fix-login"
 *  - "fix---login"      → "fix-login"
 *  - "FIX__LOGIN"       → "fix-login"
 *  - ""                 → ""        (empty input)
 *  - "@@@"              → ""        (all-special-character input)
 *  - "café-Story"       → "café-story" (Unicode letters preserved, only cased)
 *
 * Non-string input (defensive against bypassing-Zod call paths) is treated as
 * an empty string and returns "".
 */
export function normalizeName(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .trim()
    // Collapse any run of underscores, whitespace, or hyphens into one hyphen.
    .replace(/[_\s-]+/g, '-')
    // Drop hyphens left dangling at either end after the collapse above.
    .replace(/^-+|-+$/g, '');
}

export interface KeywordOverlapResult {
  /** Keywords present in BOTH the new and existing sets (deduplicated). */
  shared: string[];
  /**
   * shared.length / dedup(newKeywords).length.
   * 0 when the new keyword set is empty (no division by zero).
   * 1 means every distinct new keyword is also in the existing set.
   */
  ratio: number;
}

/**
 * Normalize one keyword for overlap comparison: must be a non-empty string
 * after trimming. Returns null for anything else (non-string / blank).
 */
function normKeyword(k: unknown): string | null {
  if (typeof k !== 'string') return null;
  const t = k.trim().toLowerCase();
  return t.length > 0 ? t : null;
}

/**
 * Deduplicate a keyword list down to its set of valid normalized keywords.
 * Drops non-string / blank entries so malformed legacy JSON cannot inflate or
 * deflate the ratio.
 */
function dedupKeywords(keywords: unknown): string[] {
  if (!Array.isArray(keywords)) return [];
  const seen = new Set<string>();
  for (const k of keywords) {
    const nk = normKeyword(k);
    if (nk !== null) seen.add(nk);
  }
  return [...seen];
}

/**
 * Compute keyword overlap between a new story's keywords and an existing
 * story's keywords.
 *
 * `ratio = shared.length / dedup(newKeywords).length`. Critically the
 * denominator is the DEDUPLICATED new keyword set, so a caller passing
 * `["x","x","y"]` against `["x","y"]` gets ratio 1 (full overlap), not an
 * inflated/deflated value from the duplicate `"x"`.
 *
 * Empty (or all-invalid) `newKeywords` yields `{ shared: [], ratio: 0 }` —
 * never NaN — so callers can treat 0 as "no overlap signal".
 */
export function keywordOverlap(
  newKeywords: unknown,
  existingKeywords: unknown,
): KeywordOverlapResult {
  const newSet = dedupKeywords(newKeywords);
  if (newSet.length === 0) return { shared: [], ratio: 0 };

  const existingSet = new Set(dedupKeywords(existingKeywords));
  const shared = newSet.filter((k) => existingSet.has(k));
  return { shared, ratio: shared.length / newSet.length };
}
