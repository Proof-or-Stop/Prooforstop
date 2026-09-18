import assert from 'node:assert/strict';

// One reviewed producer contains different identity sites used by two public
// consumers. Sharing a path does not share or omit either consumer's test.
const sharedPath = 'packages/main/src/core/verification-execution-evidence.ts';
// Both consumers delegate executable reads to this identity-free implementation.
// This exact ownership declaration does not admit arbitrary shared paths or sites.
const sharedDelegatePath = 'packages/main/src/core/executable-digest-observation.ts';
const sharedDelegateOwners = ['review-incremental-context', 'review-inventory-epoch'];
const reviewedSharedOwners = new Map([
  ['review-incremental-context', ['proof-or-stop.verifier-dependency-manifest-binding.v1']],
  ['review-inventory-epoch', ["proof-or-stop-verification-receipt-signer-v1.key", "proof-or-stop.verification-assertion-receipt.v1", "proof-or-stop.verification-assertion-receipt.v2", "proof-or-stop.verification-execution-identity.v1", "proof-or-stop.verification-execution-key.v1", "proof-or-stop.verification-execution-lock.v1", "proof-or-stop.verification-execution-receipt.v2", "proof-or-stop.verification-execution-receipt.v3", "proof-or-stop.verification-execution-ticket.v1", "proof-or-stop.verification-output.v1", "proof-or-stop.verification-publication-binding.v1", "proof-or-stop.verification-receipt-bundle-binding.v1", "proof-or-stop.verification-receipt-bundle.v2", "proof-or-stop.verification-receipt-bundle.v3", "proof-or-stop.verification-receipt-bundle.v4", "proof-or-stop.verification-receipt-bundle.v5", "proof-or-stop.verification-record-authenticity.v1", "proof-or-stop.verification-record.v1", "proof-or-stop.verification-reuse-receipt.v1"]],
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
    if (path !== sharedPath && path !== sharedDelegatePath) {
      assert.equal(entries.length, 1, `${path}: unreviewed shared identity path`);
    }
  }
  const delegates = owners.get(sharedDelegatePath) ?? [];
  assert.deepEqual(delegates.map(boundary => boundary.id).sort(), sharedDelegateOwners,
    'shared identity-free delegate must retain exactly its two reviewed owners');
  for (const boundary of delegates) {
    assert.equal(boundary.identitySites.filter(site => site.sourcePath === sharedDelegatePath).length, 0,
      `${boundary.id}: shared delegate cannot gain an unreviewed identity site`);
    const bindings = boundary.pathBindings.filter(binding => binding.sourcePath === sharedDelegatePath);
    assert.equal(bindings.length, 1, `${boundary.id}: shared delegate needs one explicit classification`);
    assert.equal(bindings[0].classification, 'identity-free',
      `${boundary.id}: shared delegate must remain identity-free`);
  }
  const shared = owners.get(sharedPath) ?? [];
  assert.deepEqual(shared.map(boundary => boundary.id).sort(), [...reviewedSharedOwners.keys()].sort(),
    'shared identity path must retain exactly its two reviewed public-operation owners');
  for (const boundary of shared) {
    const sites = boundary.identitySites.filter(site => site.sourcePath === sharedPath);
    const expected = reviewedSharedOwners.get(boundary.id);
    assert.deepEqual(sites.map(site => site.canonical).sort(), [...expected].sort(),
      `${boundary.id}: shared path must retain its distinct reviewed identity site`);
    for (const site of sites) assert.equal(site.siteId, `${sharedPath}#${site.canonical}`,
      `${boundary.id}: shared identity site must retain its exact path and value binding`);
  }
}
