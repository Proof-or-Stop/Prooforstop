#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { checkConcept, renderConceptResult } from '../handlers/validate-concept.js';

const diff = [
  'diff --git a/src/old.ts b/src/old.ts',
  '--- a/src/old.ts',
  '+++ b/src/old.ts',
  '-export function audit_resources() { return true; }',
].join('\n');

const grepOutput = [
  './.koala/activity.jsonl:1:{"tool":"finding_add","args":{"desc":"audit_resources"}}',
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
  recommendation: 'dispatch koala-review-concept',
});
assert.match(rendered, /standalone validate --concept only reports raw residuals/);

console.log('concept gate scope smoke passed');
