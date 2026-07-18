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

const crossFile = [
  fileDiff('src/a.ts', 'export function shared(value: string): string { return value; }', ''),
  fileDiff(
    'src/b.ts',
    'export function shared(value: string): string { return value; }',
    'export function shared(value: string): string { return value.trim(); }',
  ),
].join('\n');
assert.deepEqual(scanDeletedSymbols(crossFile), ['shared'], 'a same-name declaration in another file cannot cancel a true deletion');

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

const unsupportedMetadata = [
  fileDiff(
    '.lattice/story/actives/B-smoke/index.json',
    '{"phase":"DEV","looksLikeCode":"export function broken( {"}',
    '{"phase":"REVIEW","looksLikeCode":"class ["}',
  ),
  fileDiff(
    '.lattice/story/actives/B-smoke/process-events.jsonl',
    '{"detail":"function phantom( {"}',
    '{"detail":"const phantom = ("}',
  ),
  fileDiff(
    'docs/requirements/notes.md',
    '# Removed\nexport function proseOnly( {',
    '# Retained\nclass proseOnly [',
  ),
  fileDiff(
    '.lattice-codex/lattice.json',
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
const mixedAnalysis = analyzeDeletedSymbols(mixedLanguageDiff);
assert.deepEqual(mixedAnalysis.symbols, ['actuallyRemoved'], 'mixed diff still detects a real deleted TypeScript declaration');
assert.deepEqual(mixedAnalysis.diagnostics, [], 'mixed non-code files contribute no fake TypeScript diagnostics');

const headerlessFragment = [
  '-export function fragmentRemoved(): boolean { return true; }',
  '+',
].join('\n');
assert.deepEqual(
  scanDeletedSymbols(headerlessFragment),
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
