/**
 * Leaf text helpers shared by the resolved-finding guard (core/resolved-finding-guard.ts, which
 * re-exports them) and the repair re-pin (core/repair-value-change.ts, old-PoS run 68); a leaf so
 * the metadata-correction path imports no guard machinery (import-cycles ratchet).
 */

/** Whitespace- and escape-insensitive form (a test literal escapes the quotes of a probe). */
export function normalizeProbe(text: string): string {
  return text.replace(/[\s\\]+/g, '');
}

/** A test source path (Go `_test.go`, JS/TS `.test.` / `.spec.`, Python `test_*.py` / `*_test.py`, a `test(s)/` directory). */
export function isTestPath(path: string): boolean {
  return /(?:_test\.go|\.(?:test|spec)\.[cm]?[jt]sx?|(?:^|\/)test_[^/]*\.py|_test\.py)$/.test(path) || /(?:^|\/)(?:tests?|__tests__|spec)\//.test(path);
}
