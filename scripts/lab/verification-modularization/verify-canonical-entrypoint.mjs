import { verifyTopLevelPreservation } from './verify-modular-top-level-preservation.mjs';
verifyTopLevelPreservation('canonical');
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const path = 'packages/main/tests/canonical-new-story-artifacts.test.mjs';
const source = fs.readFileSync(path, 'utf8');
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
assert.ok(source.split('\n').length <= 40 && ast.statements.every(node => ts.isImportDeclaration(node) || ts.isExpressionStatement(node)), 'CANONICAL_ENTRYPOINT_NOT_THIN: separate artifact, identity, runtime and release capabilities');
console.log('CANONICAL_ENTRYPOINT_STRUCTURE_GREEN');
const { execFileSync, spawnSync } = await import('node:child_process');
const before = ts.createSourceFile(path, execFileSync('git', ['show', 'e07c723f5f:' + path], {encoding:'utf8'}), ts.ScriptTarget.Latest, true);
const directory = 'packages/main/tests/canonical-new-story-artifacts';
const modules = new Map();
const functions = new Map();
const restoreState = text => text.replace(/\bstate\.(freshFixture|runtimeTopologyFixture|publicIdentityOperationFixture|runtimeFixture|identityCutoverFixture|identityVerifierResult)\b/g, '$1');
for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.mjs'))) {
  const text = fs.readFileSync(directory + '/' + name, 'utf8');
  assert.ok(text.split('\n').length <= 2000, 'CANONICAL_MODULE_EXCEEDS_2000: ' + name);
  const parsed = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  assert.equal(parsed.parseDiagnostics.length, 0, name);
  modules.set(name, parsed);
  for (const node of parsed.statements) if (ts.isFunctionDeclaration(node)) functions.set(node.name.text, restoreState(node.body.getText(parsed)));
}
let functionCount = 0;
for (const node of before.statements) if (ts.isFunctionDeclaration(node)) {
  let expected = node.body.getText(before);
  if (node.name.text === 'check') expected = expected.replace("selectedGroup !== 'identity-migration-archive'", "!selectedGroups?.includes('identity-migration-archive')").replace('selectedGroup !== null && !groups.includes(selectedGroup)', 'selectedGroups !== null && !groups.some(group => selectedGroups.includes(group))');
  for (const repair of JSON.parse(fs.readFileSync('scripts/lab/verification-modularization/canonical-owned-site-repairs.json','utf8'))) if (repair.kind === 'function' && repair.name === node.name.text && expected === repair.before) expected = repair.after;
  assert.equal(functions.get(node.name.text), expected, 'retained canonical verification function: ' + node.name.text);
  functionCount++;
}
const driver = modules.get('driver.mjs');
const orderedModules = driver.statements.filter(ts.isImportDeclaration).filter(node => node.importClause?.namedBindings?.elements.some(element => element.propertyName?.text === 'runCases')).map(node => node.moduleSpecifier.text.slice(2));
const actual = orderedModules.flatMap(name => {
  const ast = modules.get(name);
  return ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'runCases').body.statements.map(node => restoreState(node.getText(ast)));
});
const relocate = node => {
  let text = node.getText(before); const edits = [];
  const visit = part => {
    if ((ts.isCallExpression(part) && part.expression.kind === ts.SyntaxKind.ImportKeyword) || (ts.isNewExpression(part) && part.expression.getText(before) === 'URL' && part.arguments?.[1]?.getText(before) === 'import.meta.url')) {
      const arg = part.arguments?.[0];
      if (arg && ts.isStringLiteral(arg) && arg.text.startsWith('.')) edits.push({start:arg.getStart(before)-node.getStart(before),end:arg.end-node.getStart(before),text:JSON.stringify('../'+arg.text)});
    }
    ts.forEachChild(part, visit);
  };
  visit(node); for (const edit of edits.sort((a,b)=>b.start-a.start)) text=text.slice(0,edit.start)+edit.text+text.slice(edit.end);
  return text;
};
const expected = before.statements.filter(node => {
  const line = before.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  return !ts.isImportDeclaration(node) && !ts.isVariableStatement(node) && !ts.isFunctionDeclaration(node) && ![37,41].includes(line) && line < 5370;
}).map(relocate).map(text => { for (const repair of JSON.parse(fs.readFileSync('scripts/lab/verification-modularization/canonical-owned-site-repairs.json', 'utf8'))) if (text === repair.before) text = repair.after; return text; });
assert.deepEqual(actual, expected, 'all original test statements retain order, callbacks and assertions');
console.log('CANONICAL_PRESERVATION_GREEN ' + JSON.stringify({functionCount, orderedStatements: actual.length, sharedFixtureSlots: 6}));
const run = args => spawnSync(process.execPath, [path, ...args], {encoding:'utf8', timeout:260000, maxBuffer:16*1024*1024});
const listed = run(['--list-capabilities']); assert.equal(listed.status, 0, listed.stderr);
const capabilities = JSON.parse(listed.stdout); assert.equal(capabilities.length, 25); assert.equal(capabilities.filter(row => row.archived).length, 1);
for (const args of [['--capability='], ['--capability=unknown'], ['--all', '--capability=identity-cache'], ['--group=identity-cache','--capability=identity-cache']]) {
  const result = run(args); assert.equal(result.status, 1); assert.match(result.stderr,/Unknown canonical artifact/); assert.doesNotMatch(result.stdout,/GREEN B-49df|PARTIAL_PASS/);
}
const combined = run(['--capability=identity-cache', '--capability=runtime-topology', '--capability=identity-cache']);
console.log(combined.stdout.slice(-6000)); console.error(combined.stderr.slice(-6000));
assert.equal(combined.status, 0, combined.stderr);
assert.match(combined.stdout, /CANONICAL_ARTIFACT_PARTIAL_PASS/);
assert.equal(combined.stdout.split('PASS identity text-fact cache is byte-exact bounded').length - 1, 1);
assert.doesNotMatch(combined.stdout, /all focused contracts pass|every registered identity boundary rejects/);
const legacy = run(['--group=identity-cache']); assert.equal(legacy.status, 0, legacy.stderr); assert.match(legacy.stdout, /GREEN B-49df: identity-cache group pass/); assert.doesNotMatch(legacy.stdout,/CANONICAL_ARTIFACT_PARTIAL_PASS/);
console.log('CANONICAL_MODULAR_SCOPED_GREEN: 25 groups retained; cache and topology executed; complete identity certification remains separate');
