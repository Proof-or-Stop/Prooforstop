// Bounded reviewed-identity closure; full active-residue scanning and native route execution remain separate.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { runInNewContext } from 'node:vm';
import { validateReviewedSourceSources, reviewedSourceResidueAllowed } from './identity-reviewed-source-contexts.mjs';
import { validateReviewedFixtureSources } from './identity-reviewed-fixture-contexts.mjs';

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
const allReviewedRows = JSON.parse(read('scripts/identity-reviewed-source-data.json')).entries;
const causalToken = ['proof', 'bound.causal-evidence-index.v1'].join('');
const causalRows = allReviewedRows.filter(row => row.path === 'packages/main/src/core/runtime-environment-checks.ts' && row.token === causalToken);
assert.equal(causalRows.length, 1, 'exact causal-origin negative-source row required');
const refreshedRows = allReviewedRows
  .filter(row => refreshedPaths.includes(row.path) && row !== causalRows[0])
  .map(({ sourceSha256, lineNumber, ...context }) => context);
assert.equal(refreshedRows.length, 6, 'exact six reviewed main contexts required');
assert.equal(sha(JSON.stringify(refreshedRows)), '9e4bfc94c6066c7cfe7e66e5317a54eb44923d7980fc74fbc1996c950067435f',
  'reviewed main context text, token counts, classification and reason must remain exact');
// Every protected field in every refreshed row remains part of the digest.
for (const [index, row] of refreshedRows.entries()) {
  for (const field of ['token', 'tokenOccurrences', 'classification', 'reason', 'lineSha256']) {
    const mutated = structuredClone(refreshedRows);
    mutated[index][field] = typeof row[field] === 'number' ? row[field] + 1 : row[field] + ' changed';
    assert.notEqual(sha(JSON.stringify(mutated)), '9e4bfc94c6066c7cfe7e66e5317a54eb44923d7980fc74fbc1996c950067435f',
      `reviewed context mutation must refuse: ${index}:${field}`);
  }
}
console.log('PASS reviewed context digest: six inherited rows retain token/count/classification/reason/line-hash sensitivity');
// The source occurrence is the fourth argument (retired refusal needle) of
// identitySite for the central causal index, paired with identityOrigin and the
// following identityMutationCase; it is not the emitted schema value. Runtime
// admission and the canonical identity-sites group are outside this verifier.
const causalContext = { ...causalRows[0] };
delete causalContext.sourceSha256; delete causalContext.lineNumber;
assert.equal(sha(JSON.stringify(causalContext)), 'f91c882eada425b2e61290d6aab85f1805b5eb5ea37905fe1fb37db1ddc167c7', 'exact causal-origin refusal context must remain closed');
const causalRow = causalRows[0], causalText = read(causalRow.path);
const causalLine = causalText.split(/\r?\n/)[causalRow.lineNumber - 1];
const causalInput = { path: causalRow.path, token: causalRow.token, lineNumber: causalRow.lineNumber, line: causalLine, text: causalText };
assert.equal(reviewedSourceResidueAllowed(causalInput), true);
for (const [label, changed] of [
  ['token replacement', causalText.replace(causalRow.token, causalRow.token + '-changed')],
  ['additional occurrence', causalText + '\n// ' + causalRow.token + '\n'],
  ['same-count context change', causalText.replace(causalLine, causalLine + ' // changed context')],
]) {
  assert.notEqual(changed, causalText);
  if (label === 'same-count context change') assert.equal(changed.split(causalRow.token).length - 1, causalRow.tokenOccurrences);
  assert.equal(reviewedSourceResidueAllowed({ ...causalInput, text: changed, line: changed.split(/\r?\n/)[causalRow.lineNumber - 1] }), false, label);
  assert(validateReviewedSourceSources(path => path === causalRow.path ? changed : read(path))
    .includes(`reviewed source changed: ${causalRow.path}:${causalRow.lineNumber}`), label);
}
console.log('PASS causal-origin consumers: exact positive and token/additional-occurrence/same-count-context refusals in both source reader APIs');

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
const sharedPaths = [...new Set(witnessTables[0].map(pin => pin.path))]
  .filter(path => witnessTables[1].some(pin => pin.path === path));
assert.ok(sharedPaths.includes(sharedPath), 'reviewed runtime source must retain both consumers');
function checkSharedWitnesses(tables) {
  for (const path of sharedPaths) {
    for (const table of tables) {
      const matches = table.filter(pin => pin.path === path);
      assert.equal(matches.length, 1, 'REVIEWED_SHARED_SOURCE_WITNESS_MUST_MATCH');
      assert.equal(matches[0].sha256, sha(read(path)), 'REVIEWED_SHARED_SOURCE_WITNESS_MUST_MATCH');
    }
  }
}
checkSharedWitnesses(witnessTables);
for (const path of sharedPaths) {
  for (const tableIndex of [0, 1]) {
    for (const mutation of ['remove', 'stale', 'duplicate']) {
      const mutated = JSON.parse(JSON.stringify(witnessTables));
      const index = mutated[tableIndex].findIndex(pin => pin.path === path);
      if (mutation === 'remove') mutated[tableIndex].splice(index, 1);
      else if (mutation === 'duplicate') mutated[tableIndex].push({ ...mutated[tableIndex][index] });
      else mutated[tableIndex][index].sha256 = '0'.repeat(64);
      assert.throws(() => checkSharedWitnesses(mutated), /REVIEWED_SHARED_SOURCE_WITNESS_MUST_MATCH/,
        'EVERY_SHARED_WITNESS_MUTATION_MUST_REFUSE: ' + path + ':' + tableIndex + ':' + mutation);
    }
  }
}
console.log(`PASS shared source witness closure: ${sharedPaths.length} shared paths; ${sharedPaths.length * 6} omission/stale/duplicate controls`);

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
    ...['token', 'tokenOccurrences', 'classification', 'reason', 'lineSha256'].map(field => [
      'causal-row-' + field,
      original.entries.map(row => row.path === causalRow.path && row.token === causalRow.token
        ? { ...row, [field]: typeof row[field] === 'number' ? row[field] + 1 : row[field] + ' changed' } : row),
    ]),
  ]) {
    writeFileSync(join(scratch, dataName), name === 'original' ? bytes : JSON.stringify({ ...original, entries }));
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(scratch, moduleName)).href)})`], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    if (name === 'original') assert.equal(result.status, 0, result.stderr);
    else { assert.equal(result.status, 1); assert.match(result.stderr, /inventory bytes changed/i); }
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
console.log('PASS source inventory consumer: original accepted; deleted/duplicate rows and five causal-row protected-field mutations rejected by actual reader import');

// Run the actual fixture consumer against every current pinned target. Import
// itself also enforces the exact inventory digest and row count.
assert.deepEqual(validateReviewedFixtureSources(read), [], 'REVIEWED_FIXTURE_BINDINGS_MUST_MATCH_CURRENT_SOURCE');
console.log('PASS current fixture reader: all pinned fixture sources accepted');

// Execute the unchanged route driver's own closure block without its native
// suite. AST selection fails closed if its declaration/loop shape changes.
const routePath = 'scripts/verify-route-reader-regression.mjs';
const routeText = read(routePath), routeTree = ts.createSourceFile(routePath, routeText, ts.ScriptTarget.Latest, true);
const routeClosureDeclaration = routeTree.statements.filter(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(decl => ts.isIdentifier(decl.name) && decl.name.text === 'closure'));
const routeClosureCount = routeTree.statements.filter(node => ts.isExpressionStatement(node)
  && node.getText(routeTree).includes("assert.equal(closure.length, 4,"));
const routeClosureLoop = routeTree.statements.filter(node => ts.isForOfStatement(node)
  && node.statement.getText(routeTree).includes('closure.every(entry => entry.dependencyDigests[file] === digest)'));
assert.equal(routeClosureDeclaration.length, 1); assert.equal(routeClosureCount.length, 1); assert.equal(routeClosureLoop.length, 1);
const routeClosureProgram = [...routeClosureDeclaration, ...routeClosureCount, ...routeClosureLoop].map(node => node.getText(routeTree)).join('\n');
const executeRouteClosure = readFile => runInNewContext(routeClosureProgram,
  { assert, readFileSync: readFile, resolve, root: process.cwd(), createHash }, { timeout: 1000 });
executeRouteClosure(readFileSync);
const staticPath = resolve('scripts/lab/u18-static-edges/exceptions.json');
for (const mutation of ['remove-entry', 'stale-digest']) {
  const manifest = JSON.parse(read(staticPath));
  const index = manifest.entries.findIndex(entry => entry.dependencyDigests?.['packages/main/tests/red/red-dynamic-finding-four-gaps.mjs']);
  assert(index >= 0);
  if (mutation === 'remove-entry') manifest.entries.splice(index, 1);
  else manifest.entries[index].dependencyDigests['scripts/identity-reviewed-source-contexts.mjs'] = '0'.repeat(64);
  assert.throws(() => executeRouteClosure((path, ...args) => resolve(String(path)) === staticPath
    ? JSON.stringify(manifest) : readFileSync(path, ...args)), /closure must remain complete|helper dependency must match current source/);
}
console.log('PASS actual route dependency closure: four entries/current driver paths; missing-entry and stale-digest refusals; native route suite not run');

// Self-test derives schemaRows from the real tracked files, calls the same
// verifySchemaInventory as default mode, and mutates every compatibility row.
// It does not execute this source verifier. Full active-residue mode remains a
// separately reported inherited baseline failure, never relabelled by this test.
for (const [args, selector] of [
  [['scripts/verify-proof-or-stop-identity-cutover.mjs', '--self-test'], 'PASS identity-cutover self-test:'],
  [['scripts/verify-validation-static-edges.mjs'], 'U18_STATIC_PASS'],
]) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.error, undefined, String(result.error)); assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert(result.stdout.includes(selector), result.stdout + result.stderr);
  console.log(`PASS current candidate consumer: node ${args.join(' ')}; ${selector}`);
}
console.log('PASS reviewed identity final-head closure: source, fixture, actual schema self-test, static edges and bounded route dependencies; full scanner/native route not claimed');

// Expose the exact unchanged dependency context in the candidate measurement;
// these runtime quotations add no retired literals to the verifier's source.
assert(causalLine.includes("identityOrigin: { sourcePath: 'packages/main/src/core/causal-evidence.ts', exportName: 'CAUSAL_EVIDENCE_INDEX_SCHEMA' }"));
const causalMutation = causalText.split(/\r?\n/).filter(line => line.includes("identityMutationCase('packages/main/src/core/store.ts', 'proof-or-stop.causal-evidence-index.v1')"));
assert.equal(causalMutation.length, 1);
const compatiblePath = 'scripts/verify-review-epoch-certification-continuity.mjs';
const compatibleText = read(compatiblePath), compatibleToken = ['lat', 'tice.managed_review_final_proposal.v1'].join('');
const compatibleLines = compatibleText.split(/\r?\n/).filter(line => line.includes(compatibleToken));
assert.equal(compatibleLines.length, 1);
assert(compatibleLines[0].includes(`finalAssistantResult:JSON.stringify({schemaVersion:'${compatibleToken}'`));
for (const evidence of [
  { path: causalRow.path, sha256: sha(causalText), meaning: 'refusal needle paired with canonical origin and mutation case', lines: [causalLine, ...causalMutation] },
  { path: compatiblePath, sha256: sha(compatibleText), meaning: 'accepted synthetic managed-review response; compatibility admission, not rejection fixture', lines: compatibleLines },
]) console.log('AUDIT_SOURCE_CONTEXT ' + JSON.stringify(evidence));
