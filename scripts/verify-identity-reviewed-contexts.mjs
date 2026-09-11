import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { validateReviewedDataSources, reviewedDataResidueAllowed } from './identity-reviewed-json-contexts.mjs';
import { validateReviewedFixtureSources, reviewedFixtureResidueAllowed } from './identity-reviewed-fixture-contexts.mjs';
import { validateReviewedSourceSources, reviewedSourceResidueAllowed } from './identity-reviewed-source-contexts.mjs';

const read = path => readFileSync(path, 'utf8');
const sourceErrors = validateReviewedSourceSources(read);
console.log(JSON.stringify({ reviewedSourceBindingFailures: sourceErrors.length, errors: sourceErrors }));
assert.deepEqual(sourceErrors, [], 'REVIEWED_SOURCE_BINDINGS_MUST_MATCH_CURRENT_SOURCE');

// Check the entire data -> reader -> scanner chain. Updating only a reader's
// inventory digest must not leave its independently pinned scanner witness stale.
const scanner = read('scripts/verify-proof-or-stop-identity-cutover.mjs');
const readerTable = scanner.match(/const REVIEWED_CONTEXT_READERS = (\[[\s\S]*?\]);/);
assert.ok(readerTable, 'scanner must retain its exact reviewed-reader table');
const readerPins = JSON.parse(readerTable[1]);
assert.deepEqual(readerPins.map(row => row.path).sort(), ['fixture', 'json', 'source']
  .map(kind => `scripts/identity-reviewed-${kind}-contexts.mjs`).sort());
for (const pin of readerPins) {
  assert.equal(createHash('sha256').update(read(pin.path)).digest('hex'), pin.sha256,
    `REVIEWED_READER_CHAIN_MUST_MATCH: ${pin.path}`);
}
console.log(`PASS scanner reader bindings: ${readerPins.length} exact current modules`);

for (const [kind, validate, allowed] of [
  ['fixture', validateReviewedFixtureSources, reviewedFixtureResidueAllowed],
  ['source', validateReviewedSourceSources, reviewedSourceResidueAllowed],
]) {
  const rows = JSON.parse(readFileSync(new URL(`./identity-reviewed-${kind}-data.json`, import.meta.url))).entries;
  assert.deepEqual(validate(read), []);
  for (const row of rows) {
    const text = read(row.path), line = text.split(/\r?\n/)[row.lineNumber - 1];
    const input = { path: row.path, token: row.token, line, lineNumber: row.lineNumber, text };
    assert.equal(allowed(input), true);
    for (const mutant of [
      { ...input, path: `${row.path}.unknown` },
      { ...input, token: `${row.token}UNKNOWN` },
      { ...input, text: `${text}\n// changed independent source contract\n` },
      { ...input, line: `${line} changed` },
      { ...input, lineNumber: row.lineNumber + 1 },
      { ...input, text: `${text}\n${row.token}\n` },
    ]) assert.equal(allowed(mutant), false);
  }
  for (const path of new Set(rows.map(row => row.path))) {
    assert.ok(validate(p => p === path ? '' : read(p)).length);
  }
  console.log(`PASS ${kind}: ${rows.length} exact positives, ${rows.length * 6} mutation refusals, missing-source controls`);
}
const data = JSON.parse(readFileSync(new URL('./identity-reviewed-json-data.json', import.meta.url))).entries;
assert.deepEqual(validateReviewedDataSources(read), []);
for (const path of new Set(data.map(row => row.path))) {
  assert.ok(validateReviewedDataSources(p => p === path ? '{}' : read(p)).length);
  assert.ok(validateReviewedDataSources(p => { if (p === path) throw Error('missing'); return read(p); }).length);
}
const row = data.find(row => row.nodeKind === 'value'), text = read(row.path);
const fake = `{"unknown":${JSON.stringify(row.token)}}`;
assert.equal(reviewedDataResidueAllowed({ path: row.path, token: row.token, text: fake, line: fake, lineNumber: 1 }), false);
console.log(`PASS JSON: ${data.length} exact current nodes, removed/missing sources, unknown-node refusal`);

for (const kind of ['json', 'fixture', 'source']) {
  const root = mkdtempSync(join(tmpdir(), 'identity-context-integrity-'));
  try {
    const moduleName = `identity-reviewed-${kind}-contexts.mjs`, dataName = `identity-reviewed-${kind}-data.json`;
    copyFileSync(new URL(`./${moduleName}`, import.meta.url), join(root, moduleName));
    const bytes = readFileSync(new URL(`./${dataName}`, import.meta.url), 'utf8');
    const original = JSON.parse(bytes);
    for (const [name, entries] of [
      ['original', original.entries],
      ['missing', original.entries.slice(1)],
      ['duplicate', [...original.entries, original.entries[0]]],
    ]) {
      writeFileSync(join(root, dataName), name === 'original' ? bytes : JSON.stringify({ ...original, entries }));
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(root, moduleName)).href)})`], { encoding: 'utf8', timeout: 10000 });
      if (name === 'original') assert.equal(result.status, 0, result.stderr);
      else { assert.notEqual(result.status, 0); assert.match(result.stderr, /inventory bytes changed/i); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
console.log('PASS all three reviewed inventories refuse byte tampering');
