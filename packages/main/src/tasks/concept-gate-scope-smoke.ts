#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { checkConcept, renderConceptResult, scanDeletedSymbols } from '../handlers/validate-concept.js';

const diff = [
  'diff --git a/src/old.ts b/src/old.ts',
  '--- a/src/old.ts',
  '+++ b/src/old.ts',
  '-export function audit_resources() { return true; }',
].join('\n');

const grepOutput = [
  './.lattice/activity.jsonl:1:{"tool":"finding_add","args":{"desc":"audit_resources"}}',
  './docs/story/actives/B-smoke/findings.json:2:"audit_resources residual"',
  './packages/main/tests/fixtures/concept.json:3:"audit_resources fixture mention"',
  './src/live.ts:4:export const stillThere = audit_resources();',
].join('\n');

const result = checkConcept({
  projectRoot: '/tmp/unused',
  gitDiffReader: () => diff,
  grepReader: () => grepOutput,
});

assert.equal(result.deletedSymbols.length, 1);
assert.equal(result.residuals.length, 1);
assert.equal(result.residuals[0].file, 'src/live.ts');

const rendered = renderConceptResult({
  ...result,
  status: 'fail',
  recommendation: 'dispatch lattice-review-concept',
});
assert.match(rendered, /standalone validate --concept only reports raw residuals/);

const changedDeclarations = [
  '-export function buildQueryGroups(input: string) { return input; }',
  '+export function buildQueryGroups(input: string, limit = 1) { return input.slice(0, limit); }',
  '-export const candidateReadBindingErrors = () => [];',
  '+export const candidateReadBindingErrors = async () => [];',
  '-export async function defaultHostRunRunner() { return true; }',
  '+export async function defaultHostRunRunner(timeoutMs = 10) { return timeoutMs > 0; }',
  '-export function* streamedResults() { yield 1; }',
  '+export function* streamedResults(limit = 1) { yield limit; }',
  '-export class Runner { run() { return 1; } }',
  '+export class Runner { run() { return 2; } }',
  '-def python_runner(value):',
  '+def python_runner(value, limit=1):',
].join('\n');
assert.deepEqual(
  scanDeletedSymbols(changedDeclarations),
  [],
  'retained declarations with changed signatures or bodies are modifications, not deletions',
);

assert.deepEqual(
  scanDeletedSymbols([
    '-export function removedExport() { return true; }',
    '+export function renamedExport() { return true; }',
    '-export const noLongerExported = () => true;',
    '+const noLongerExported = () => true;',
    '-// export function removedExport() {}',
    '+// export function noLongerExported() {}',
  ].join('\n')),
  ['noLongerExported', 'removedExport'],
  'rename and export removal remain true deletions; comments cannot suppress them',
);

assert.deepEqual(
  scanDeletedSymbols('-export function overload(value: string): string;'),
  ['overload'],
  'removing an overload declaration without a matching added declaration remains a deletion',
);

assert.deepEqual(
  scanDeletedSymbols([
    '-function internalHelper() { return 1; }',
    '+function internalHelper() { return 2; }',
    '-  constructor() { this.value = 1; }',
    '+  constructor() { this.value = 2; }',
    '-  method() { return "export function fake()"; }',
    '+  method() { return "export function fake() changed"; }',
  ].join('\n')),
  [],
  'non-exported declarations, methods, constructors, and strings remain outside the exported-symbol deletion surface',
);

const diffFailure = checkConcept({
  projectRoot: '/tmp/unused',
  gitDiffReader: () => { throw new Error('malformed diff'); },
});
assert.equal(diffFailure.status, 'warn');
assert.match(diffFailure.summary, /git diff failed.*malformed diff/);

console.log('concept gate scope smoke passed');
