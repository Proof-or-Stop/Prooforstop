// Bounded source-identity acceptance; the broader fixture/JSON suite remains separate.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { validateReviewedSourceSources, reviewedSourceResidueAllowed } from './identity-reviewed-source-contexts.mjs';

const read = path => readFileSync(path, 'utf8');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const scripts = JSON.parse(read('package.json')).scripts;
assert.equal(scripts['test:reviewed-source-bindings'], 'node scripts/verify-reviewed-source-bindings.mjs',
  'REVIEWED_SOURCE_TEST_MUST_BE_IN_ROUTINE_SUITE');
assert.equal(scripts['test:serial-reference'].split(' && ')
  .filter(command => command === 'npm run test:reviewed-source-bindings').length, 1,
  'REVIEWED_SOURCE_TEST_MUST_BE_IN_ROUTINE_SUITE');
const errors = validateReviewedSourceSources(read);
console.log(JSON.stringify({ reviewedSourceBindingFailures: errors.length, errors }));
assert.deepEqual(errors, [], 'REVIEWED_SOURCE_BINDINGS_MUST_MATCH_CURRENT_SOURCE');

const scanner = read('scripts/verify-proof-or-stop-identity-cutover.mjs');
const table = scanner.match(/const REVIEWED_CONTEXT_READERS = (\[[\s\S]*?\]);/);
assert.ok(table, 'scanner must retain its exact reviewed-reader table');
const pins = JSON.parse(table[1]);
assert.deepEqual(pins.map(row => row.path).sort(), ['fixture', 'json', 'source']
  .map(kind => `scripts/identity-reviewed-${kind}-contexts.mjs`).sort());
for (const pin of pins) assert.equal(sha(read(pin.path)), pin.sha256,
  `REVIEWED_READER_CHAIN_MUST_MATCH: ${pin.path}`);
console.log(`PASS scanner reader bindings: ${pins.length} exact current modules`);

const rows = JSON.parse(read('scripts/identity-reviewed-source-data.json')).entries;
// Reconstruct the exact historical/current string literal using the unchanged
// reviewed token, without adding another unclassified retired-token occurrence.
const promptRow = rows.find(row => row.path === 'packages/main/src/core/prompt-registry.ts');
assert.ok(promptRow);
const promptBefore = `      'Use schemaVersion proof-or-stop.acceptance_amendment_review_final.v1; runId must equal environment ${promptRow.token}; include the exact storyId and binding below, decision approve or reject, substantive rationale and nonempty readRefs.',`;
const promptAfter = `      'Use schemaVersion proof-or-stop.acceptance_amendment_review_final.v1; runId must equal environment ${promptRow.token}. Return exactly these top-level fields: schemaVersion, runId, storyId, amendmentId, amendmentDigest, baseDigest, submitterSessionId, decision, rationale, readRefs. Copy amendmentId, amendmentDigest, baseDigest and submitterSessionId from the input binding object into those top-level fields; do not return a binding object. decision must be approve or reject; rationale must be substantive and readRefs must be nonempty.',`;
assert.equal(sha(promptBefore), '0f6764f3315b51cacb403a7e6b427bd2f06a96bf07369e1c1dd40b1aef3ab251');
assert.equal(sha(promptAfter), '648c58818e33cfbdc6a47d8df9e5e805bdacffff9dde01d558055596fc6491bb');
assert.equal(read(promptRow.path).split(/\r?\n/)[promptRow.lineNumber - 1], promptAfter);
assert.equal(promptRow.classification, 'private_protocol_preserve_or_coordinated_versioned_migration');
assert.equal(promptRow.tokenOccurrences, 1);
console.log('PASS prompt context: exact before/after hashes, current full line, classification and count');
for (const row of rows) {
  const text = read(row.path), line = text.split(/\r?\n/)[row.lineNumber - 1];
  const input = { path: row.path, token: row.token, line, lineNumber: row.lineNumber, text };
  assert.equal(reviewedSourceResidueAllowed(input), true, row.path);
  for (const mutant of [
    { ...input, path: `${row.path}.unknown` },
    { ...input, token: `${row.token}UNKNOWN` },
    { ...input, text: `${text}\n// unrelated source mutation\n` },
    { ...input, line: `${line} changed` },
    { ...input, lineNumber: row.lineNumber + 1 },
    { ...input, text: `${text}\n${row.token}\n` },
  ]) assert.equal(reviewedSourceResidueAllowed(mutant), false, row.path);
}
const paths = [...new Set(rows.map(row => row.path))];
for (const path of paths) {
  assert.ok(validateReviewedSourceSources(p => p === path ? '' : read(p)).length);
  assert.ok(validateReviewedSourceSources(p => { if (p === path) throw Error('missing'); return read(p); }).length);
}
console.log(`PASS source: ${rows.length} exact positives, ${rows.length * 6} mutation refusals, ${paths.length * 2} empty/missing controls`);

const scratch = mkdtempSync(join(tmpdir(), 'reviewed-source-binding-'));
try {
  const moduleName = 'identity-reviewed-source-contexts.mjs';
  const dataName = 'identity-reviewed-source-data.json';
  copyFileSync(new URL(`./${moduleName}`, import.meta.url), join(scratch, moduleName));
  const bytes = readFileSync(new URL(`./${dataName}`, import.meta.url), 'utf8');
  const original = JSON.parse(bytes);
  for (const [name, entries] of [
    ['original', original.entries],
    ['missing', original.entries.slice(1)],
    ['duplicate', [...original.entries, original.entries[0]]],
  ]) {
    writeFileSync(join(scratch, dataName), name === 'original' ? bytes : JSON.stringify({ ...original, entries }));
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(scratch, moduleName)).href)})`], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    if (name === 'original') assert.equal(result.status, 0, result.stderr);
    else { assert.equal(result.status, 1); assert.match(result.stderr, /inventory bytes changed/i); }
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
console.log('PASS source inventory byte integrity: original accepted, deleted and duplicate rows refused');
