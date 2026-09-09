import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { ACTIVE_IDENTITY_OPERATION_BOUNDARIES } from '../../packages/main/dist/core/runtime-environment-checks.js';
import { assertActiveIdentityOperationOwnership } from '../../packages/main/tests/support/active-identity-operation-ownership.mjs';

try {
  assertActiveIdentityOperationOwnership(ACTIVE_IDENTITY_OPERATION_BOUNDARIES);
} catch (error) {
  throw new Error('SHARED_IDENTITY_OPERATION_OWNERSHIP_REJECTED: ' + error.message, {cause:error});
}
// Read the independent literal used by the full suite instead of deriving the
// expected inventory from the production registry under test.
const testSource = ts.createSourceFile('canonical-new-story-artifacts.test.mjs',
  readFileSync(new URL('../../packages/main/tests/canonical-new-story-artifacts.test.mjs', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declarations = testSource.statements.filter(ts.isVariableStatement)
  .flatMap(statement => [...statement.declarationList.declarations])
  .filter(declaration => declaration.name.getText(testSource) === 'IDENTITY_CUTOVER_REQUIRED_PATHS');
assert.equal(declarations.length, 1, 'one independent required-path inventory');
const initializer = declarations[0].initializer;
assert.ok(ts.isCallExpression(initializer) && initializer.expression.getText(testSource) === 'Object.freeze');
assert.equal(initializer.arguments.length, 1);
const literal = initializer.arguments[0];
assert.ok(ts.isArrayLiteralExpression(literal) && literal.elements.every(ts.isStringLiteral));
const requiredPaths = literal.elements.map(element => element.text);
const registeredPaths = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.flatMap(boundary => boundary.paths.map(entry => entry.sourcePath));
const assertInventory = required => {
  assert.equal(new Set(required).size, required.length, 'duplicate independent required path');
  assert.deepEqual([...new Set(registeredPaths)].sort(), [...required].sort(),
    'IDENTITY_OPERATION_REQUIRED_INVENTORY_MISSING: exact independent inventory must match every registered public-operation path');
};
assertInventory(requiredPaths);
assert.throws(() => assertInventory(requiredPaths.slice(1)), /IDENTITY_OPERATION_REQUIRED_INVENTORY_MISSING/);
assert.throws(() => assertInventory([...requiredPaths, 'unregistered-source.ts']), /IDENTITY_OPERATION_REQUIRED_INVENTORY_MISSING/);
assert.throws(() => assertInventory([...requiredPaths, requiredPaths[0]]), /duplicate independent required path/);
console.log('PASS independent required inventory: missing, unregistered and duplicate paths refused');
const sharedPath = 'packages/main/src/core/verification-execution-evidence.ts';
const cases = [
  ['duplicate path in one boundary', rows => rows[0].paths.push(structuredClone(rows[0].paths[0]))],
  ['duplicate boundary', rows => rows.push(structuredClone(rows[0]))],
  ['unreviewed shared path', rows => rows[1].paths.push(structuredClone(rows[0].paths[0]))],
  ['missing shared owner', rows => {const b=rows.find(x=>x.id==='review-incremental-context');b.paths=b.paths.filter(x=>x.sourcePath!==sharedPath);}],
  ['wrong shared owner', rows => {rows.find(x=>x.id==='review-inventory-epoch').id='unreviewed-review-owner';}],
  ['duplicate shared site owner', rows => {const from=rows.find(x=>x.id==='review-incremental-context');const to=rows.find(x=>x.id==='review-inventory-epoch');to.identitySites.push(structuredClone(from.identitySites.find(x=>x.sourcePath===sharedPath)));}],
  ['shared path without owned sites', rows => {const b=rows.find(x=>x.id==='review-incremental-context');b.identitySites=b.identitySites.filter(x=>x.sourcePath!==sharedPath);}],
];
for (const [name, mutate] of cases) {
  const rows=structuredClone(ACTIVE_IDENTITY_OPERATION_BOUNDARIES);mutate(rows);
  assert.throws(()=>assertActiveIdentityOperationOwnership(rows),undefined,name);
  console.log('PASS shared identity ownership refusal: '+name);
}
console.log('SHARED_IDENTITY_OPERATION_OWNERSHIP_GREEN');
