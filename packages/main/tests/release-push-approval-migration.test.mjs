import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const approval = await import(join(repoRoot, 'packages/main/dist/core/release-push-approval.js'));

const created = approval.createReleasePushApproval({
  root: repoRoot,
  sha: 'abc123',
  remote: 'origin',
  ttlSeconds: 30,
  approvedBy: 'migration-test',
  now: new Date('2026-01-01T00:00:00.000Z'),
});
assert.equal(created.schema, 'proof-or-stop.remote-push-approval.v1');
assert.equal(created.branch, 'refs/heads/main');
assert.equal(created.expiresAt, '2026-01-01T00:00:30.000Z');
assert.equal(approval.LEGACY_RELEASE_PUSH_APPROVAL_SCHEMA, 'lattice.remote-push-approval.v1');
assert.equal(approval.releasePushApprovalPath(repoRoot), join(repoRoot, '.proof-or-stop/tmp/remote-push-approval.json'));

const source = readFileSync(join(repoRoot, 'packages/main/src/core/release-push-approval.ts'), 'utf8');
const hook = readFileSync(join(repoRoot, '.githooks/pre-push'), 'utf8');
for (const schema of [approval.RELEASE_PUSH_APPROVAL_SCHEMA, approval.LEGACY_RELEASE_PUSH_APPROVAL_SCHEMA]) {
  assert.ok(source.includes(schema) || hook.includes(schema), `${schema} remains readable`);
}
assert.match(hook, /acceptedApprovalSchemas/);

console.log('release-push-approval migration test passed');
