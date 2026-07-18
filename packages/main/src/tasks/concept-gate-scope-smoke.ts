#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { analyzeDeletedSymbols, checkConcept, renderConceptResult, scanDeletedSymbols } from '../handlers/validate-concept.js';

function fileDiff(path: string, oldSource: string, newSource: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    ...oldSource.split('\n').map((line) => `-${line}`),
    ...newSource.split('\n').map((line) => `+${line}`),
  ].join('\n');
}

function renamedFileDiff(oldPath: string, newPath: string, oldSource: string, newSource: string): string {
  return [
    `diff --git a/${oldPath} b/${newPath}`,
    `--- a/${oldPath}`,
    `+++ b/${newPath}`,
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
    ...source.split('\n').map((line) => `${deleting ? '-' : '+'}${line}`),
  ].join('\n');
}

const deletedExport = fileDiff(
  'src/old.ts',
  'export function audit_resources() { return true; }',
  '',
);
const grepOutput = [
  './.lattice/activity.jsonl:1:{"tool":"finding_add","args":{"desc":"audit_resources"}}',
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
assert.match(renderConceptResult({ ...result, status: 'fail', recommendation: 'dispatch lattice-review-concept' }), /standalone validate --concept only reports raw residuals/);

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
assert.deepEqual(scanDeletedSymbols(signatureReplacement), ['changed', 'constructor', 'method'], 'true signature replacement remains a deletion signal');

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
  ['noLongerExported', 'removedExport'],
  'rename and export removal remain deletions; comments and strings cannot forge declaration survivors',
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

const diffFailure = checkConcept({
  projectRoot: '/tmp/unused',
  gitDiffReader: () => { throw new Error('git reader failed'); },
});
assert.equal(diffFailure.status, 'warn');
assert.match(diffFailure.summary, /git diff failed.*git reader failed/);

console.log('concept gate scope smoke passed');
