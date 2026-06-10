#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AuthorityClient, type AuthorityFetch } from '../core/authority-client.js';
import {
  AUTHORITY_GATE_DECISION_SCHEMA_VERSION,
  AUTHORITY_GATE_RECEIPT_PROOF_SCHEMA_VERSION,
  gateDecisionDigest,
  gateDecisionInputDigest,
  verifyAuthorityGateReceiptProof,
  type AuthorityGateDecision,
  type AuthorityGateDecisionInput,
  type AuthorityGateReceiptProof,
} from '../core/authority-gate-receipt-verifier.js';
import type { AuthorityReceipt } from '../core/authority-runner-contracts.js';
import {
  generateEd25519KeyPair,
  signCanonical,
} from '../core/authority-signing.js';

const PASS_LINE = '✓ authority receipt proof smoke passed';
const ISSUED_AT = '2026-06-10T00:00:00.000Z';

function hexFromBase64(value: string): string {
  return Buffer.from(value, 'base64').toString('hex');
}

function publicKeyDigest(publicKeyBase64: string): string {
  return `sha256:${createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex')}`;
}

function signedReceipt(
  receipt: Omit<AuthorityReceipt, 'signature'>,
  privateKey: string,
): AuthorityReceipt {
  return {
    ...receipt,
    signature: signCanonical(receipt, privateKey),
  };
}

function buildProof(
  overrides: Partial<{
    authorityTrust: 'production' | 'local-test' | 'contract-test';
    authorityKeyId: string;
    authorityActorId: string;
    useHexWire: boolean;
    input: AuthorityGateDecisionInput;
    decision: AuthorityGateDecision;
    receipt: AuthorityReceipt;
  }> = {},
): {
  proof: AuthorityGateReceiptProof;
  input: AuthorityGateDecisionInput;
  decision: AuthorityGateDecision;
  receipt: AuthorityReceipt;
  keypair: ReturnType<typeof generateEd25519KeyPair>;
} {
  const keypair = generateEd25519KeyPair();
  const input = overrides.input ?? {
    storyId: 'B-proof',
    phase: 'TEST',
    headHash: 'h'.repeat(40),
    materialHash: 'm'.repeat(64),
    baselineLayer: 'engineering',
  };
  const inputDigest = gateDecisionInputDigest(input);
  const decision = overrides.decision ?? {
    schemaVersion: AUTHORITY_GATE_DECISION_SCHEMA_VERSION,
    decisionId: 'GD-proof-1',
    storyId: input.storyId,
    phase: input.phase,
    headHash: input.headHash,
    materialHash: input.materialHash,
    inputDigest: `sha256:${inputDigest}`,
    result: 'PASS',
    generatedAt: ISSUED_AT,
  };
  const decisionDigest = gateDecisionDigest(decision);
  const receipt = overrides.receipt ?? signedReceipt({
    receiptId: 'AR-proof-1',
    subjectKind: 'gate_decision',
    subjectId: decision.decisionId,
    subjectDigest: `sha256:${decisionDigest}`,
    issuedAt: ISSUED_AT,
    authorityActorId: overrides.authorityActorId ?? 'authority-prod',
  }, keypair.privateKey);
  const proof = {
    schemaVersion: AUTHORITY_GATE_RECEIPT_PROOF_SCHEMA_VERSION,
    proofKind: 'gate_decision',
    authorityKey: {
      keyId: overrides.authorityKeyId ?? 'prod-key-1',
      publicKey: overrides.useHexWire ? hexFromBase64(keypair.publicKey) : keypair.publicKey,
      trust: overrides.authorityTrust ?? 'production',
    },
    input,
    decision,
    receipt: overrides.useHexWire
      ? { ...receipt, signature: hexFromBase64(receipt.signature ?? '') }
      : receipt,
  } as AuthorityGateReceiptProof;
  return { proof, input, decision, receipt, keypair };
}

// Happy path: production-trusted proof verifies with hex key/signature wire form.
{
  const { proof, input, keypair } = buildProof({ useHexWire: true });
  const result = verifyAuthorityGateReceiptProof(proof, {
    expected: {
      storyId: input.storyId,
      phase: input.phase,
      headHash: input.headHash,
      materialHash: input.materialHash,
    },
    trust: {
      productionAuthorityKeyDigests: [publicKeyDigest(keypair.publicKey)],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.receiptVerified, true);
  assert.equal(result.productionReady, true);
  assert.equal(result.classification, 'production-gate-decision');
  assert.equal(result.receiptId, 'AR-proof-1');
  assert.ok(result.inputDigest);
  assert.ok(result.decisionDigest);
}

// Edge path: a local/default/test key may verify cryptographically, but cannot
// become production-gate-decision.
{
  const { proof, input } = buildProof({
    authorityTrust: 'local-test',
    authorityKeyId: 'default-local-test-key',
    authorityActorId: 'fake-test-server',
  });
  const result = verifyAuthorityGateReceiptProof(proof, { expected: { storyId: input.storyId } });
  assert.equal(result.ok, true);
  assert.equal(result.receiptVerified, true);
  assert.equal(result.productionReady, false);
  assert.equal(result.classification, 'server-receipt-local-test');
}

// Adversarial: a self-signed production-looking proof is not trusted unless the
// public key digest is pinned by the caller.
{
  const { proof } = buildProof();
  const result = verifyAuthorityGateReceiptProof(proof);
  assert.equal(result.ok, false);
  assert.equal(result.failureReason, 'untrusted_authority_key');
  assert.ok(result.authorityPublicKeyDigest?.startsWith('sha256:'));
}

// Adversarial: corrupt signature fails with a machine-readable reason.
{
  const { proof } = buildProof();
  const result = verifyAuthorityGateReceiptProof({
    ...proof,
    receipt: { ...proof.receipt, signature: '00'.repeat(64) },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureReason, 'receipt_signature_invalid');
}

// Adversarial: tampering input after the decision was generated is caught by
// recomputing inputDigest.
{
  const { proof } = buildProof();
  const result = verifyAuthorityGateReceiptProof({
    ...proof,
    input: { ...proof.input, baselineLayer: 'tampered' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureReason, 'input_digest_mismatch');
}

// Adversarial: tampering the gate decision after receipt issuance is caught by
// recomputing the receipt subjectDigest.
{
  const { proof } = buildProof();
  const result = verifyAuthorityGateReceiptProof({
    ...proof,
    decision: { ...proof.decision, result: 'BLOCKED' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureReason, 'decision_digest_mismatch');
}

// Adversarial: expected story / phase / head / material context mismatches fail
// before any caller can write a production ref.
{
  const { proof, input } = buildProof();
  assert.equal(
    verifyAuthorityGateReceiptProof(proof, { expected: { storyId: 'B-other' } }).failureReason,
    'story_mismatch',
  );
  assert.equal(
    verifyAuthorityGateReceiptProof(proof, { expected: { phase: 'DONE' } }).failureReason,
    'phase_mismatch',
  );
  assert.equal(
    verifyAuthorityGateReceiptProof(proof, { expected: { headHash: 'other-head' } }).failureReason,
    'head_mismatch',
  );
  assert.equal(
    verifyAuthorityGateReceiptProof(proof, { expected: { materialHash: 'other-material' } }).failureReason,
    'material_mismatch',
  );
  assert.equal(
    verifyAuthorityGateReceiptProof(proof, {
      expected: {
        storyId: input.storyId,
        phase: input.phase,
        headHash: input.headHash,
        materialHash: input.materialHash,
      },
      trust: {
        productionAuthorityKeyDigests: [publicKeyDigest(Buffer.from(proof.authorityKey.publicKey, 'base64').toString('base64'))],
      },
    }).ok,
    true,
  );
}

// Client fetch: schema parse is allowed, but trust still depends on the verifier.
{
  const { proof } = buildProof();
  const fetchImpl: AuthorityFetch = async (input, init) => {
    assert.equal(input, 'https://authority.example/v1/receipts/AR-proof-1/proof');
    assert.equal(init.method, 'GET');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(proof),
    };
  };
  const client = new AuthorityClient('https://authority.example', fetchImpl);
  const outcome = await client.fetchGateReceiptProof('/v1/receipts/AR-proof-1/proof');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.kind, 'success');
  assert.equal(outcome.data?.receipt.receiptId, 'AR-proof-1');
  await assert.rejects(
    () => client.fetchGateReceiptProof('https://evil.example/proof'),
    /server-relative path/,
  );
}

console.log(PASS_LINE);
