import assert from 'node:assert/strict';

export function assertActiveIdentityOperationOwnership(boundaries) {
  const paths = boundaries.flatMap(boundary => boundary.paths.map(entry => entry.sourcePath));
  assert.equal(new Set(paths).size, paths.length,
    'each active identity source path must have exactly one public-operation owner');
}
