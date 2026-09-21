import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const entry = 'packages/main/tests/red/red-B-e40f-quorum-submit-harness.mjs';
const source = fs.readFileSync(entry, 'utf8');
const ast = ts.createSourceFile(entry, source, ts.ScriptTarget.Latest, true);
assert.ok(source.split('\n').length <= 40 && ast.statements.every(node => ts.isImportDeclaration(node) || ts.isExpressionStatement(node)), 'QUORUM_ENTRYPOINT_NOT_THIN: isolate capabilities and supervision behind the original entry');
console.log('QUORUM_ENTRYPOINT_STRUCTURE_GREEN');
const { execFileSync, spawnSync } = await import('node:child_process');
const before = ts.createSourceFile(entry, execFileSync('git', ['show', '57205854d1:' + entry], { encoding: 'utf8' }), ts.ScriptTarget.Latest, true);
const directory = 'packages/main/tests/red/quorum-submit-harness';
const modules = new Map();
const functions = new Map();
for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.mjs'))) {
  const text = fs.readFileSync(directory + '/' + name, 'utf8');
  assert.ok(text.split('\n').length <= 2000, 'QUORUM_MODULE_EXCEEDS_2000: ' + name);
  const parsed = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  modules.set(name, parsed);
  for (const node of parsed.statements) if (ts.isFunctionDeclaration(node)) functions.set(node.name.text, node.body.getText(parsed));
}
let count = 0;
for (const node of before.statements) if (ts.isFunctionDeclaration(node)) {
  assert.equal(functions.get(node.name.text), node.body.getText(before), 'original quorum function retained: ' + node.name.text);
  count++;
}
const getDeclaration = (ast, name) => ast.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(ast) === name);
assert.equal(getDeclaration(modules.get('catalog.mjs'), 'SUPPORTED_CASES').initializer.getText(modules.get('catalog.mjs')), getDeclaration(before, 'SUPPORTED_CASES').initializer.getText(before), 'all original case-to-function bindings unchanged');
const driver = modules.get('driver.mjs');
const driverBody = driver.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'runSelectedHarness').body;
assert.deepEqual(driverBody.statements.map(node => node.getText(driver)), before.statements.slice(-2).map(node => node.getText(before).replace('parseHarnessCase(process.argv.slice(2))', 'parseHarnessCase(args)')), 'case-specific isolation, error classification and full invocation order unchanged');
console.log('QUORUM_ORIGINAL_FUNCTIONS_PRESERVED ' + count);
const run = args => spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
const list = run(['--list-capabilities']);
assert.equal(list.status, 0, list.stderr);
const capabilities = JSON.parse(list.stdout);
assert.equal(capabilities.length, 18);
assert.ok(capabilities.every(row => row.completeSuite === false));
for (const args of [[], ['--all'], ['--capability='], ['--capability=missing'], ['--case=inventory-bijection', '--capability=inventory-bijection'], ['--capability=inventory-bijection', '--capability=selector-contract']]) {
  const result = run(args);
  assert.equal(result.status, 2, JSON.stringify(args) + result.stderr);
  assert.match(result.stderr, /HARNESS_USAGE/);
  assert.doesNotMatch(result.stdout, /GREEN /);
}
const bounded = ['inventory-bijection', 'performance-preflight-isolation-contract', 'performance-host-accounting-contract', 'performance-idle-wait-contract', 'performance-idle-budget-contract', 'performance-preflight-idle-contract', 'performance-contamination-retry-contract'];
for (const id of bounded) {
  const started = performance.now();
  const result = run(['--capability=' + id]);
  console.log('QUORUM_CASE_RESULT ' + JSON.stringify({ id, code: result.status, signal: result.signal, error: result.error?.message, elapsedMs: performance.now() - started }));
  console.log(result.stdout.slice(-2000));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('GREEN ' + id));
}
const duplicate = run(['--capability=performance-idle-budget-contract', '--capability=performance-idle-budget-contract']);
assert.equal(duplicate.status, 0, duplicate.stderr);
assert.equal(duplicate.stdout.split('GREEN performance-idle-budget-contract').length - 1, 1);
const legacy = run(['--case=performance-idle-budget-contract']);
assert.equal(legacy.status, 0, legacy.stderr);
assert.equal(legacy.stdout, duplicate.stdout, 'legacy selector and deduplicated capability are equivalent');
console.log('QUORUM_MODULAR_SCOPED_GREEN: 18 bindings preserved, 7 bounded contracts executed; heavy performance and isolated campaigns not rerun');
