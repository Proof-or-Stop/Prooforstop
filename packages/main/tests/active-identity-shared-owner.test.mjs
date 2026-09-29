import assert from 'node:assert/strict';
import { ACTIVE_IDENTITY_OPERATION_BOUNDARIES } from '../dist/core/runtime-environment-checks.js';
import { assertActiveIdentityOperationOwnership } from './support/active-identity-operation-ownership.mjs';

const path = 'packages/main/src/core/executable-digest-observation.ts';
const boundary = rows => rows.find(row => row.id === 'review-incremental-context');
// Reconcile the real registry, including both identity-bearing and identity-free shared paths.
try {
  assertActiveIdentityOperationOwnership(ACTIVE_IDENTITY_OPERATION_BOUNDARIES);
} catch (error) {
  throw new Error('IDENTITY_SHARED_DELEGATE_REJECTED: reviewed identity-free delegate must retain both public-operation owners', { cause: error });
}
for (const mutation of ['third-owner', 'missing-owner', 'extra-identity', 'missing-classification', 'duplicate-classification', 'wrong-classification', 'unreviewed-shared-path']) {
  const rows = structuredClone(ACTIVE_IDENTITY_OPERATION_BOUNDARIES);
  const owner = boundary(rows);
  if (mutation === 'third-owner') rows.push({ ...structuredClone(owner), id: 'unreviewed-third-owner', paths: owner.paths.filter(p => p.sourcePath === path), identitySites: [], pathBindings: owner.pathBindings.filter(p => p.sourcePath === path) });
  if (mutation === 'missing-owner') owner.paths = owner.paths.filter(p => p.sourcePath !== path);
  if (mutation === 'extra-identity') owner.identitySites.push({ sourcePath: path, canonical: 'proof-or-stop.unreviewed.v1', siteId: `${path}#proof-or-stop.unreviewed.v1` });
  if (mutation === 'missing-classification') owner.pathBindings = owner.pathBindings.filter(p => p.sourcePath !== path);
  if (mutation === 'duplicate-classification') owner.pathBindings.push(structuredClone(owner.pathBindings.find(p => p.sourcePath === path)));
  if (mutation === 'wrong-classification') owner.pathBindings.find(p => p.sourcePath === path).classification = 'identity-bearing';
  if (mutation === 'unreviewed-shared-path') for (const row of rows.filter(p => ['review-incremental-context', 'review-inventory-epoch'].includes(p.id))) row.paths.push({ sourcePath: 'packages/main/src/core/unreviewed-shared.ts' });
  assert.throws(() => assertActiveIdentityOperationOwnership(rows), undefined, `${mutation} must remain rejected`);
}
console.log('IDENTITY_SHARED_DELEGATE_GREEN: actual registry and seven negative controls');
