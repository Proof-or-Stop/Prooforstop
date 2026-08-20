import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const distName = existsSync(join(packageRoot, 'dist', 'core', 'agent-role-identity.js'))
  ? 'dist'
  : 'dist.staging';
const distRoot = join(packageRoot, distName);

const identity = await import(join(distRoot, 'core/agent-role-identity.js'));
const dispatch = await import(join(distRoot, 'core/agent-dispatch-registry.js'));

const aliases = [
  ['lattice-implementer', 'proof-or-stop-implementer'],
  ['lattice-review-concept', 'proof-or-stop-review-concept'],
  ['lattice-review-quality@fallback', 'proof-or-stop-review-quality@fallback'],
  ['verification-intent', 'proof-or-stop-test-intent'],
];
for (const [legacy, canonical] of aliases) {
  assert.equal(identity.canonicalAgentRoleId(legacy), canonical, `${legacy} canonicalizes`);
  assert.equal(identity.agentRoleIdsEqual(legacy, canonical), true, `${legacy} compares equal to its canonical role`);
}

assert.equal(dispatch.resolveAgentDispatchType('lattice-review-quality').canonicalType, 'proof-or-stop-review-quality');
assert.equal(dispatch.resolveAgentDispatchType('verification-intent').canonicalType, 'proof-or-stop-test-intent');
assert.throws(() => dispatch.resolveAgentDispatchType('lattice-review-unknown'), /unknown agentType/);
assert.throws(() => dispatch.resolveAgentDispatchType('proof-or-stop-review-quality@fallback'), /unknown agentType/);

console.log('brand-role migration test passed');
