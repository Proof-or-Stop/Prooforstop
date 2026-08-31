#!/usr/bin/env node
// Tier-C 401 probe: replicate the EXACT signed POST /v1/jobs/delegated request the live
// runner sends (real ed25519 signing, hex key, Bearer customer-api-key), and print the raw
// server response body — so we see WHY the server returns 401 (the CLI swallows it).
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { signProofOrStopAuthorityEnvelope, derivePublicKeyHexFromPrivateKey } from '../../packages/main/dist/core/proof-or-stop-authority-native.js';

const env = process.env;
const E = (s) => env['PROOF_OR_STOP_AUTHORITY_' + s];
const baseURL = (E('LIVE_URL') || E('URL')).replace(/\/$/, '');
const actorId = E('ACTOR_ID');
const role = E('ACTOR_ROLE') || 'runner';
const projectId = E('PROJECT_ID');
const provider = E('RUNNER_PROVIDER') || 'codex';
const customerApiKey = readFileSync(E('CUSTOMER_API_KEY_PATH').replace(/^\.\//, ''), 'utf8').trim();
const actorPrivateKey = readFileSync(E('ACTOR_KEY_PATH').replace(/^\.\//, ''), 'utf8').trim();
const keyEnc = E('ACTOR_KEY_ENCODING') || 'auto';
const runnerId = E('RUNNER_ID') || `${actorId}-runner`;
const sessionId = `probe-${Date.now()}`;
const storyId = process.argv[2] || 'B-f908';
const mode = 'authority', until = 'DONE';

const promptRef = `proof-or-stop://authority/live-runner/${storyId}/${mode}/${until}`;
const jobRole = provider === 'gemini' ? 'explorer' : 'implementer';
const idempotencyKey = createHash('sha256').update(
  ['proof-or-stop-delegated-job-create-v3', projectId, storyId, provider, mode, until, promptRef, jobRole].join('\0'), 'utf8'
).digest('hex');
const request = { projectId, storyId, provider, role: jobRole, promptRef, idempotencyKey,
  metadata: { runnerId, sessionId, mode, until, promptRef } };
const ts = new Date().toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
const envelope = { actorId, role, nonce: `${runnerId}:delegated-job-create:${Date.now()}:${randomBytes(6).toString('hex')}`, timestamp: ts, request };
const { signed, digest } = signProofOrStopAuthorityEnvelope(envelope, actorPrivateKey, keyEnc);
console.log('client canonical digest (signed over):', digest);
console.log('signed envelope keys:', Object.keys(signed).join(','), '| request keys:', Object.keys(request).join(','));

const hdr = { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${customerApiKey}` };

// STEP 1: register the actor key first (replicate the runner's register_actor_key)
const actorKeyId = E('ACTOR_KEY_ID') || 'default';
const publicKeyHex = derivePublicKeyHexFromPrivateKey(actorPrivateKey, keyEnc);
console.log(`STEP1 POST ${baseURL}/v1/actors/${actorId}/keys  (keyId=${actorKeyId} pubkey=${publicKeyHex.slice(0,16)}…)`);
const reg = await fetch(`${baseURL}/v1/actors/${encodeURIComponent(actorId)}/keys`, {
  method: 'POST', headers: hdr,
  body: JSON.stringify({ role, publicKeyHex, keyId: actorKeyId, status: 'active', runnerId,
    capabilities: { source: 'proof-or-stop-cli', providerExecution: 'tier-c-probe', runnerProvider: provider } }),
});
const regText = await reg.text();
console.log(`  register -> HTTP ${reg.status}: ${regText.slice(0,300)}`);

// STEP 2: delegated job create with the signed envelope
console.log(`STEP2 POST ${baseURL}/v1/jobs/delegated  (actor=${actorId} role=${role} project=${projectId} provider=${provider})`);
const res = await fetch(`${baseURL}/v1/jobs/delegated`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${customerApiKey}` },
  body: JSON.stringify(signed),
});
const text = await res.text();
console.log(`HTTP ${res.status} ${res.statusText}`);
console.log('--- raw server response body ---');
console.log(text.slice(0, 1500));
console.log('--- www-authenticate:', res.headers.get('www-authenticate'));
