import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { defaultHostRunRunner } from '../dist/core/host-run.js';

const base = { command: process.execPath, cwd: process.cwd(), env: process.env, timeoutMs: 3000, retainUsageLine: () => true };
let observed;
const managed = await defaultHostRunRunner({
  ...base, argv: ['-e', 'console.log(JSON.stringify({pid:process.pid}))'],
  onSpawn: identity => { observed = identity; },
});
assert.equal(managed.exitCode, 0);
assert.equal(JSON.parse(managed.stdout).pid, observed.pid, 'managed observer must retain the actual provider PID');
assert.equal(managed.processIdentity.pid, observed.pid);
assert.equal(managed.replacementSafe, true);

const descriptor = await defaultHostRunRunner({
  ...base,
  argv: ['-e', 'const fs=require("node:fs"); const data=JSON.parse(fs.readFileSync(3,"utf8")); console.log(JSON.stringify({pid:process.pid,data}));'],
  reviewInvocationPayload: identity => JSON.stringify({ pid: identity.pid, nonce: 'preserve-fd-three' }),
});
assert.equal(descriptor.exitCode, 0);
const received = JSON.parse(descriptor.stdout);
assert.equal(received.pid, received.data.pid, 'descriptor must bind the actual provider, not an anchor');
assert.equal(received.data.nonce, 'preserve-fd-three');

const bytes = Buffer.from([0, 255, 254, 128, 65, 10]);
const ordinary = await defaultHostRunRunner({
  ...base, argv: ['-e', `process.stdout.write(Buffer.from(${JSON.stringify([...bytes])}))`],
});
assert.equal(ordinary.exitCode, 0);
assert.equal(ordinary.stdoutDigest, createHash('sha256').update(bytes).digest('hex'), 'anchor must preserve the full raw stdout digest');
assert.equal(ordinary.replacementSafe, true);
console.log('HOST_MANAGED_BOUNDARY_COMPAT_GREEN: actual PID, signed-descriptor transport and raw output preserved');
