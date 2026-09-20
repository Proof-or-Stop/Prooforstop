import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { identityChildClosure, CANONICAL } from '../../../scripts/identity-child-closure.mjs';

// Inspect and execute the actual suite dispatcher, without launching the old
// mutation campaign. This proves selection only, not retained behavior GREEN.
const path = new URL('./canonical-new-story-artifacts.test.mjs', import.meta.url);
const source = readFileSync(path, 'utf8');
const ast = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const registrations = [];
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'check') {
    const [groups, name] = node.arguments;
    if (ts.isStringLiteral(name)) registrations.push({ name: name.text, groups: vm.runInNewContext(groups.getText(ast)), callback: node.arguments[2] });
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const matrix = registrations.filter(row => row.name === 'CHK-007:adversarial:0 every registered identity boundary rejects through its public operation with zero mutation');
assert.equal(matrix.length, 1, 'archive must retain one discoverable campaign');
const dispatch = source.slice(source.indexOf('async function check(groups, name, fn) {'), source.indexOf('\nconst NOW ='));
const selections = [];
const contract = JSON.parse(readFileSync(new URL('../../../scripts/identity-child-contract.json', import.meta.url), 'utf8'));
for (const selectedGroup of [null, 'identity-cutover', 'identity-config-boundary', 'identity-policy-boundary', 'f050', 'round24', 'identity-migration-archive']) {
  let executions = 0;
  const context = vm.createContext({ selectedGroup, failures: [], process: { pid: process.pid, hrtime: process.hrtime, stdout: { write() {} }, stderr: { write() {} } } });
  vm.runInContext(dispatch, context);
  await context.check(matrix[0].groups, matrix[0].name, async () => { executions++; });
  selections.push({ group: selectedGroup ?? 'default-all', executions });
  const closure = identityChildClosure({ ts, file: CANONICAL, text: source, ast,
    argv: selectedGroup === null ? [] : ['--group=' + selectedGroup], contract });
  assert.deepEqual(closure.errors, [], 'static selector contract must remain valid');
  assert.equal(closure.shouldSkip(matrix[0].callback), executions === 0, 'static dependency traversal must agree with runtime selection');
}
console.log('MIGRATION_MATRIX_SELECTION ' + JSON.stringify(selections));
assert.ok(selections.slice(0, -1).every(row => row.executions === 0), 'RETIRED_MATRIX_STILL_ROUTINE: the authorized retired campaign must not run through routine or default selectors');
assert.equal(selections.at(-1).executions, 1, 'explicit archive selector must remain executable');
const normal = registrations.find(row => row.name === 'CHK-007 canonical controls: every distinct registered public operation succeeds before mutation');
assert.ok(normal?.groups.includes('identity-canonical'), 'normal public-operation controls must remain separately selectable');
const retained = registrations.find(row => row.name === 'normal consumer controls and invalid project configuration retain zero-mutation checks');
assert.ok(retained?.groups.includes('identity-consumer-smoke'), 'consumer controls and project-config negative cases must not retire with the matrix');
console.log('IDENTITY_RETIREMENT_SELECTION_GREEN: routine campaign calls zero; explicit archive call one; normal controls retained');
