import assert from 'node:assert/strict';

// One reviewed producer contains different identity sites used by two public
// consumers. Sharing a path does not share or omit either consumer's test.
const sharedPath = 'packages/main/src/core/verification-execution-evidence.ts';
const reviewedSharedOwners = new Map([
  ['review-incremental-context', 'proof-or-stop.verifier-dependency-manifest-binding.v1'],
  ['review-inventory-epoch', 'proof-or-stop.verification-receipt-bundle.v5'],
]);

export function assertActiveIdentityOperationOwnership(boundaries) {
  assert.equal(new Set(boundaries.map(boundary => boundary.id)).size, boundaries.length,
    'duplicate identity operation boundary');
  const owners = new Map();
  for (const boundary of boundaries) {
    const paths = boundary.paths.map(entry => entry.sourcePath);
    assert.equal(new Set(paths).size, paths.length, `${boundary.id}: duplicate path owner`);
    for (const path of paths) {
      const entries = owners.get(path) ?? [];
      entries.push(boundary);
      owners.set(path, entries);
    }
  }
  for (const [path, entries] of owners) {
    if (path !== sharedPath) {
      assert.equal(entries.length, 1, `${path}: unreviewed shared identity path`);
    }
  }
  const shared = owners.get(sharedPath) ?? [];
  assert.deepEqual(shared.map(boundary => boundary.id).sort(), [...reviewedSharedOwners.keys()].sort(),
    'shared identity path must retain exactly its two reviewed public-operation owners');
  for (const boundary of shared) {
    const sites = boundary.identitySites.filter(site => site.sourcePath === sharedPath);
    const canonical = reviewedSharedOwners.get(boundary.id);
    assert.deepEqual(sites.map(site => site.canonical), [canonical],
      `${boundary.id}: shared path must retain its distinct reviewed identity site`);
    assert.equal(sites[0].siteId, `${sharedPath}#${canonical}`,
      `${boundary.id}: shared identity site must retain its exact path and value binding`);
  }
}
