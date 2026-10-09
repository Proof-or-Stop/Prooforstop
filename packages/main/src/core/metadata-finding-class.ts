/**
 * Old-PoS run 31: review findings whose cited defect lies only in Story
 * metadata (checklist.json userSees / verificationIntent text) are not product
 * defects. 10 of run 31's 13 findings restated one wrong userSees literal and
 * stale null-start intents; routed as findings they cost two repair rounds,
 * two blocked repair runs, a false closure by a code test, and a product test
 * that parsed checklist.json shipped in model.patch.
 *
 * The classification is deterministic and reads only the sealed proposal (the
 * cited files and the text), so the importer and the managed-evidence verifier
 * agree on it without repository state:
 *   - at least one cited file is Story metadata (`.proof-or-stop/...`);
 *   - the text names a checklist item (CHK-n) or a checklist.json line;
 *   - every other cited file is a test file, cited as corroboration, and the
 *     text cites no `path:line` of a non-test product file.
 * A finding that also cites product code stays a product finding (its
 * metadata part is still checked at resolve time).
 *
 * Leaf module: no imports (shared by core/evidence-chain-finding.ts, the
 * importer, the verifier and the next driver without new cycles).
 */

/** Story metadata (the PoS state directory), relative to the project root. */
export function isStoryMetadataFile(path: string): boolean {
  return /^(?:\.\/)?\.proof-or-stop\//.test(path.trim());
}

const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec|specs)\/|[._-](?:test|spec)\.[A-Za-z0-9]+$|_test\.[A-Za-z0-9]+$|(?:^|\/)test_[^/]+$/i;

/** A test file (Go `_test.go`, `*.test.ts`, `tests/...`, `test_*.py`, ...). */
export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path.trim());
}

const PATH_LINE = /([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):\d+/g;

/** `path:line` citations in a finding text. */
export function citedPathLines(text: string): string[] {
  return [...text.matchAll(PATH_LINE)].map(match => match[1]!);
}

/** Whether a review finding's cited defect lies only in Story metadata (see the module comment). */
export function isStoryMetadataFinding(finding: { files?: readonly string[] | null; desc?: string | null; category?: unknown }): boolean {
  const files = (finding.files ?? []).filter(path => typeof path === 'string' && path.trim());
  const desc = finding.desc ?? '';
  if (!files.some(isStoryMetadataFile)) return false;
  if (!/\bCHK-\d+\b/.test(desc) && !/checklist\.json:\d+/.test(desc)) return false;
  const others = files.filter(path => !isStoryMetadataFile(path));
  if (others.some(path => !isTestFile(path))) return false;
  if (others.length > 0 && citedPathLines(desc).some(path => !isStoryMetadataFile(path) && !path.endsWith('checklist.json') && !isTestFile(path))) return false;
  return true;
}
