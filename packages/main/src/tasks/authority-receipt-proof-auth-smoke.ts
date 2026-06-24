#!/usr/bin/env node
//
// Regression smoke for the gate-receipt proof fetch authentication.
//
// The gate-receipt proof endpoint (/v1/receipts/{id}/proof) is a PROTECTED
// Authority read. Two real bugs (found via the live receipt-ref gate smoke against
// staging) made `authority_receipt_verify --proofPath` fetch it unauthenticated and
// 401:
//   - AuthorityClient.fetchGateReceiptProof did not request `authenticated: true`,
//     so get() never attached the Authorization header.
//   - authority-enforce.ts loadProof constructed the client without auth.
//
// This deterministic test stubs the transport (no live server) and pins the
// contract: WITH a customer API key the proof fetch sends `Authorization: Bearer
// <key>`; WITHOUT one it fails closed and sends no request to the protected endpoint.
//
import assert from 'node:assert/strict';
import { AuthorityClient, type AuthorityFetch } from '../core/authority-client.js';

const PROOF_PATH = '/v1/receipts/test-receipt-id/proof';
// Body is intentionally not a valid proof — these assertions are about the request
// auth, not proof parsing (fetchGateReceiptProof returns an outcome, never throws).
const PROOF_BODY = JSON.stringify({ stub: 'not-a-valid-proof' });

async function main(): Promise<void> {
  // 1) WITH a customer API key -> Authorization: Bearer <key> reaches the transport.
  let capturedHeaders: Record<string, string> | undefined;
  const capturingFetch: AuthorityFetch = async (_url, init) => {
    capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
    return { ok: true, status: 200, text: async () => PROOF_BODY };
  };
  const authed = new AuthorityClient('https://authority.test', capturingFetch, 5_000, {
    customerApiKey: 'cust-key-xyz',
  });
  await authed.fetchGateReceiptProof(PROOF_PATH);
  assert.ok(capturedHeaders, 'authenticated proof fetch must reach the transport');
  assert.equal(
    capturedHeaders?.Authorization,
    'Bearer cust-key-xyz',
    'fetchGateReceiptProof must send the customer API key as Bearer auth',
  );

  // 2) WITHOUT a customer API key -> fail closed; no request to the protected endpoint.
  let called = false;
  const guardFetch: AuthorityFetch = async () => {
    called = true;
    return { ok: true, status: 200, text: async () => PROOF_BODY };
  };
  const unauthed = new AuthorityClient('https://authority.test', guardFetch, 5_000);
  const outcome = await unauthed.fetchGateReceiptProof(PROOF_PATH);
  assert.equal(outcome.ok, false, 'proof fetch without a customer key must fail closed');
  assert.equal(
    called,
    false,
    'no request may be sent to the protected proof endpoint without a customer key',
  );

  console.log(
    'PASS authority receipt proof auth smoke: proof fetch is authenticated (Bearer) and fail-closed without a key',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
