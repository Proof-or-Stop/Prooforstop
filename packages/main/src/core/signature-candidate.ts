/**
 * B-5d48 CHK-001 (Experience Layer ③.2): pure candidate-derivation leaf.
 *
 * This module is a LEAF: it has ZERO outward imports (only `node:` builtins are
 * permitted, and none are needed today — pure string work). It turns a finding's
 * coarse fields (category / files / desc) into a DETERMINISTIC fallback
 * `signatureTag` for the case where the reviewer (or an LLM) did not supply one.
 *
 * IMPORTANT: this is a FALLBACK only. The mechanical candidate is a low-quality
 * placeholder; real grouping quality comes from a CONFIRMED tag (reviewer/LLM).
 * Persisting the candidate is audit-only and MUST NOT enter any finding _hash /
 * signature or any gate decision — that wiring lives in handlers/finding.ts.
 *
 * Determinism contract: same (category, files, desc) => byte-identical output
 * across calls. Tolerates missing/empty/dirty inputs (never throws, never returns
 * an empty string — falls back to `${cat}|${fileKind}|` with empty descKey).
 */

/**
 * A small, conservative English stopword set. Removing these keeps the descKey
 * focused on the distinctive tokens of a finding while staying deterministic.
 */
const STOPWORDS = new Set<string>([
  'this',
  'that',
  'with',
  'from',
  'into',
  'over',
  'under',
  'when',
  'then',
  'than',
  'have',
  'will',
  'shall',
  'should',
  'would',
  'could',
  'must',
  'does',
  'done',
  'been',
  'being',
  'were',
  'where',
  'which',
  'while',
  'about',
  'after',
  'before',
  'because',
  'there',
  'their',
  'these',
  'those',
  'here',
  'each',
  'such',
  'some',
  'only',
  'also',
  'else',
  'just',
  'very',
  'more',
  'most',
  'they',
  'them',
  'your',
  'ours',
  'mine',
  'null',
]);

/**
 * Coarse file-kind bucket for the first usable file path: its extension (without
 * the leading dot) if any, else its first path segment, else 'unknown'. Inputs
 * are filtered to non-empty strings first, so non-string/empty/missing entries
 * are tolerated.
 */
function deriveFileKind(files?: string[]): string {
  if (!Array.isArray(files)) return 'unknown';
  const first = files.find((f): f is string => typeof f === 'string' && f.trim().length > 0);
  if (!first) return 'unknown';
  const path = first.trim();
  // Extension: the part after the last dot of the final segment, if non-empty.
  const lastSegment = path.split('/').filter((s) => s.length > 0).pop() ?? '';
  const dotIdx = lastSegment.lastIndexOf('.');
  if (dotIdx > 0 && dotIdx < lastSegment.length - 1) {
    const ext = lastSegment.slice(dotIdx + 1).toLowerCase();
    if (ext.length > 0) return ext;
  }
  // No usable extension: first path segment.
  const firstSegment = path.split('/').find((s) => s.length > 0);
  return firstSegment ? firstSegment.toLowerCase() : 'unknown';
}

/**
 * Normalize a description into a compact key: lowercase, strip punctuation,
 * drop stopwords, then join the first ~3 distinctive tokens (length >= 4) with
 * '-'. May be empty (no qualifying tokens) — that is allowed.
 */
function deriveDescKey(desc?: string): string {
  if (typeof desc !== 'string' || desc.length === 0) return '';
  const tokens = desc
    .toLowerCase()
    // Replace any run of non-alphanumeric chars with a single space (strips punctuation).
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
  return tokens.slice(0, 3).join('-');
}

/**
 * Derive a deterministic fallback signatureTag candidate from a finding's coarse
 * fields. Shape: `${cat}|${fileKind}|${descKey}`. Never throws, never returns ''.
 *
 * @param category finding category bucket; trimmed, defaults to 'unknown'.
 * @param files    finding file paths; non-string/empty/missing entries tolerated.
 * @param desc     finding description; used for the normalized descKey.
 */
export function deriveSignatureCandidate(category?: string, files?: string[], desc?: string): string {
  const cat = (typeof category === 'string' ? category.trim() : '').toLowerCase() || 'unknown';
  const fileKind = deriveFileKind(files);
  const descKey = deriveDescKey(desc);
  return `${cat}|${fileKind}|${descKey}`;
}
