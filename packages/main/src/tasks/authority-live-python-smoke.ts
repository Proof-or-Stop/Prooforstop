#!/usr/bin/env node
//
// authority-live-python-smoke (B-2522 CHK-002)
//
// Live integration smoke against a real Python authority server. Requires:
//   KOALA_AUTHORITY_LIVE_URL        — e.g. https://my-authority.example.com
//   KOALA_AUTHORITY_LIVE_PUBLIC_KEY — base64-encoded Ed25519 public key
//
// If either variable is missing, prints a skip line and exits 0 (no mutation).
// If both exist, calls AuthorityClient(url).discoverPolicy() and asserts success.
//

import { AuthorityClient } from '../core/authority-client.js';

const liveURL = process.env['KOALA_AUTHORITY_LIVE_URL'];
const livePublicKey = process.env['KOALA_AUTHORITY_LIVE_PUBLIC_KEY'];

if (!liveURL || !livePublicKey) {
  console.log(
    'authority live Python smoke skipped: set KOALA_AUTHORITY_LIVE_URL and KOALA_AUTHORITY_LIVE_PUBLIC_KEY to run',
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

console.log(
  `authority live Python smoke passed: discoverPolicy ok=true url=${liveURL}`,
);
