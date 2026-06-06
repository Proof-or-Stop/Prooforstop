#!/usr/bin/env node
//
// authority-live-python-smoke (B-2522 CHK-002)
//
// Live integration smoke against a real Python authority server. Requires:
//   LATTICE_AUTHORITY_LIVE_URL        — e.g. https://my-authority.example.com
//   LATTICE_AUTHORITY_LIVE_PUBLIC_KEY — hex or base64 Ed25519 server public key
//
// If either variable is missing, prints a skip line and exits 0 (no mutation).
// If both exist, calls AuthorityClient(url).discoverPolicy() and asserts success.
// If actor key / runner / project env is also present, runs the live runner
// control-plane smoke: register, heartbeat, claim, release without provider execution.
//

import assert from 'node:assert/strict';
import { AuthorityClient } from '../core/authority-client.js';
import { runAuthorityEnforceRunner } from '../handlers/lattice-cli.js';

const liveURL = process.env['LATTICE_AUTHORITY_LIVE_URL'] || process.env['LATTICE_AUTHORITY_URL'];
const livePublicKey = process.env['LATTICE_AUTHORITY_LIVE_PUBLIC_KEY'];

if (!liveURL || !livePublicKey) {
  console.log(
    'authority live Python smoke skipped: set LATTICE_AUTHORITY_LIVE_URL and LATTICE_AUTHORITY_LIVE_PUBLIC_KEY to run',
  );
  process.exit(0);
}

const client = new AuthorityClient(liveURL);
const outcome = await client.discoverPolicy();

if (!outcome.ok) {
  console.error(`authority live Python smoke FAILED: discoverPolicy returned ok=false`);
  if ('status' in outcome) {
    console.error(`  HTTP status: ${outcome.status}`);
  }
  process.exit(1);
}

const policy = outcome.data!;
assert(policy.serverKey, 'policy must expose serverKey');
assert.equal(policy.serverKey!.algorithm, 'ed25519');
assert.equal(policy.serverKey!.encoding, 'hex');
const expectedServerPublicKeyHex = /^[0-9a-fA-F]{64}$/.test(livePublicKey)
  ? livePublicKey.toLowerCase()
  : Buffer.from(livePublicKey, 'base64').toString('hex');
assert.equal(policy.serverKey!.publicKeyHex.toLowerCase(), expectedServerPublicKeyHex);

const hasRunnerEnv = Boolean(
  process.env['LATTICE_AUTHORITY_ACTOR_KEY'] &&
    process.env['LATTICE_AUTHORITY_RUNNER_ID'] &&
    process.env['LATTICE_AUTHORITY_PROJECT_ID'],
);

if (hasRunnerEnv) {
  const runner = await runAuthorityEnforceRunner({
    live: true,
    once: true,
    authorityURL: liveURL,
  }, process.env);
  assert.equal(runner.status, 'pass');
  assert.equal(runner.spawned, false);
  assert.deepEqual(runner.providerEvents, []);
  assert(runner.networkEvents && runner.networkEvents.length >= 3);
  assert(runner.networkEvents.every(event => event.ok), JSON.stringify(runner.networkEvents));
  console.log(
    `authority live Python smoke passed: policy + live runner control-plane url=${liveURL} claimedJobId=${runner.claimedJobId ?? 'none'}`,
  );
  process.exit(0);
}

console.log(
  `authority live Python smoke passed: discoverPolicy ok=true url=${liveURL} (runner env not set; live runner skipped)`,
);
