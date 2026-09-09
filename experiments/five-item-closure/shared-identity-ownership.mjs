import assert from 'node:assert/strict';
import { ACTIVE_IDENTITY_OPERATION_BOUNDARIES } from '../../packages/main/dist/core/runtime-environment-checks.js';
import { assertActiveIdentityOperationOwnership } from '../../packages/main/tests/support/active-identity-operation-ownership.mjs';

try {
  assertActiveIdentityOperationOwnership(ACTIVE_IDENTITY_OPERATION_BOUNDARIES);
} catch (error) {
  throw new Error('SHARED_IDENTITY_OPERATION_OWNERSHIP_REJECTED: ' + error.message, {cause:error});
}
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
