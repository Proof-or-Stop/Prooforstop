#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { analyzeDeletedSymbols, checkConcept, renderConceptResult, scanDeletedSymbols } from '../handlers/validate-concept.js';

function fileDiff(path: string, oldSource: string, newSource: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    ...oldSource.split('\n').map((line) => `-${line}`),
    ...newSource.split('\n').map((line) => `+${line}`),
  ].join('\n');
}

function renamedFileDiff(oldPath: string, newPath: string, oldSource: string, newSource: string): string {
  return [
    `diff --git a/${oldPath} b/${newPath}`,
    `--- a/${oldPath}`,
    `+++ b/${newPath}`,
    '@@ -1 +1 @@',
    ...oldSource.split('\n').map((line) => `-${line}`),
    ...newSource.split('\n').map((line) => `+${line}`),
  ].join('\n');
}

function devNullDiff(path: string, side: 'addition' | 'deletion', source: string): string {
  const deleting = side === 'deletion';
  return [
    `diff --git a/${path} b/${path}`,
    deleting ? `--- a/${path}` : '--- /dev/null',
    deleting ? '+++ /dev/null' : `+++ b/${path}`,
    '@@ -1 +1 @@',
    ...source.split('\n').map((line) => `${deleting ? '-' : '+'}${line}`),
  ].join('\n');
}

function metadataDiff(
  kind: 'copy' | 'rename',
  oldPath: string,
  newPath: string,
  oldSource: string,
  newSource: string,
): string {
  return [
    `diff --git a/${oldPath} b/${newPath}`,
    `${kind} from ${oldPath}`,
    `${kind} to ${newPath}`,
    `--- a/${oldPath}`,
    `+++ b/${newPath}`,
    '@@ -1 +1 @@',
    ...oldSource.split('\n').map((line) => `-${line}`),
    ...newSource.split('\n').map((line) => `+${line}`),
  ].join('\n');
}

const deletedExport = fileDiff(
  'src/old.ts',
  'export function audit_resources() { return true; }',
  '',
);
const grepOutput = [
  './.proof-or-stop/activity.jsonl:1:{"tool":"finding_add","args":{"desc":"audit_resources"}}',
  './docs/story/actives/B-smoke/findings.json:2:"audit_resources residual"',
  './packages/main/tests/fixtures/concept.json:3:"audit_resources fixture mention"',
  './src/live.ts:4:export const stillThere = audit_resources();',
].join('\n');
const result = checkConcept({
  projectRoot: '/tmp/unused',
  gitDiffReader: () => deletedExport,
  grepReader: () => grepOutput,
});
assert.deepEqual(result.deletedSymbols, ['audit_resources']);
assert.equal(result.residuals.length, 1);
assert.equal(result.residuals[0]?.file, 'src/live.ts');
assert.match(renderConceptResult({ ...result, status: 'fail', recommendation: 'dispatch proof-or-stop-review-concept' }), /standalone validate --concept only reports raw residuals/);

const headerlessFragment = '-export function headerlessRemoved() { return true; }';
const headerlessAnalysis = analyzeDeletedSymbols(headerlessFragment);
assert.deepEqual(headerlessAnalysis.symbols, ['headerlessRemoved'], 'legacy headerless fragments retain __fragment__.ts declaration parsing');
assert.deepEqual(headerlessAnalysis.diagnostics, []);
let headerlessGrepSeen = false;
const headerlessConcept = checkConcept({
  projectRoot: '/tmp/unused',
  gitDiffReader: () => headerlessFragment,
  grepReader: ({ symbol }) => {
    headerlessGrepSeen = symbol === 'headerlessRemoved';
    return './src/live.ts:1:headerlessRemoved();';
  },
});
assert.equal(headerlessGrepSeen, true, 'headerless deleted symbols still flow through residual grep');
assert.deepEqual(headerlessConcept.deletedSymbols, ['headerlessRemoved']);
assert.equal(headerlessConcept.residuals.length, 1);

const emptyFragmentAnalysis = analyzeDeletedSymbols('');
assert.deepEqual(emptyFragmentAnalysis.symbols, []);
assert.deepEqual(emptyFragmentAnalysis.diagnostics, [], 'empty headerless input is an empty diff, not a malformed fragment');

const malformedPseudoHeader = analyzeDeletedSymbols([
  'diff --git "a/src/broken.ts" "b/src/broken.ts',
  '-export function pseudoHeaderMustNotFallback() { return true; }',
].join('\n'));
assert.deepEqual(malformedPseudoHeader.symbols, [], 'presence of a malformed diff header token disables legacy fragment fallback');
assert.ok(malformedPseudoHeader.diagnostics.some(diagnostic => /diff path:.*closing quote/.test(diagnostic)));

for (const structuredToken of [
  'diff --git',
  'diff --git\ta/src/tab.ts\tb/src/tab.ts',
  '--- a/src/orphan.ts',
  '+++ b/src/orphan.ts',
  '@@ -1 +1 @@',
  'rename from src/orphan.ts',
  'rename to src/orphan.ts',
  'copy from src/orphan.ts',
  'copy to src/orphan.ts',
  'Binary files a/src/orphan.ts and b/src/orphan.ts differ',
  'GIT binary patch',
  'index 1234567..89abcde 100644',
  'new file mode 100644',
  'deleted file mode 100644',
  'old mode 100644',
  'new mode 100755',
  'similarity index 100%',
  'dissimilarity index 100%',
]) {
  const analysis = analyzeDeletedSymbols([
    structuredToken,
    '-export function structuredTokenMustNotFallback() { return true; }',
  ].join('\n'));
  assert.deepEqual(analysis.symbols, [], `${structuredToken} disables legacy headerless fallback`);
  assert.ok(analysis.diagnostics.length > 0, `${structuredToken} receives a focused pre-header/malformed diagnostic`);
}

const observedBodyOnly = fileDiff(
  'src/observed.ts',
  [
    'export function buildQueryGroups(input: string) { return [input]; }',
    'export const candidateReadBindingErrors = (input: string) => [input];',
    'export async function defaultHostRunRunner() { return true; }',
  ].join('\n'),
  [
    'export function buildQueryGroups(input: string) { return input ? [input] : []; }',
    'export const candidateReadBindingErrors = (input: string) => input ? [input] : [];',
    'export async function defaultHostRunRunner() { await Promise.resolve(); return true; }',
  ].join('\n'),
);
assert.deepEqual(scanDeletedSymbols(observedBodyOnly), [], 'the three observed body-only edits retain declaration identity');

const supportedBodyOnly = fileDiff(
  'src/supported.ts',
  [
    'function localFn(value: string): string { return value; }',
    'async function localAsync(): Promise<boolean> { return true; }',
    'function* localGenerator(): Generator<number> { yield 1; }',
    'const localArrow = (value: number): number => value;',
    'export class Runner {',
    '  constructor(value: number) { this.value = value; }',
    '  value: number;',
    '  run(value: string): string { return value; }',
    '}',
  ].join('\n'),
  [
    'function localFn(value: string): string { return value.trim(); }',
    'async function localAsync(): Promise<boolean> { await Promise.resolve(); return true; }',
    'function* localGenerator(): Generator<number> { yield 2; }',
    'const localArrow = (value: number): number => value + 1;',
    'export class Runner {',
    '  constructor(value: number) { this.value = value + 1; }',
    '  value: number;',
    '  run(value: string): string { return value.trim(); }',
    '}',
  ].join('\n'),
);
assert.deepEqual(scanDeletedSymbols(supportedBodyOnly), [], 'body-only changes pair across all supported TypeScript declaration forms');

const signatureReplacement = fileDiff(
  'src/signatures.ts',
  [
    'export function changed(value: string): string { return value; }',
    'class Example {',
    '  method(value: string): string { return value; }',
    '  constructor(value: string) {}',
    '}',
  ].join('\n'),
  [
    'export function changed(value: number): number { return value; }',
    'class Example {',
    '  method(value: number): number { return value; }',
    '  constructor(value: number) {}',
    '}',
  ].join('\n'),
);
assert.deepEqual(
  scanDeletedSymbols(signatureReplacement),
  [],
  'same file/scope/kind/name continuity treats signature changes as retained names',
);

const overloadRemoval = fileDiff(
  'src/overload.ts',
  [
    'export function overload(value: string): string;',
    'export function overload(value: number): number;',
    'export function overload(value: string | number): string | number { return value; }',
  ].join('\n'),
  [
    'export function overload(value: number): number;',
    'export function overload(value: string | number): string | number { return value; }',
  ].join('\n'),
);
assert.deepEqual(scanDeletedSymbols(overloadRemoval), ['overload'], 'one removed overload cannot be hidden by a same-name survivor');

const overloadReplacement = fileDiff(
  'src/overload-replacement.ts',
  [
    'export function overload(value: string): string;',
    'export function overload(value: number): number;',
    'export function overload(value: string | number): string | number { return value; }',
  ].join('\n'),
  [
    'export function overload(value: boolean): boolean;',
    'export function overload(value: number): number;',
    'export function overload(value: boolean | number): boolean | number { return value; }',
  ].join('\n'),
);
assert.deepEqual(
  scanDeletedSymbols(overloadReplacement),
  ['overload'],
  'same-count overload replacement detects the removed declaration signature',
);

const reorderedOverloads = fileDiff(
  'src/overload-reordered.ts',
  [
    'export function overload(value: string): string;',
    'export function overload(value: number): number;',
    'export function overload(value: string | number): string | number { return value; }',
  ].join('\n'),
  [
    'export function overload(value: number): number;',
    'export function overload(value: string): string;',
    'export function overload(value: string | number): string | number { return value; }',
  ].join('\n'),
);
assert.deepEqual(scanDeletedSymbols(reorderedOverloads), [], 'unchanged overload signatures pair regardless of declaration order');

const crossFile = [
  fileDiff('src/a.ts', 'export function shared(value: string): string { return value; }', ''),
  fileDiff(
    'src/b.ts',
    'export function shared(value: string): string { return value; }',
    'export function shared(value: string): string { return value.trim(); }',
  ),
].join('\n');
assert.deepEqual(scanDeletedSymbols(crossFile), ['shared'], 'a same-name declaration in another file cannot cancel a true deletion');

const mixedSourceAndArtifacts = [
  fileDiff('docs/requirements/baseline.json', '{"not": "typescript"}', '{"still": "not typescript"}'),
  fileDiff('docs/requirements/plan.md', '# function pretendDeleted() {', '# replacement prose'),
  fileDiff('src/real.ts', 'export function realDeletion() { return true; }', ''),
].join('\n');
const mixedAnalysis = analyzeDeletedSymbols(mixedSourceAndArtifacts);
assert.deepEqual(mixedAnalysis.symbols, ['realDeletion'], 'non-source artifacts are ignored while supported source deletions remain visible');
assert.deepEqual(mixedAnalysis.diagnostics, [], 'JSON and Markdown content cannot create declaration parse diagnostics');

for (const [oldPath, source, symbol] of [
  ['src/renamed.ts', 'export function removedTs() { return true; }', 'removedTs'],
  ['src/renamed.js', 'export function removedJs() { return true; }', 'removedJs'],
  ['src/renamed.py', 'def removed_py():\n    return True', 'removed_py'],
] as const) {
  const analysis = analyzeDeletedSymbols(renamedFileDiff(oldPath, 'docs/renamed.md', source, '# prose'));
  assert.deepEqual(analysis.symbols, [symbol], `${oldPath} to unsupported rename remains a deletion`);
  assert.deepEqual(analysis.diagnostics, []);
}

const unsupportedToSupported = analyzeDeletedSymbols(renamedFileDiff(
  'docs/new-source.md',
  'src/new-source.ts',
  '# prose',
  'export function newlyAdded() { return true; }',
));
assert.deepEqual(unsupportedToSupported.symbols, [], 'unsupported to supported rename is an addition, not a deletion');
assert.deepEqual(unsupportedToSupported.diagnostics, []);

const supportedRename = analyzeDeletedSymbols(renamedFileDiff(
  'src/old-name.ts',
  'src/new-name.ts',
  'export function movedDeclaration() { return true; }',
  'export function movedDeclaration() { return true; }',
));
assert.deepEqual(supportedRename.symbols, ['movedDeclaration'], 'supported path rename preserves path-bound deletion identity');
assert.deepEqual(supportedRename.diagnostics, []);

assert.deepEqual(
  analyzeDeletedSymbols(devNullDiff('src/deleted.ts', 'deletion', 'export function deletedFileSymbol() { return true; }')).symbols,
  ['deletedFileSymbol'],
  'a supported file deletion through /dev/null remains visible',
);
assert.deepEqual(
  analyzeDeletedSymbols(devNullDiff('src/added.ts', 'addition', 'export function addedFileSymbol() { return true; }')).symbols,
  [],
  'a supported file addition through /dev/null is not a deletion',
);

const pureCopy = [
  'diff --git a/src/original.ts b/src/copied.ts',
  'similarity index 100%',
  'copy from src/original.ts',
  'copy to src/copied.ts',
].join('\n');
assert.deepEqual(scanDeletedSymbols(pureCopy), [], 'a pure copy is an addition while the original declaration survives');

const quotedMetadataCopy = [
  'diff --git "a/src/original\\tfile.ts" "b/src/copied\\tfile.ts"',
  'copy from "src/original\\tfile.ts"',
  'copy to "src/copied\\tfile.ts"',
].join('\n');
assert.deepEqual(scanDeletedSymbols(quotedMetadataCopy), [], 'C-quoted copy metadata paths retain copy-as-addition semantics');

const modifiedCopy = metadataDiff(
  'copy',
  'src/original.ts',
  'src/modified-copy.ts',
  'export function survivingOriginal() { return true; }',
  'export function copiedVariant() { return false; }',
);
assert.deepEqual(scanDeletedSymbols(modifiedCopy), [], 'a modified copy never feeds its old side into removed declarations');

const metadataRename = metadataDiff(
  'rename',
  'src/metadata-old.ts',
  'src/metadata-new.ts',
  'export function renamedByMetadata() { return true; }',
  'export function renamedByMetadata() { return true; }',
);
assert.deepEqual(scanDeletedSymbols(metadataRename), ['renamedByMetadata'], 'rename metadata retains path-bound deletion semantics');

for (const [name, diff, diagnosticPattern, expectedSymbols = []] of [
  [
    'header-side mismatch',
    [
      'diff --git a/src/authority.ts b/src/authority.ts',
      '--- a/src/other.ts',
      '+++ b/src/authority.ts',
      '@@ -1 +1 @@',
      '-export function sideMismatchDeletion() { return true; }',
    ].join('\n'),
    /--- path .* does not match authoritative old path/,
    ['sideMismatchDeletion'],
  ],
  [
    'lone copy from',
    [
      'diff --git a/src/copy-source.ts b/src/copy-target.ts',
      'copy from src/copy-source.ts',
      '--- a/src/copy-source.ts',
      '+++ b/src/copy-target.ts',
      '@@ -1 +1 @@',
      '-export function loneCopyMustNotSuppress() { return true; }',
    ].join('\n'),
    /copy metadata must contain exactly one from\/to pair/,
    ['loneCopyMustNotSuppress'],
  ],
  [
    'duplicate copy side',
    [
      'diff --git a/src/copy-source.ts b/src/copy-target.ts',
      'copy from src/copy-source.ts',
      'copy from src/copy-source.ts',
      'copy to src/copy-target.ts',
      '--- a/src/copy-source.ts',
      '+++ b/src/copy-target.ts',
      '@@ -1 +1 @@',
      '-export function duplicateCopyMustNotSuppress() { return true; }',
    ].join('\n'),
    /copy metadata must contain exactly one from\/to pair/,
    ['duplicateCopyMustNotSuppress'],
  ],
  [
    'lone rename to',
    [
      'diff --git a/src/rename-source.ts b/src/rename-target.ts',
      'rename to src/rename-target.ts',
    ].join('\n'),
    /rename metadata must contain exactly one from\/to pair/,
  ],
  [
    'duplicate rename side',
    [
      'diff --git a/src/rename-source.ts b/src/rename-target.ts',
      'rename from src/rename-source.ts',
      'rename to src/rename-target.ts',
      'rename to src/rename-target.ts',
    ].join('\n'),
    /rename metadata must contain exactly one from\/to pair/,
  ],
  [
    'copy and rename conflict',
    [
      'diff --git a/src/source.ts b/src/target.ts',
      'copy from src/source.ts',
      'copy to src/target.ts',
      'rename from src/source.ts',
      'rename to src/target.ts',
      '--- a/src/source.ts',
      '+++ b/src/target.ts',
      '@@ -1 +1 @@',
      '-export function conflictingCopyMustNotSuppress() { return true; }',
    ].join('\n'),
    /rename and copy metadata are mutually exclusive/,
    ['conflictingCopyMustNotSuppress'],
  ],
  [
    'metadata-header mismatch',
    [
      'diff --git a/src/source.ts b/src/target.ts',
      'copy from src/different.ts',
      'copy to src/target.ts',
      '--- a/src/source.ts',
      '+++ b/src/target.ts',
      '@@ -1 +1 @@',
      '-export function mismatchedCopyMustNotSuppress() { return true; }',
    ].join('\n'),
    /copy metadata paths do not match diff header/,
    ['mismatchedCopyMustNotSuppress'],
  ],
  [
    'both sides dev-null',
    [
      'diff --git a/src/source.ts b/src/target.ts',
      '--- /dev/null',
      '+++ /dev/null',
    ].join('\n'),
    /both patch sides cannot be \/dev\/null/,
  ],
  [
    'copy combined with dev-null',
    [
      'diff --git a/src/source.ts b/src/target.ts',
      'copy from src/source.ts',
      'copy to src/target.ts',
      '--- a/src/source.ts',
      '+++ /dev/null',
      '@@ -1 +1 @@',
      '-export function devNullCopyMustNotSuppress() { return true; }',
    ].join('\n'),
    /rename\/copy metadata cannot be combined with \/dev\/null/,
    ['devNullCopyMustNotSuppress'],
  ],
] as const) {
  const analysis = analyzeDeletedSymbols(diff);
  assert.ok(
    analysis.diagnostics.some((diagnostic) => diagnosticPattern.test(diagnostic)),
    `${name} must produce focused fail-closed diagnostics`,
  );
  assert.deepEqual(analysis.symbols, [...expectedSymbols], `${name} must not silently suppress old declarations`);
}

for (const validNoHunkMetadata of [
  [
    'diff --git a/src/pure-copy.ts b/src/pure-copy-target.ts',
    'copy from src/pure-copy.ts',
    'copy to src/pure-copy-target.ts',
  ].join('\n'),
  [
    'diff --git a/src/pure-rename.ts b/src/pure-rename-target.ts',
    'rename from src/pure-rename.ts',
    'rename to src/pure-rename-target.ts',
  ].join('\n'),
]) {
  const analysis = analyzeDeletedSymbols(validNoHunkMetadata);
  assert.deepEqual(analysis.symbols, []);
  assert.deepEqual(analysis.diagnostics, [], 'valid no-hunk copy/rename metadata remains accepted');
}

for (const [name, diff, diagnosticPattern] of [
  [
    'copy metadata after side headers',
    [
      'diff --git a/src/source.ts b/src/target.ts',
      '--- a/src/source.ts',
      '+++ b/src/target.ts',
      'copy from src/source.ts',
      'copy to src/target.ts',
      '@@ -1 +1 @@',
      '-export function lateCopyMetadata() { return true; }',
    ].join('\n'),
    /copy metadata must appear before side headers and hunks/,
  ],
  [
    'rename metadata after hunk content',
    [
      'diff --git a/src/source.ts b/src/target.ts',
      '--- a/src/source.ts',
      '+++ b/src/target.ts',
      '@@ -1 +1 @@',
      ' export function contextLine() { return true; }',
      'rename from src/source.ts',
      'rename to src/target.ts',
    ].join('\n'),
    /rename metadata must appear before side headers and hunks/,
  ],
  [
    'removed content outside hunk',
    [
      'diff --git a/src/source.ts b/src/source.ts',
      '--- a/src/source.ts',
      '+++ b/src/source.ts',
      '-export function outsideHunk() { return true; }',
    ].join('\n'),
    /removed content is only valid inside an @@ hunk/,
  ],
  [
    'reversed side headers',
    [
      'diff --git a/src/source.ts b/src/source.ts',
      '+++ b/src/source.ts',
      '--- a/src/source.ts',
      '+++ b/src/source.ts',
      '@@ -1 +1 @@',
    ].join('\n'),
    /\+\+\+ side header must follow exactly one --- side header/,
  ],
  [
    'duplicate side headers',
    [
      'diff --git a/src/source.ts b/src/source.ts',
      '--- a/src/source.ts',
      '--- a/src/source.ts',
      '+++ b/src/source.ts',
      '@@ -1 +1 @@',
    ].join('\n'),
    /--- side header is reversed, duplicated, or appears after patch content/,
  ],
  [
    'hunk before side headers',
    [
      'diff --git a/src/source.ts b/src/source.ts',
      '@@ -1 +1 @@',
      '--- a/src/source.ts',
      '+++ b/src/source.ts',
      '@@ -1 +1 @@',
    ].join('\n'),
    /@@ hunk must follow a complete ---\/\+\+\+ side-header pair/,
  ],
  [
    'addition with removed content',
    [
      'diff --git a/src/added.ts b/src/added.ts',
      '--- /dev/null',
      '+++ b/src/added.ts',
      '@@ -0 +1 @@',
      '-export function impossibleRemoval() { return true; }',
      '+export function realAddition() { return true; }',
    ].join('\n'),
    /addition patch cannot contain removed content/,
  ],
  [
    'deletion with added content',
    [
      'diff --git a/src/deleted.ts b/src/deleted.ts',
      '--- a/src/deleted.ts',
      '+++ /dev/null',
      '@@ -1 +0 @@',
      '-export function realDeletion() { return true; }',
      '+export function impossibleAddition() { return true; }',
    ].join('\n'),
    /deletion patch cannot contain added content/,
  ],
  [
    'addition header identity mismatch',
    [
      'diff --git a/src/old-name.ts b/src/new-name.ts',
      '--- /dev/null',
      '+++ b/src/new-name.ts',
      '@@ -0 +1 @@',
      '+export function mismatchedAddition() { return true; }',
    ].join('\n'),
    /\/dev\/null patch header identities must describe the same path/,
  ],
] as const) {
  const analysis = analyzeDeletedSymbols(diff);
  assert.ok(
    analysis.diagnostics.some((diagnostic) => diagnosticPattern.test(diagnostic)),
    `${name} must fail closed with an ordering/direction diagnostic`,
  );
}

const validBinaryDiff = analyzeDeletedSymbols([
  'diff --git a/assets/data.bin b/assets/data.bin',
  'index 1234567..89abcde 100644',
  'Binary files a/assets/data.bin and b/assets/data.bin differ',
].join('\n'));
assert.deepEqual(validBinaryDiff.symbols, []);
assert.deepEqual(validBinaryDiff.diagnostics, [], 'binary diff behavior remains non-textual and diagnostic-free');

const samePathWithDelimiter = analyzeDeletedSymbols([
  'diff --git a/src/left b/segment.ts b/src/left b/segment.ts',
  'similarity index 100%',
].join('\n'));
assert.deepEqual(samePathWithDelimiter.symbols, []);
assert.deepEqual(samePathWithDelimiter.diagnostics, [], 'exact same-path symmetry resolves literal b/ delimiters without guessing');

const hunkCorroboratedDelimiter = analyzeDeletedSymbols([
  'diff --git a/src/left b/segment.ts b/src/left b/segment.ts',
  '--- a/src/left b/segment.ts',
  '+++ b/src/left b/segment.ts',
  '@@ -1 +1 @@',
  '-export function delimiterPathBody() { return true; }',
  '+export function delimiterPathBody() { return false; }',
].join('\n'));
assert.deepEqual(hunkCorroboratedDelimiter.symbols, []);
assert.deepEqual(hunkCorroboratedDelimiter.diagnostics, [], 'side headers resolve same-path literal b/ delimiters');

for (const kind of ['rename', 'copy'] as const) {
  const metadataCorroboratedDelimiter = analyzeDeletedSymbols([
    'diff --git a/src/old b/segment.ts b/src/new b/segment.ts',
    `${kind} from src/old b/segment.ts`,
    `${kind} to src/new b/segment.ts`,
  ].join('\n'));
  assert.deepEqual(metadataCorroboratedDelimiter.symbols, []);
  assert.deepEqual(metadataCorroboratedDelimiter.diagnostics, [], `${kind} metadata resolves literal b/ delimiters and spaces`);
}

const ambiguousUnquotedHeader = analyzeDeletedSymbols(
  'diff --git a/src/one b/two.ts b/src/three b/four.ts',
);
assert.ok(
  ambiguousUnquotedHeader.diagnostics.some(diagnostic => /unquoted diff header path is unresolved after corroboration/.test(diagnostic)),
  'an uncorroborated multi-candidate header fails closed instead of choosing first or last',
);

for (const [name, diff] of [
  [
    'supported replacement',
    [
      'diff --git a/src/runtime.ts b/src/runtime.ts',
      'Binary files a/src/runtime.ts and b/src/runtime.ts differ',
    ].join('\n'),
  ],
  [
    'supported addition with null',
    [
      'diff --git a/src/added.js b/src/added.js',
      'new file mode 100644',
      'Binary files /dev/null and b/src/added.js differ',
    ].join('\n'),
  ],
  [
    'supported deletion with null',
    [
      'diff --git a/src/deleted.py b/src/deleted.py',
      'deleted file mode 100644',
      'Binary files a/src/deleted.py and /dev/null differ',
    ].join('\n'),
  ],
  [
    'supported rename',
    [
      'diff --git a/src/old.ts b/src/new.ts',
      'rename from src/old.ts',
      'rename to src/new.ts',
      'Binary files a/src/old.ts and b/src/new.ts differ',
    ].join('\n'),
  ],
  [
    'supported copy',
    [
      'diff --git a/src/base.mjs b/src/copy.mjs',
      'copy from src/base.mjs',
      'copy to src/copy.mjs',
      'GIT binary patch',
    ].join('\n'),
  ],
] as const) {
  const analysis = analyzeDeletedSymbols(diff);
  assert.ok(
    analysis.diagnostics.some(diagnostic => /binary diff touches supported declaration-bearing source path/.test(diagnostic)),
    `${name} must fail closed instead of hiding declarations in binary content`,
  );
}

for (const [oldToken, newToken, symbol] of [
  ['"a/src/\\303\\251.ts"', '"b/src/\\303\\251.ts"', 'unicodeQuotedDeletion'],
  ['"a/src/tab\\tname.ts"', '"b/src/tab\\tname.ts"', 'tabQuotedDeletion'],
  ['"a/src/line\\nname.ts"', '"b/src/line\\nname.ts"', 'newlineQuotedDeletion'],
  ['"a/src/quote\\"name.ts"', '"b/src/quote\\"name.ts"', 'quoteQuotedDeletion'],
  ['"a/src/back\\\\slash.ts"', '"b/src/back\\\\slash.ts"', 'backslashQuotedDeletion'],
  ['a/src/space name.ts', 'b/src/space name.ts', 'spacePathDeletion'],
] as const) {
  const quotedPathDeletion = [
    `diff --git ${oldToken} ${newToken}`,
    `--- ${oldToken}`,
    '+++ /dev/null',
    '@@ -1 +0 @@',
    `-export function ${symbol}() { return true; }`,
  ].join('\n');
  const analysis = analyzeDeletedSymbols(quotedPathDeletion);
  assert.deepEqual(analysis.symbols, [symbol], `quoted/special path deletion remains visible for ${symbol}`);
  assert.deepEqual(analysis.diagnostics, []);
}

const malformedQuotedPath = [
  'diff --git "a/src/broken.ts" "b/src/broken.ts',
  '--- "a/src/broken.ts"',
  '+++ /dev/null',
  '-export function mustNotUseFragmentFallback() { return true; }',
].join('\n');
const malformedQuotedPathAnalysis = analyzeDeletedSymbols(malformedQuotedPath);
assert.deepEqual(malformedQuotedPathAnalysis.symbols, [], 'malformed path quoting cannot fall back to a synthetic TypeScript fragment');
assert.ok(
  malformedQuotedPathAnalysis.diagnostics.some((diagnostic) => /diff path:.*closing quote/.test(diagnostic)),
  'malformed Git path quoting fails closed with a focused diagnostic',
);

const shebangMjs = [
  'diff --git a/scripts/tool.mjs b/scripts/tool.mjs',
  '--- a/scripts/tool.mjs',
  '+++ b/scripts/tool.mjs',
  '@@ -1,2 +1 @@',
  ' #!/usr/bin/env node',
  '-export function removedFromCli() { return true; }',
].join('\n');
const shebangMjsAnalysis = analyzeDeletedSymbols(shebangMjs);
assert.deepEqual(shebangMjsAnalysis.symbols, ['removedFromCli'], 'MJS declarations remain visible after a shebang');
assert.deepEqual(shebangMjsAnalysis.diagnostics, [], 'a logical-start MJS shebang remains parseable after diff reconstruction');

const renameAndExportRemoval = fileDiff(
  'src/rename.ts',
  [
    'export function removedExport() { return true; }',
    'export const noLongerExported = () => true;',
    'const text = "export function removedExport() {}";',
    '// export const noLongerExported = () => false;',
  ].join('\n'),
  [
    'export function renamedExport() { return true; }',
    'const noLongerExported = () => true;',
    'const text = "export function removedExport() { return false; }";',
    '// export function removedExport() {}',
  ].join('\n'),
);
assert.deepEqual(
  scanDeletedSymbols(renameAndExportRemoval),
  ['removedExport'],
  'rename remains a deletion while export-state change preserves the same declaration name',
);

const pythonScope = fileDiff(
  'src/scoped.py',
  [
    'class A:',
    '    def shared(self, value):',
    '        return value',
    'class B:',
    '    def shared(self, value):',
    '        return value',
  ].join('\n'),
  [
    'class A:',
    '    pass',
    'class B:',
    '    def shared(self, value):',
    '        return value + 1',
  ].join('\n'),
);
assert.deepEqual(scanDeletedSymbols(pythonScope), ['shared'], 'Python file/scope identity prevents same-name cancellation');

for (const extension of ['pyi', 'pyw']) {
  const pythonVariantDeletion = fileDiff(
    `src/python-variant.${extension}`,
    ['def removed(value: str) -> str:', '    return value'].join('\n'),
    '',
  );
  assert.deepEqual(
    scanDeletedSymbols(pythonVariantDeletion),
    ['removed'],
    `.${extension} files use Python declaration analysis`,
  );
}

const multilinePythonDeletion = fileDiff(
  'src/multiline.py',
  [
    'def removed(',
    '    value: str,',
    ') -> str:',
    '    return value',
    'class RemovedClass(',
    '    object,',
    '):',
    '    pass',
  ].join('\n'),
  '',
);
assert.deepEqual(
  scanDeletedSymbols(multilinePythonDeletion),
  ['RemovedClass', 'removed'],
  'multiline Python function and class headers remain detectable deletions',
);

const multilinePythonBodyOnly = fileDiff(
  'src/multiline-body.py',
  [
    'def retained(',
    '    value: str,',
    ') -> str:',
    '    return value',
    'class Retained(',
    '    object,',
    '):',
    '    pass',
  ].join('\n'),
  [
    'def retained(',
    '    value: str,',
    ') -> str:',
    '    return value.strip()',
    'class Retained(',
    '    object,',
    '):',
    '    marker = True',
  ].join('\n'),
);
assert.deepEqual(scanDeletedSymbols(multilinePythonBodyOnly), [], 'multiline Python body-only edits preserve declaration identity');

for (const malformedPython of [
  fileDiff('src/unterminated.py', ['def broken(', '    value: str,'].join('\n'), ''),
  fileDiff('src/malformed-class.py', ['class (Base):', '    pass'].join('\n'), ''),
]) {
  const analysis = analyzeDeletedSymbols(malformedPython);
  assert.ok(analysis.diagnostics.length > 0, 'malformed or unterminated Python declaration headers must fail closed');
  const result = checkConcept({ projectRoot: '/tmp/unused', gitDiffReader: () => malformedPython });
  assert.equal(result.status, 'fail');
  assert.match(result.summary, /parse failed closed/);
}

const malformed = fileDiff('src/malformed.ts', 'export function broken( {', 'export function broken( {');
const malformedAnalysis = analyzeDeletedSymbols(malformed);
assert.ok(malformedAnalysis.diagnostics.length > 0);
const malformedResult = checkConcept({
  projectRoot: '/tmp/unused',
  gitDiffReader: () => malformed,
});
assert.equal(malformedResult.status, 'fail');
assert.match(malformedResult.summary, /parse failed closed/);
assert.ok((malformedResult.diagnostics?.length ?? 0) > 0);

for (const malformedSide of [
  renamedFileDiff('src/malformed-old.ts', 'docs/malformed-old.md', 'export function broken( {', '# prose'),
  renamedFileDiff('docs/malformed-new.md', 'src/malformed-new.ts', '# prose', 'export function broken( {'),
]) {
  const analysis = analyzeDeletedSymbols(malformedSide);
  assert.ok(analysis.diagnostics.length > 0, 'a malformed supported old or new side must fail closed');
}

const unsupportedMetadata = [
  fileDiff(
    '.proof-or-stop/story/actives/B-smoke/index.json',
    '{"phase":"DEV","looksLikeCode":"export function broken( {"}',
    '{"phase":"REVIEW","looksLikeCode":"class ["}',
  ),
  fileDiff(
    '.proof-or-stop/story/actives/B-smoke/process-events.jsonl',
    '{"detail":"function phantom( {"}',
    '{"detail":"const phantom = ("}',
  ),
  fileDiff(
    'docs/requirements/notes.md',
    '# Removed\nexport function proseOnly( {',
    '# Retained\nclass proseOnly [',
  ),
  fileDiff(
    '.proof-or-stop-codex/proof-or-stop.json',
    '{"prompt":"async function promptText( {"}',
    '{"prompt":"const promptText = ("}',
  ),
].join('\n');
const unsupportedAnalysis = analyzeDeletedSymbols(unsupportedMetadata);
assert.deepEqual(unsupportedAnalysis.symbols, [], 'unsupported-only metadata/docs diff yields no deleted symbols');
assert.deepEqual(unsupportedAnalysis.diagnostics, [], 'unsupported-only metadata/docs diff yields no parser diagnostics');
const unsupportedResult = checkConcept({
  projectRoot: '/tmp/unused',
  gitDiffReader: () => unsupportedMetadata,
});
assert.equal(unsupportedResult.status, 'pass', 'unsupported-only metadata/docs diff passes concept preflight');
assert.deepEqual(unsupportedResult.deletedSymbols, []);
assert.equal(unsupportedResult.diagnostics, undefined);

const mixedLanguageDiff = [
  unsupportedMetadata,
  fileDiff(
    'src/mixed.ts',
    'export function actuallyRemoved(): boolean { return true; }',
    '',
  ),
].join('\n');
const mixedLanguageAnalysis = analyzeDeletedSymbols(mixedLanguageDiff);
assert.deepEqual(mixedLanguageAnalysis.symbols, ['actuallyRemoved'], 'mixed diff still detects a real deleted TypeScript declaration');
assert.deepEqual(mixedLanguageAnalysis.diagnostics, [], 'mixed non-code files contribute no fake TypeScript diagnostics');

const legacyHeaderlessFragment = [
  '-export function fragmentRemoved(): boolean { return true; }',
  '+',
].join('\n');
assert.deepEqual(
  scanDeletedSymbols(legacyHeaderlessFragment),
  ['fragmentRemoved'],
  'headerless injected diff keeps the __fragment__.ts TypeScript fallback',
);

const shebangBodyOnly = [
  'diff --git a/bin/tool.mjs b/bin/tool.mjs',
  '--- a/bin/tool.mjs',
  '+++ b/bin/tool.mjs',
  '@@ -1,2 +1,2 @@',
  ' #!/usr/bin/env node',
  '-export function retained() { return true; }',
  '+export function retained() { return Boolean(1); }',
].join('\n');
const shebangAnalysis = analyzeDeletedSymbols(shebangBodyOnly);
assert.deepEqual(shebangAnalysis.diagnostics, [], 'first-hunk reconstruction keeps a legal JS shebang on line 1');
assert.deepEqual(shebangAnalysis.symbols, [], 'body-only edit after a shebang preserves declaration identity');

const diffFailure = checkConcept({
  projectRoot: '/tmp/unused',
  gitDiffReader: () => { throw new Error('git reader failed'); },
});
assert.equal(diffFailure.status, 'warn');
assert.match(diffFailure.summary, /git diff failed.*git reader failed/);

console.log('concept gate scope smoke passed');
