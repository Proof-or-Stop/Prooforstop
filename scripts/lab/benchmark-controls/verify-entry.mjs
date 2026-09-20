import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const url = new URL('./verify.mjs', import.meta.url);
const EXPECTED_TESTS = 21;
for (const argv of [[fileURLToPath(url)], ['--input-type=module', '--eval', `await import(${JSON.stringify(url.href)})`]]) {
  const output = execFileSync(process.execPath, argv, { encoding: 'utf8', timeout: 15000 });
  const line = output.trim().split('\n').findLast(value => value.startsWith('{'));
  assert.ok(line, 'VERIFIER_ENTRY_EMPTY: successful process must actually execute verification');
  const result = JSON.parse(line);
  assert.equal(result.tests, EXPECTED_TESTS, 'VERIFIER_ENTRY_COUNT: every delivered check must run');
  assert.equal(result.realModelCalls, 0);
  console.log(`ENTRY_PASS ${argv[0]} tests=${result.tests}`);
}
