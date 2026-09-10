import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sourcePath = new URL('../../src/tasks/finding-identity-lineage-smoke.ts', import.meta.url);
const source = readFileSync(sourcePath, 'utf8');

const requiredCases = [
  'failed target test outcome is valid evidence but not semantic progress',
  'status regression from a signed present predecessor is refused',
  'predecessor digest substitutions refuse without ledger mutation',
];

try {
  for (const name of requiredCases) {
    assert.ok(source.includes(`test('${name}'`), `missing executable case: ${name}`);
  }
  console.log('B03B7_PROGRESS_TRANSITION_COVERAGE PASS');
} catch (error) {
  console.error(`B03B7_PROGRESS_TRANSITION_COVERAGE FAIL: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
