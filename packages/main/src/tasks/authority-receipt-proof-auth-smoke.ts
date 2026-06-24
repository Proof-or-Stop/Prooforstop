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
// contract:
//   1. WITH a customer API key the proof fetch sends `Authorization: Bearer <key>`
//      AND, given a schema-valid proof body, parses it to outcome.ok===true with the
//      decoded AuthorityGateReceiptProof data (happy-path parse success).
//   2. WITHOUT a customer API key (unset OR empty string) it fails closed and sends
//      no request to the protected endpoint.
//
import assert from 'node:assert/strict';
import { AuthorityClient, type AuthorityFetch } from '../core/authority-client.js';
import {
  AuthorityGateReceiptProofSchema,
  AUTHORITY_GATE_RECEIPT_PROOF_SCHEMA_VERSION,
  AUTHORITY_GATE_DECISION_SUBJECT_KIND,
} from '../core/authority-gate-receipt-verifier.js';

const PROOF_PATH = '/v1/receipts/test-receipt-id/proof';

// A minimal, schema-valid AuthorityGateReceiptProof body. Built field-by-field
// against AuthorityGateReceiptProofSchema so the happy-path assertion exercises a
// genuine parse (not a stub that would fail validation).
const VALID_PROOF = {
  schemaVersion: AUTHORITY_GATE_RECEIPT_PROOF_SCHEMA_VERSION,
  proofKind: AUTHORITY_GATE_DECISION_SUBJECT_KIND,
  receipt: {
    receiptId: 'rcpt-1',
    subjectId: 'decision-1',
    subjectKind: AUTHORITY_GATE_DECISION_SUBJECT_KIND,
    issuedAt: '2026-01-01T00:00:00.000Z',
    authorityActorId: 'authority-actor-1',
    // Passthrough diagnostic field the live smoke reads as receipt.inputDigest.
    inputDigest: 'sha256:deadbeef',
  },
  recordId: 'record-1',
  inputPayload: {
    projectId: 'proj-1',
    storyId: 'B-0001',
    targetPhase: 'DONE',
    repo: { headHash: 'head-1', materialHash: 'material-1' },
    requestedByActorId: 'actor-1',
  },
  decisionPayload: {
    decisionId: 'decision-1',
    storyId: 'B-0001',
    verdict: 'allow',
    targetPhase: 'DONE',
  },
  decisionDigestPayload: {
    decision: {
      decisionId: 'decision-1',
      storyId: 'B-0001',
      verdict: 'allow',
      targetPhase: 'DONE',
    },
    requestedByActorId: 'actor-1',
  },
  requestedByActorId: 'actor-1',
  serverKeyId: 'server-key-1',
  serverPublicKeyHex: 'abcd',
  serverKeyProfile: 'production',
  serverKeyProductionInert: false,
};
const VALID_PROOF_BODY = JSON.stringify(VALID_PROOF);

// Body intentionally NOT a valid proof — used only for the header-auth assertion,
// where we care about the request, not proof parsing.
const STUB_BODY = JSON.stringify({ stub: 'not-a-valid-proof' });

async function main(): Promise<void> {
  // Sanity-check the fixture against the real schema before using it as the
  // happy-path body, so a fixture drift fails loudly here rather than masking
  // a regression in fetchGateReceiptProof's parse.
  assert.equal(
    AuthorityGateReceiptProofSchema.safeParse(VALID_PROOF).success,
    true,
    'test fixture must itself be a schema-valid AuthorityGateReceiptProof',
  );

  // 1) WITH a customer API key -> Authorization: Bearer <key> reaches the transport.
  let capturedHeaders: Record<string, string> | undefined;
  const capturingFetch: AuthorityFetch = async (_url, init) => {
    capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
    return { ok: true, status: 200, text: async () => STUB_BODY };
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

  // 1b) HAPPY PATH PARSE: a schema-valid body parses to outcome.ok===true and the
  // decoded AuthorityGateReceiptProof data (CHK-001:happy:1).
  const happyFetch: AuthorityFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => VALID_PROOF_BODY,
  });
  const happyClient = new AuthorityClient('https://authority.test', happyFetch, 5_000, {
    customerApiKey: 'cust-key-xyz',
  });
  const happyOutcome = await happyClient.fetchGateReceiptProof(PROOF_PATH);
  assert.equal(
    happyOutcome.ok,
    true,
    'a schema-valid proof body must parse to outcome.ok===true',
  );
  assert.ok(happyOutcome.ok && happyOutcome.data, 'happy outcome must carry parsed data');
  assert.equal(
    happyOutcome.data?.receipt.inputDigest,
    'sha256:deadbeef',
    'parsed proof must expose receipt.inputDigest from the body',
  );
  assert.equal(
    happyOutcome.data?.inputPayload.storyId,
    'B-0001',
    'parsed proof must expose the inputPayload from the body',
  );

  // 2) WITHOUT a customer API key (unset) -> fail closed; no request sent.
  let calledUnset = false;
  const guardFetchUnset: AuthorityFetch = async () => {
    calledUnset = true;
    return { ok: true, status: 200, text: async () => STUB_BODY };
  };
  const unauthed = new AuthorityClient('https://authority.test', guardFetchUnset, 5_000);
  const outcome = await unauthed.fetchGateReceiptProof(PROOF_PATH);
  assert.equal(outcome.ok, false, 'proof fetch without a customer key must fail closed');
  assert.equal(
    calledUnset,
    false,
    'no request may be sent to the protected proof endpoint without a customer key',
  );

  // 3) EMPTY-STRING customer key -> must behave identically to unset (fail closed,
  // no request). The client trims the key, so '' is falsy (CHK F-005).
  let calledEmpty = false;
  const guardFetchEmpty: AuthorityFetch = async () => {
    calledEmpty = true;
    return { ok: true, status: 200, text: async () => STUB_BODY };
  };
  const emptyKeyClient = new AuthorityClient('https://authority.test', guardFetchEmpty, 5_000, {
    customerApiKey: '',
  });
  const emptyOutcome = await emptyKeyClient.fetchGateReceiptProof(PROOF_PATH);
  assert.equal(
    emptyOutcome.ok,
    false,
    'proof fetch with an empty-string customer key must fail closed',
  );
  assert.equal(
    calledEmpty,
    false,
    'no request may be sent to the protected proof endpoint with an empty-string key',
  );

  console.log(
    'PASS authority receipt proof auth smoke: Bearer header sent, happy-path parses ok===true, and fail-closed for both unset and empty-string keys',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
