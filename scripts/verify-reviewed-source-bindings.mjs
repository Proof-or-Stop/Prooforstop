// Bounded source-identity acceptance; the broader fixture/JSON suite remains separate.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { runInNewContext } from 'node:vm';
import { validateReviewedSourceSources, reviewedSourceResidueAllowed } from './identity-reviewed-source-contexts.mjs';

const read = path => readFileSync(path, 'utf8');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const scripts = JSON.parse(read('package.json')).scripts;
assert.equal(scripts['test:reviewed-source-bindings'], 'node scripts/verify-reviewed-source-bindings.mjs',
  'REVIEWED_SOURCE_TEST_MUST_BE_IN_ROUTINE_SUITE');
assert.equal(scripts['test:serial-reference'].split(' && ')
  .filter(command => command === 'npm run test:reviewed-source-bindings').length, 1,
  'REVIEWED_SOURCE_TEST_MUST_BE_IN_ROUTINE_SUITE');
console.log('PASS routine registration: exact npm script and one serial-reference membership');
// Main metadata refresh may move reviewed lines, never their context or policy.
const refreshedPaths = ["packages/main/src/core/process-fact-levels.ts", "packages/main/src/core/runtime-fact-registry.ts", "packages/main/src/core/runtime-environment-checks.ts"];
const refreshedRows = JSON.parse(read('scripts/identity-reviewed-source-data.json')).entries
  .filter(row => refreshedPaths.includes(row.path))
  .map(({ sourceSha256, lineNumber, ...context }) => context);
assert.equal(refreshedRows.length, 6, 'exact six reviewed main contexts required');
assert.equal(sha(JSON.stringify(refreshedRows)), '9e4bfc94c6066c7cfe7e66e5317a54eb44923d7980fc74fbc1996c950067435f',
  'reviewed main context text, token counts, classification and reason must remain exact');
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

// Inspect the actual scanner declarations so a source refresh cannot leave a
// second, contradictory whole-file witness behind in either consumer table.
const scannerAst = ts.createSourceFile('scanner.mjs', scanner, ts.ScriptTarget.Latest, true);
const witnessNames = ['BOTH_FAMILY_CONTEXT_ROWS', 'BOTH_FAMILY_CONTEXT_WITNESSES', 'REVIEWED_NEGATIVE_SOURCE_INTEGRITY'];
const declarations = new Map();
for (const statement of scannerAst.statements) {
  if (!ts.isVariableStatement(statement)) continue;
  for (const declaration of statement.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name) && witnessNames.includes(declaration.name.text)) {
      assert.ok(declaration.initializer);
      assert.equal(declarations.has(declaration.name.text), false);
      declarations.set(declaration.name.text, declaration.initializer.getText(scannerAst));
    }
  }
}
assert.equal(declarations.size, witnessNames.length);
const witnessTables = runInNewContext(witnessNames.map(name => `const ${name} = ${declarations.get(name)};`).join('\n')
  + '\n[BOTH_FAMILY_CONTEXT_WITNESSES, REVIEWED_NEGATIVE_SOURCE_INTEGRITY]', {}, { timeout: 1000 });
const sharedPath = 'packages/main/src/core/runtime-environment-checks.ts';
function checkSharedWitnesses(tables) {
  for (const table of tables) {
    const matches = table.filter(pin => pin.path === sharedPath);
    assert.equal(matches.length, 1, 'REVIEWED_SHARED_SOURCE_WITNESS_MUST_MATCH');
    assert.equal(matches[0].sha256, sha(read(sharedPath)), 'REVIEWED_SHARED_SOURCE_WITNESS_MUST_MATCH');
  }
}
checkSharedWitnesses(witnessTables);
for (const tableIndex of [0, 1]) {
  for (const remove of [false, true]) {
    const mutated = JSON.parse(JSON.stringify(witnessTables));
    const index = mutated[tableIndex].findIndex(pin => pin.path === sharedPath);
    if (remove) mutated[tableIndex].splice(index, 1);
    else mutated[tableIndex][index].sha256 = '0'.repeat(64);
    assert.throws(() => checkSharedWitnesses(mutated), /REVIEWED_SHARED_SOURCE_WITNESS_MUST_MATCH/);
  }
}
console.log('PASS shared source witness closure: both actual scanner tables and four omission/stale controls');

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
